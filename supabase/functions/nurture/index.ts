// AbroBot CRM — automated email nurture engine (Resend, free tier).
// Deploy:  supabase functions deploy nurture --no-verify-jwt
// Secrets required:
//   RESEND_API_KEY   (from resend.com → API keys)
//   NURTURE_FROM     (optional; default 'AbroBot <hello@updates.mnbresearch.com>')
//   NURTURE_REPLY_TO (optional; default 'mnbgotyou@gmail.com')
//   BOOKING_URL      (optional; default Calendly link)
//
// POST {}                          -> runs one pass, sends all due emails
// GET  ?unsub=<nurture_token>      -> unsubscribes that lead (used by the footer link)
//
// A warm lead (has email, still early-stage, not opted out) receives up to 3
// gentle emails spaced over ~10 days, each ending in a "book a free call" CTA.
// Sending contact@ is untouched — these go from the updates.mnbresearch.com
// subdomain, and replies route to your Gmail.

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("NURTURE_FROM") || "AbroBot <hello@updates.mnbresearch.com>";
const REPLY_TO = Deno.env.get("NURTURE_REPLY_TO") || "mnbgotyou@gmail.com";
const BOOKING_URL = Deno.env.get("BOOKING_URL") || "https://calendly.com/mridulnanda2004/abrobot-meet";
const FN_BASE = (Deno.env.get("SUPABASE_URL") || "").replace(".supabase.co", ".supabase.co/functions/v1");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

// spacing between steps (hours). step0->1 quick, then a few days apart.
const GAP_HOURS = [1, 72, 96]; // ~1h after capture, +3 days, +4 days
const MAX_STEP = 3;

