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

import { requireCronOrMember } from "../_shared/cron-auth.ts";
import { fetchWithTimeout } from "../_shared/http.ts";
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

// ── What counts as a platform fault ─────────────────────────────────────────
// A check can be worth showing the customer without being worth waking an
// operator. "Nothing captured in 35 days" is a fact about that tenant's sales
// activity, not a fault in this system — but it was rolled up into the
// platform-wide status, so `overall` sat at `warn` permanently, which made
// stale_jobs() return system-health on every call, which made the operator
// alarm permanently on.
//
// A permanently-on alarm is not an alarm. That is precisely how the eight-day
// cron outage went unnoticed: the signal existed and had stopped meaning
// anything. So tenant quietness stays visible on that tenant's own card and is
// left out of the rollup that drives alerting.
//
// `advisory` is set on the individual verdict, not on the check name. Keying it
// off the name would have exempted everything the same function can return —
// including "could not read records", which is a real fault wearing the same
// label.
interface Check { key: string; label: string; level: Level; detail: string; advisory?: boolean }

const FALLBACK_PREFIX = "Sorry, I'm having trouble";

/** Live probe of the AI provider using the org's own key and model chain. */
async function checkAi(orgId: string): Promise<Check> {
  // .single() errors with PGRST116 when there is no row, which is a legitimate
  // state here (an org that has never opened Settings). Any other error means
  // we could not read the config at all, and falling through would probe the
  // DEFAULT model and report the org healthy on a key it never actually uses.
  const { data: cfg, error: cfgError } = await supabase
    .from("agent_config").select("groq_api_key, model, enabled").eq("org_id", orgId).maybeSingle();
  if (cfgError) {
    return { key: "ai", label: "AI assistant", level: "warn", detail: `Could not read AI settings: ${cfgError.message}` };
  }

  if (cfg?.enabled === false) {
    return { key: "ai", label: "AI assistant", level: "ok", detail: "Disabled for this org" };
  }

  const key = (cfg?.groq_api_key || Deno.env.get("GROQ_API_KEY") || "").trim();
  if (!key) {
    return { key: "ai", label: "AI assistant", level: "fail", detail: "No Groq API key configured" };
  }

  const model = cfg?.model || "openai/gpt-oss-120b";
  try {
    const r = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
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
  const { data, error } = await supabase
    .from("chat_messages")
    .select("content")
    .eq("org_id", orgId)
    .eq("role", "assistant")
    .gte("created_at", since)
    .limit(200);

  // Without this, a refused read returns zero rows and the branch below reports
  // "No chats in the last 24h" — an all-clear built out of an error.
  if (error) {
    return { key: "replies", label: "Recent replies", level: "warn", detail: `Could not read recent replies: ${error.message}` };
  }

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
  const { data: keys, error: keysError } = await supabase
    .from("webhook_keys").select("id").eq("org_id", orgId).eq("active", true).limit(1);
  if (keysError) {
    return { key: "intake", label: "Lead intake", level: "warn", detail: `Could not read webhook keys: ${keysError.message}` };
  }
  // Advisory: a tenant that has not issued a webhook key yet is un-onboarded,
  // not broken.
  if (!keys?.length) {
    return { key: "intake", label: "Lead intake", level: "warn", advisory: true, detail: "No active webhook key" };
  }

  const { data: recent, error: recentError } = await supabase
    .from("leads").select("created_at").eq("org_id", orgId)
    .is("deleted_at", null)   // a deleted record is not evidence intake works
    .order("created_at", { ascending: false }).limit(1);
  if (recentError) {
    return { key: "intake", label: "Lead intake", level: "warn", detail: `Could not read records: ${recentError.message}` };
  }

  // Advisory: a new or dormant tenant is not a platform fault.
  if (!recent?.length) {
    return { key: "intake", label: "Lead intake", level: "warn", advisory: true, detail: "No records captured yet" };
  }
  const days = Math.floor((Date.now() - new Date(recent[0].created_at).getTime()) / 86400_000);
  if (days >= 14) {
    return { key: "intake", label: "Lead intake", level: "warn", advisory: true, detail: `Nothing captured in ${days} days` };
  }
  return { key: "intake", label: "Lead intake", level: "ok", detail: `Last record ${days === 0 ? "today" : `${days}d ago`}` };
}

/** Are automations running and succeeding? */
async function checkAutomations(orgId: string): Promise<Check> {
  const { data: autos, error: autosError } = await supabase
    .from("automations").select("id").eq("org_id", orgId).eq("enabled", true);
  if (autosError) {
    return { key: "automations", label: "Automations", level: "warn", detail: `Could not read automations: ${autosError.message}` };
  }
  if (!autos?.length) {
    return { key: "automations", label: "Automations", level: "ok", detail: "None enabled" };
  }

  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data: runs, error: runsError } = await supabase
    .from("automation_runs").select("ok").eq("org_id", orgId).gte("created_at", since).limit(500);
  // A failed read here counted zero failures and reported "no failures".
  if (runsError) {
    return { key: "automations", label: "Automations", level: "warn", detail: `Could not read automation runs: ${runsError.message}` };
  }

  const failed = (runs ?? []).filter((r: { ok: boolean }) => !r.ok).length;
  if (failed > 0) {
    return { key: "automations", label: "Automations", level: "warn", detail: `${failed} failed run(s) this week` };
  }
  return { key: "automations", label: "Automations", level: "ok", detail: `${autos.length} active, no failures` };
}

