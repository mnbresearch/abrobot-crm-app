// AbroBot CRM — lead intake webhook + public capture form API
import { createClient } from "npm:@supabase/supabase-js@2";
import { notifyNewLead } from "../_shared/notify.ts";
import { scoreLead } from "../_shared/score.ts";
import { getWhatsAppConfig, sendWhatsAppText } from "../_shared/whatsapp.ts";
import { fireEventAutomations } from "../_shared/run-actions.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+?\d[\d\s\-()]{8,}\d)/;

function normPhone(p?: string | null): string | null {
  if (!p) return null;
  const digits = p.replace(/[^\d+]/g, "");
  if (digits.length < 8) return null;
  if (/^\d{10}$/.test(digits)) return "+91" + digits;
  return digits.startsWith("+") ? digits : "+" + digits;
}

// deno-lint-ignore no-explicit-any
function extractLead(body: any, source: string) {
  let name = "", email: string | null = null, phone: string | null = null, message = "";

  const waMsg = body?.entry?.[0]?.changes?.[0]?.value;
  if (waMsg?.messages?.[0]) {
    const m = waMsg.messages[0];
    phone = normPhone(m.from);
    name = waMsg.contacts?.[0]?.profile?.name ?? "";
    message = m.text?.body ?? m.button?.text ?? "";
  } else if (body?.From?.toString().startsWith("whatsapp:")) {
    phone = normPhone(body.From.replace("whatsapp:", ""));
    name = body.ProfileName ?? "";
    message = body.Body ?? "";
  } else {
    name = body.name ?? body.Name ?? body.full_name ?? body.customer_name ?? "";
    email = body.email ?? body.Email ?? null;
    phone = normPhone(body.phone ?? body.Phone ?? body.phone_number ?? null);
    message = body.message ?? body.query ?? body.conversation_summary ?? body.body ?? "";
    if (!email && body.from && EMAIL_RE.test(body.from)) email = body.from.match(EMAIL_RE)![0];
    if (body.subject) message = body.subject + "\n" + message;
  }

  if (!email && EMAIL_RE.test(message)) email = message.match(EMAIL_RE)![0];
  if (!phone && PHONE_RE.test(message)) phone = normPhone(message.match(PHONE_RE)![0]);
  if (!name) name = email?.split("@")[0] ?? phone ?? "Unknown lead";

  return {
    name: String(name).slice(0, 200),
    email: email?.toLowerCase() ?? null,
    phone,
    message: String(message).slice(0, 4000),
    target_country: body.target_country ?? body.country ?? null,
    course: body.course ?? body.program ?? null,
    course_level: body.course_level ?? null,
    intake: body.intake ?? null,
    source,
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: CORS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const key = new URL(req.url).searchParams.get("key");
  if (!key) return json({ ok: false, error: "missing ?key=" }, 401);

  const { data: wk } = await supabase
    .from("webhook_keys").select("org_id, source, active").eq("key", key).single();
  if (!wk?.active) return json({ ok: false, error: "invalid or inactive key" }, 401);

  if (req.method === "GET") {
    const { data: org } = await supabase.from("organizations")
      .select("name, brand_color, active").eq("id", wk.org_id).single();
    if (!org?.active) return json({ ok: false, error: "inactive" }, 404);
    return json({ ok: true, name: org.name, brand_color: org.brand_color });
  }
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  let body: unknown;
  try { body = await req.json(); } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  const lead = extractLead(body, wk.source);
  if (!lead.email && !lead.phone) {
    return json({ ok: false, error: "no email or phone found" }, 422);
  }

  let q = supabase.from("leads").select("id").eq("org_id", wk.org_id);
  if (lead.email && lead.phone) q = q.or("email.eq." + lead.email + ",phone.eq." + lead.phone);
  else if (lead.email) q = q.eq("email", lead.email);
  else q = q.eq("phone", lead.phone!);
  const { data: existing } = await q.limit(1);

  if (existing?.length) {
    await supabase.from("activities").insert({
      org_id: wk.org_id, lead_id: existing[0].id, type: wk.source === "whatsapp" ? "whatsapp" : "note",
      content: "New inbound message via " + wk.source + ":\n" + lead.message,
    });
    await supabase.from("leads").update({ last_contacted_at: new Date().toISOString() }).eq("id", existing[0].id);
    return json({ ok: true, deduped: true, lead_id: existing[0].id });
  }

  let assignTo: string | null = null;
  const { data: team } = await supabase.from("profiles")
    .select("id").eq("org_id", wk.org_id).eq("status", "active");
  if (team?.length) {
    const { data: open } = await supabase.from("leads")
      .select("assigned_to").eq("org_id", wk.org_id)
      .not("stage", "in", "(enrolled,lost)").not("assigned_to", "is", null);
    const load: Record<string, number> = Object.fromEntries(team.map((t) => [t.id, 0]));
    (open ?? []).forEach((l) => { if (l.assigned_to in load) load[l.assigned_to]++; });
    assignTo = team.sort((a, b) => load[a.id] - load[b.id])[0].id;
  }

  // score at intake — one inbound message counts as the first engagement signal
  const { score } = scoreLead({
    email: lead.email, phone: lead.phone, target_country: lead.target_country,
    course: lead.course, course_level: lead.course_level, intake: lead.intake,
    stage: "new", engagement_count: lead.message ? 1 : 0,
  });

  const { data: inserted, error } = await supabase.from("leads").insert({
    org_id: wk.org_id, name: lead.name, email: lead.email, phone: lead.phone,
    source: lead.source, target_country: lead.target_country, course: lead.course,
    course_level: lead.course_level, intake: lead.intake, raw: body, assigned_to: assignTo,
    score,
    next_follow_up_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  }).select("id").single();

  if (error) return json({ ok: false, error: error.message }, 500);

  if (lead.message) {
    await supabase.from("activities").insert({
      org_id: wk.org_id, lead_id: inserted.id, type: "system",
      content: "First inbound message via " + wk.source + ":\n" + lead.message,
    });
  }

  // best-effort phone alert — must not affect the webhook's response
  const alert = await notifyNewLead(supabase, wk.org_id, {
    id: inserted.id, name: lead.name, email: lead.email, phone: lead.phone,
    source: lead.source, target_country: lead.target_country, course: lead.course,
    score, message: lead.message,
  });

  // WhatsApp autoreply — only for inbound WhatsApp, only if the org enabled it.
  // We are inside the 24h window by definition here: they just messaged us.
  let autoreply: unknown = undefined;
  if (wk.source === "whatsapp" && lead.phone) {
    const waCfg = await getWhatsAppConfig(supabase, wk.org_id);
    if (waCfg.whatsapp_autoreply) {
      const { data: orgRow } = await supabase.from("organizations")
        .select("name").eq("id", wk.org_id).single();
      const brand = orgRow?.name || "AbroBot";
      autoreply = await sendWhatsAppText(
        waCfg,
        lead.phone,
        `Hi ${lead.name.split(" ")[0]}! 👋 Thanks for reaching out to ${brand}. ` +
        `A counsellor will get back to you shortly. ` +
        `Meanwhile, feel free to tell us your target country and course.`,
      );
    }
  }

  // Event-driven automations. Runs after the lead is safely persisted and the
  // alert is out, so a misconfigured rule can never cost us the enquiry.
  const automations = await fireEventAutomations(
    supabase, wk.org_id,
    { ...lead, id: inserted.id, score, tags: [], stage_key: null },
    "lead_created",
  );

  return json({
    ok: true, deduped: false, lead_id: inserted.id, score,
    alert, autoreply, automations,
  });
});