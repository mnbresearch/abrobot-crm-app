// AbroBot CRM — self-monitoring.
// Deploy:  supabase functions deploy system-health --no-verify-jwt
// Schedule: hourly
//
// GET  /system-health?org=abrobot   -> status JSON for the dashboard card
// POST { alert: true }              -> run all orgs, Telegram-alert on failure
//
// ── Why this exists ─────────────────────────────────────────────────────────
// On 2026-08-16 Groq shut down llama-3.3-70b-versatile. Every org had
// model = null, so all of them fell through to that one constant and the chat
// agent broke everywhere at once. It stayed broken for three days. Nothing
// noticed, because the failure path was a polite apology written to the
// visitor and a row in chat_messages nobody read.
//
// The apology *is* the outage. This function exists so the next one is caught
// in an hour instead of three days.
//
// Design: probe the real dependency, not a proxy for it. Reading a config row
// proves nothing about whether the model still exists.

import { createClient } from "npm:@supabase/supabase-js@2";
import { notifyNewLead } from "../_shared/notify.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

type Level = "ok" | "warn" | "fail";
interface Check { key: string; label: string; level: Level; detail: string }

const FALLBACK_PREFIX = "Sorry, I'm having trouble";

/** Live probe of the AI provider using the org's own key and model chain. */
async function checkAi(orgId: string): Promise<Check> {
  const { data: cfg } = await supabase
    .from("agent_config").select("groq_api_key, model, enabled").eq("org_id", orgId).single();

  if (cfg?.enabled === false) {
    return { key: "ai", label: "AI assistant", level: "ok", detail: "Disabled for this org" };
  }

  const key = (cfg?.groq_api_key || Deno.env.get("GROQ_API_KEY") || "").trim();
  if (!key) {
    return { key: "ai", label: "AI assistant", level: "fail", detail: "No Groq API key configured" };
  }

  const model = cfg?.model || "openai/gpt-oss-120b";
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      // Smallest possible real call — this must prove the model answers, not
      // merely that the endpoint is reachable.
      body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "ping" }] }),
    });

    if (r.ok) {
      const d = await r.json();
      if (d?.choices?.[0]?.message?.content !== undefined) {
        return { key: "ai", label: "AI assistant", level: "ok", detail: `${model} responding` };
      }
      return { key: "ai", label: "AI assistant", level: "warn", detail: `${model} returned no content` };
    }

    const body = (await r.text()).slice(0, 200);
    // The exact shape of the August outage: model gone.
    const gone = r.status === 404 || /decommissioned|not found|does not exist/i.test(body);
    return {
      key: "ai",
      label: "AI assistant",
      level: "fail",
      detail: gone
        ? `Model "${model}" is no longer available (${r.status}). Change it in Settings → AI Agent.`
        : `Groq ${r.status}: ${body}`,
    };
  } catch (e) {
    return { key: "ai", label: "AI assistant", level: "fail", detail: (e as Error).message };
  }
}

/** Have recent visitors been served the fallback apology? */
async function checkRecentReplies(orgId: string): Promise<Check> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data } = await supabase
    .from("chat_messages")
    .select("content")
    .eq("org_id", orgId)
    .eq("role", "assistant")
    .gte("created_at", since)
    .limit(200);

  const total = data?.length ?? 0;
  if (total === 0) {
    return { key: "replies", label: "Recent replies", level: "ok", detail: "No chats in the last 24h" };
  }
  const bad = (data ?? []).filter((m: { content: string }) => m.content?.startsWith(FALLBACK_PREFIX)).length;
  const pct = Math.round((bad / total) * 100);

  if (bad === 0) return { key: "replies", label: "Recent replies", level: "ok", detail: `${total} replies, none failed` };
  if (pct >= 50) return { key: "replies", label: "Recent replies", level: "fail", detail: `${bad} of ${total} replies (${pct}%) were the error message` };
  return { key: "replies", label: "Recent replies", level: "warn", detail: `${bad} of ${total} replies (${pct}%) failed` };
}