const esc = (s: string) => (s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

function firstName(name?: string | null, email?: string | null): string {
  const n = (name || "").trim().split(/\s+/)[0];
  if (n && !/^\d+$/.test(n)) return n;
  const e = (email || "").split("@")[0];
  return e ? e.charAt(0).toUpperCase() + e.slice(1) : "there";
}

// ---- the sequence -------------------------------------------------------
function email(step: number, lead: any, unsubUrl: string) {
  const fn = esc(firstName(lead.name, lead.email));
  const country = esc(lead.target_country || "your target country");
  const course = lead.course ? esc(lead.course) : (lead.course_level ? esc(lead.course_level) : "your programme");
  const cta = `<a href="${BOOKING_URL}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">📅 Book your free counselling call</a>`;
  const wrap = (title: string, body: string) => ({
    subject: title,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;line-height:1.6;font-size:15px">
      <div style="text-align:center;padding:8px 0 16px"><span style="font-size:20px;font-weight:800;background:linear-gradient(90deg,#f59e0b,#f97316);-webkit-background-clip:text;background-clip:text;color:transparent">AbroBot</span></div>
      ${body}
      <p style="margin:22px 0">${cta}</p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
      <p style="font-size:12px;color:#64748b">You're receiving this because you enquired with AbroBot about studying abroad. Reply to this email to reach our team, or
      <a href="${unsubUrl}" style="color:#64748b">unsubscribe</a>. AbroBot · MNB Research · +91 97114 88480 · <a href="https://www.abrobot.ai" style="color:#64748b">abrobot.ai</a></p>
    </div>`,
  });

  if (step === 0) return wrap(
    `${fn}, your free AbroBot study-abroad assessment`,
    `<p>Hi ${fn},</p>
     <p>Thanks for reaching out to AbroBot about <b>${course}</b> in <b>${country}</b>. Based on 25 lakh+ real student journeys, here's how we can help you move forward:</p>
     <ul>
       <li>A profile-matched <b>university shortlist</b> (ambitious / target / safe)</li>
       <li>A cautious read on your <b>visa &amp; admission chances</b></li>
       <li><b>Scholarships</b> you actually qualify for</li>
     </ul>
     <p>The fastest next step is a quick, free call with a counsellor who can map this out for you personally.</p>`);

  if (step === 1) return wrap(
    `${fn}, a few things worth doing this week for ${country}`,
    `<p>Hi ${fn},</p>
     <p>Intakes and scholarship deadlines for ${country} move faster than most students expect. To stay ahead for <b>${course}</b>, this is the order that works best:</p>
     <ol>
       <li>Lock your <b>university shortlist</b> early (more scholarship seats)</li>
       <li>Start your <b>SOP</b> — our AI SOP Analyser gives instant feedback: <a href="https://app.abrobot.ai">app.abrobot.ai</a></li>
       <li>Check your <b>visa readiness</b> before you apply</li>
     </ol>
     <p>Want a counsellor to build this plan around your profile? Grab a free slot below.</p>`);

  return wrap(
    `${fn}, one last nudge from AbroBot 🎓`,
    `<p>Hi ${fn},</p>
     <p>I don't want your ${country} plan to stall. If now's the right time, a 15-minute free call is the quickest way to get a clear, personalised roadmap — universities, scholarships, visa and costs.</p>
     <p>Prefer WhatsApp? Message us at <a href="https://wa.me/919711488480">+91 97114 88480</a>. Otherwise, book a time that suits you below and a counsellor will take it from there.</p>`);
}

async function sendEmail(to: string, subject: string, html: string) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, html }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // --- unsubscribe link ---
  const url = new URL(req.url);
  const unsub = url.searchParams.get("unsub");
  if (unsub) {
    await supabase.from("leads").update({ nurture_opted_out: true }).eq("nurture_token", unsub);
    return new Response(
      `<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>You're unsubscribed</h2><p>You won't receive more nurture emails from AbroBot. You can still reach us anytime at contact@mnbresearch.com.</p></body></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }

  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!RESEND_KEY) return json({ error: "RESEND_API_KEY not set" }, 503);

  // Which org to run for. Defaults to "abrobot" so existing cron callers that
  // POST {} keep behaving exactly as before.
  let slug = "abrobot";
  try {
    const body = await req.json();
    if (body?.org && typeof body.org === "string") slug = body.org;
  } catch { /* empty body is the normal cron case */ }

  const { data: org } = await supabase.from("organizations").select("id").eq("slug", slug).single();
  if (!org) return json({ error: "org not found" }, 404);

  // Respect the per-org toggle in CRM Settings. Until now this column was
  // written by the UI but never read, so an org that switched nurture OFF was
  // still being emailed.
  //
  // Fail-open on a MISSING config row (preserves historical behaviour for orgs
  // that never opened Settings); fail-closed only on an explicit false.
  const { data: cfg } = await supabase
    .from("agent_config").select("nurture_enabled").eq("org_id", org.id).single();
  if (cfg && cfg.nurture_enabled === false) {
    return json({ ok: true, skipped: "nurture_enabled is off for " + slug, sent: 0 });
  }

  // candidate leads: have email, not opted out, still early stage, under max step
  const { data: leads } = await supabase.from("leads")
    .select("id, name, email, target_country, course, course_level, stage, nurture_step, nurture_last_sent_at, nurture_token, created_at")
    .eq("org_id", org.id)
    .not("email", "is", null)
    .eq("nurture_opted_out", false)
    .lt("nurture_step", MAX_STEP)
    .in("stage", ["new", "contacted", "counselled"])
    .limit(200);

  const now = Date.now();
  let sent = 0; const errors: string[] = [];
  for (const l of leads ?? []) {
    const gapH = GAP_HOURS[l.nurture_step] ?? 96;
    const since = l.nurture_last_sent_at ? (now - new Date(l.nurture_last_sent_at).getTime()) : (now - new Date(l.created_at).getTime());
    if (since < gapH * 3600 * 1000) continue; // not due yet
    try {
      const unsubUrl = `${FN_BASE}/nurture?unsub=${l.nurture_token}`;
      const { subject, html } = email(l.nurture_step, l, unsubUrl);
      await sendEmail(l.email, subject, html);
      await supabase.from("leads").update({
        nurture_step: l.nurture_step + 1,
        nurture_last_sent_at: new Date().toISOString(),
      }).eq("id", l.id);
      await supabase.from("activities").insert({
        org_id: org.id, lead_id: l.id, type: "email",
        content: `Nurture email #${l.nurture_step + 1} sent automatically to ${l.email}.`,
      });
      sent++;
    } catch (e) {
      errors.push(`${l.email}: ${(e as Error).message}`);
    }
  }
  return json({ ok: true, candidates: leads?.length ?? 0, sent, errors });
});