/** Credential exposure — the dormant agent_config issue becomes live here. */
async function checkSecurity(orgId: string): Promise<Check> {
  // Both reads below previously went unchecked, and this is the check where
  // that matters most: every failure mode landed on "ok". A refused profiles
  // read reported "No counsellor accounts yet"; a refused agent_config read
  // reported "No keys stored in the database". The one check whose whole job is
  // to notice stored credentials was incapable of returning anything but an
  // all-clear when it could not see them.
  const { data: counsellors, error: profilesError } = await supabase
    .from("profiles").select("id").eq("org_id", orgId).eq("status", "active").eq("role", "counsellor");
  if (profilesError) {
    return { key: "security", label: "Credential exposure", level: "warn", detail: `Could not read team accounts: ${profilesError.message}` };
  }

  if (!counsellors?.length) {
    return { key: "security", label: "Credential exposure", level: "ok", detail: "No counsellor accounts yet" };
  }

  const { data: cfg, error: cfgError } = await supabase
    .from("agent_config")
    .select("groq_api_key, resend_api_key, whatsapp_token, telegram_bot_token")
    .eq("org_id", orgId).maybeSingle();
  if (cfgError) {
    return { key: "security", label: "Credential exposure", level: "warn", detail: `Could not read stored credentials: ${cfgError.message}` };
  }

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


// The cron-death detector only works if something actually reports in.
// record_heartbeat() shipped with zero callers, so job_heartbeats stayed at
// "never reported" and stale_jobs() flagged every job stale forever — the
// monitoring was itself the thing that was broken.
async function heartbeat(status: string, detail?: string) {
  try {
    // postgrest-js RESOLVES with { error } — it does not throw. The catch
    // below can only ever see a transport failure, so a refused RPC was being
    // recorded as a successful heartbeat write. Destructure it.
    const { error } = await supabase.rpc("record_heartbeat", {
      p_job: "system-health", p_status: status, p_detail: detail ?? null,
    });
    if (error) console.warn("heartbeat not recorded:", error.message);
  } catch (e) {
    // Never let reporting health break the work whose health is reported.
    console.warn("heartbeat failed:", (e as Error).message);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // Scheduled endpoint. Deployed --no-verify-jwt because pg_cron carries no
  // Supabase JWT, so a shared secret is the boundary. See _shared/cron-auth.ts.
  // requireCronOrMember, not requireCronSecret. The HealthCard on the dashboard
  // fetches this from the browser, which carries a user JWT and cannot carry a
  // server-side secret — so the card that exists specifically so a three-day
  // silent outage never repeats was rendering nothing, under all conditions,
  // and "nothing" looks exactly like "healthy".
  //
  // run-automations and summarize-chats were converted when this same
  // regression was found there; this one was missed.
  const cronAuth = await requireCronOrMember(req, CORS, supabase);
  if (!cronAuth.ok) return cronAuth.response!;

  const url = new URL(req.url);
  const slug = url.searchParams.get("org");
  let alert = false;
  if (req.method === "POST") {
    try { alert = (await req.json())?.alert === true; } catch { /* cron sends nothing */ }
  }

  let q = supabase.from("organizations").select("id, slug, name").eq("active", true);
  if (slug) q = q.eq("slug", slug);
  const { data: orgs, error: orgsError } = await q;

  // An unchecked read here is the worst possible silent failure in this file:
  // zero orgs means zero checks means `overall = ok`. The monitor would report
  // perfect health precisely because it could not see anything.
  if (orgsError) {
    await heartbeat("warn", `could not list organisations: ${orgsError.message}`);
    return json({ ok: false, error: orgsError.message }, 500);
  }

  const results: unknown[] = [];
  // Collected for the heartbeat, which is the only one of these outputs an
  // operator ever actually reads.
  const alarms: string[] = [];

  for (const org of orgs ?? []) {
    const checks = await Promise.all([
      checkAi(org.id),
      checkRecentReplies(org.id),
      checkIntake(org.id),
      checkAutomations(org.id),
      checkSecurity(org.id),
    ]);

    // The customer's own card still shows everything, including advisory
    // warnings — "nothing captured in 35 days" is useful to them.
    const worst: Level = checks.some((c) => c.level === "fail")
      ? "fail"
      : checks.some((c) => c.level === "warn") ? "warn" : "ok";

    // Alerting uses the narrower set. An advisory check can still escalate on
    // `fail`; it just cannot raise a platform alarm by being merely quiet.
    const alarming = checks.filter((c) => c.level === "fail" || (c.level === "warn" && !c.advisory));
    const alarmLevel: Level = alarming.some((c) => c.level === "fail")
      ? "fail"
      : alarming.length ? "warn" : "ok";

    for (const c of alarming) alarms.push(`${org.slug}/${c.label}: ${c.detail}`);

    results.push({
      org: org.slug,
      name: org.name,
      status: worst,
      alarm_status: alarmLevel,
      checks,
    });

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

  const alarmOverall: Level = results.some((r) => (r as { alarm_status: Level }).alarm_status === "fail")
    ? "fail"
    : results.some((r) => (r as { alarm_status: Level }).alarm_status === "warn") ? "warn" : "ok";

  // The detail was the string `overall warn`, which names nothing: an operator
  // reading it could not tell "a demo tenant is quiet" from "the AI provider is
  // down for every customer". Name the orgs and the checks, and say how many
  // orgs were examined — because "0 orgs, all healthy" and "5 orgs, all
  // healthy" are the same word otherwise.
  const orgCount = (orgs ?? []).length;
  const detail = alarmOverall === "ok"
    ? `${orgCount} org(s) checked, no faults` +
      (overall === "ok" ? "" : ` (${results.filter((r) => (r as { status: Level }).status !== "ok").length} advisory)`)
    : `${orgCount} org(s) checked — ` + alarms.slice(0, 6).join("; ") +
      (alarms.length > 6 ? ` (+${alarms.length - 6} more)` : "");

  await heartbeat(alarmOverall === "ok" ? "ok" : "warn", detail.slice(0, 500));
  return json({
    ok: true,
    status: overall,
    alarm_status: alarmOverall,
    checked_at: new Date().toISOString(),
    orgs: results,
  });
});