/** Is lead intake alive? Silence on a normally-busy webhook is a symptom. */
async function checkIntake(orgId: string): Promise<Check> {
  const { data: keys } = await supabase
    .from("webhook_keys").select("id").eq("org_id", orgId).eq("active", true).limit(1);
  if (!keys?.length) {
    return { key: "intake", label: "Lead intake", level: "warn", detail: "No active webhook key" };
  }

  const { data: recent } = await supabase
    .from("leads").select("created_at").eq("org_id", orgId)
    .order("created_at", { ascending: false }).limit(1);

  if (!recent?.length) {
    return { key: "intake", label: "Lead intake", level: "warn", detail: "No records captured yet" };
  }
  const days = Math.floor((Date.now() - new Date(recent[0].created_at).getTime()) / 86400_000);
  if (days >= 14) {
    return { key: "intake", label: "Lead intake", level: "warn", detail: `Nothing captured in ${days} days` };
  }
  return { key: "intake", label: "Lead intake", level: "ok", detail: `Last record ${days === 0 ? "today" : `${days}d ago`}` };
}

/** Are automations running and succeeding? */
async function checkAutomations(orgId: string): Promise<Check> {
  const { data: autos } = await supabase
    .from("automations").select("id").eq("org_id", orgId).eq("enabled", true);
  if (!autos?.length) {
    return { key: "automations", label: "Automations", level: "ok", detail: "None enabled" };
  }

  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data: runs } = await supabase
    .from("automation_runs").select("ok").eq("org_id", orgId).gte("created_at", since).limit(500);

  const failed = (runs ?? []).filter((r: { ok: boolean }) => !r.ok).length;
  if (failed > 0) {
    return { key: "automations", label: "Automations", level: "warn", detail: `${failed} failed run(s) this week` };
  }
  return { key: "automations", label: "Automations", level: "ok", detail: `${autos.length} active, no failures` };
}

/** Credential exposure — the dormant agent_config issue becomes live here. */
async function checkSecurity(orgId: string): Promise<Check> {
  const { data: counsellors } = await supabase
    .from("profiles").select("id").eq("org_id", orgId).eq("status", "active").eq("role", "counsellor");

  if (!counsellors?.length) {
    return { key: "security", label: "Credential exposure", level: "ok", detail: "No counsellor accounts yet" };
  }

  const { data: cfg } = await supabase
    .from("agent_config")
    .select("groq_api_key, resend_api_key, whatsapp_token, telegram_bot_token")
    .eq("org_id", orgId).single();

  const held = ["groq_api_key", "resend_api_key", "whatsapp_token", "telegram_bot_token"]
    .filter((k) => cfg?.[k as keyof typeof cfg]);

  if (held.length === 0) {
    return { key: "security", label: "Credential exposure", level: "ok", detail: "No keys stored in the database" };
  }
  return {
    key: "security",
    label: "Credential exposure",
    level: "fail",
    detail: `${counsellors.length} counsellor(s) can read ${held.length} stored credential(s) from the browser. Move them to function secrets.`,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const slug = url.searchParams.get("org");
  let alert = false;
  if (req.method === "POST") {
    try { alert = (await req.json())?.alert === true; } catch { /* cron sends nothing */ }
  }

  let q = supabase.from("organizations").select("id, slug, name").eq("active", true);
  if (slug) q = q.eq("slug", slug);
  const { data: orgs } = await q;

  const results: unknown[] = [];

  for (const org of orgs ?? []) {
    const checks = await Promise.all([
      checkAi(org.id),
      checkRecentReplies(org.id),
      checkIntake(org.id),
      checkAutomations(org.id),
      checkSecurity(org.id),
    ]);

    const worst: Level = checks.some((c) => c.level === "fail")
      ? "fail"
      : checks.some((c) => c.level === "warn") ? "warn" : "ok";

    results.push({ org: org.slug, name: org.name, status: worst, checks });

    if (alert && worst === "fail") {
      const failing = checks.filter((c) => c.level === "fail");
      await notifyNewLead(supabase, org.id, {
        id: "health",
        name: `⚠️ ${org.name} — system check failed`,
        message: failing.map((c) => `${c.label}: ${c.detail}`).join("\n"),
      });
    }
  }

  const overall = results.some((r) => (r as { status: Level }).status === "fail")
    ? "fail"
    : results.some((r) => (r as { status: Level }).status === "warn") ? "warn" : "ok";

  return json({ ok: true, status: overall, checked_at: new Date().toISOString(), orgs: results });
});
