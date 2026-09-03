// AbroBot CRM — app.abrobot.ai signup hook.
// Deploy: supabase functions deploy app-signup --no-verify-jwt
// Secrets: RESEND_API_KEY, APP_WEBHOOK_SECRET, NURTURE_FROM?, NURTURE_REPLY_TO?, BOOKING_URL?
//
// The app calls this once when a user signs in / signs up:
//   POST { email, name?, country?, course? }  with header  x-app-secret: <APP_WEBHOOK_SECRET>
// -> creates a CRM lead (source "app"), sends a one-time welcome email, and lets the
//    daily nurture engine continue the follow-up. Existing emails are de-duplicated so
//    a returning user never gets a second welcome.

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const APP_SECRET = Deno.env.get("APP_WEBHOOK_SECRET") ?? "";
const FROM = Deno.env.get("NURTURE_FROM") || "AbroBot <hello@updates.mnbresearch.com>";
const REPLY_TO = Deno.env.get("NURTURE_REPLY_TO") || "mnbgotyou@gmail.com";
const BOOKING_URL = Deno.env.get("BOOKING_URL") || "https://calendly.com/mridulnanda2004/abrobot-meet";
const FN_BASE = (Deno.env.get("SUPABASE_URL") || "").replace(".supabase.co", ".supabase.co/functions/v1");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-app-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function welcomeEmail(name: string, unsubUrl: string) {
  const cta = `<a href="${BOOKING_URL}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">📅 Book a free counselling call</a>`;
  return {
    subject: `Welcome to AbroBot, ${name} 🎓`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;line-height:1.6;font-size:15px">
      <div style="text-align:center;padding:8px 0 16px"><span style="font-size:20px;font-weight:800;background:linear-gradient(90deg,#f59e0b,#f97316);-webkit-background-clip:text;background-clip:text;color:transparent">AbroBot</span></div>
      <p>Hi ${name},</p>
      <p>Welcome to the AbroBot app — you now have <b>20+ AI tools</b> for your study-abroad journey in one place: AI Counsellor, SOP Analyser, University Matcher, Scholarship Finder, ROI Predictor and more.</p>
      <p>A good first move: run the <b>Profile Evaluator</b> and the <b>University Matcher</b>, then have a human counsellor turn the results into a real plan. Want us to set that up?</p>
      <p style="margin:22px 0">${cta}</p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
      <p style="font-size:12px;color:#64748b">You're receiving this because you signed up on app.abrobot.ai. Reply to reach our team, or
      <a href="${unsubUrl}" style="color:#64748b">unsubscribe</a>. AbroBot · MNB Research · +91 97114 88480 · <a href="https://www.abrobot.ai" style="color:#64748b">abrobot.ai</a></p>
    </div>`,
  };
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
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (APP_SECRET && req.headers.get("x-app-secret") !== APP_SECRET) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const email = (body.email ?? "").toString().trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: "valid email required" }, 400);
  const name = (body.name ?? "").toString().trim().slice(0, 80) || email.split("@")[0];

  const { data: org } = await supabase.from("organizations").select("id").eq("slug", "abrobot").single();
  if (!org) return json({ error: "org not found" }, 404);

  // dedupe by email
  const { data: existing } = await supabase.from("leads")
    .select("id, nurture_token").eq("org_id", org.id).eq("email", email).limit(1);
  if (existing && existing.length) {
    return json({ ok: true, deduped: true }); // already known — no second welcome
  }

  // Start nurture at step 1 so the daily engine's "this week" email follows a
  // few days after this welcome (no duplicate intro).
  //
  // source was "app", which is NOT a member of the lead_source enum
  // (whatsapp, chatbase, email, website, csv_import, pdf_import, manual,
  // referral, other). Every insert here failed with 22P02 — and because the
  // error was discarded and the code then did `if (lead)`, it failed silently:
  // the endpoint returned ok:true while recording nothing. Signups from the
  // app have been dropping on the floor. Marked "other" so they land; the
  // activity row below still says where they came from.
  const { data: lead, error: leadErr } = await supabase.from("leads").insert({
    org_id: org.id, name, email, source: "other", stage: "new",
    target_country: body.country || null, course: body.course || null,
    nurture_step: 1, nurture_last_sent_at: new Date().toISOString(),
    next_follow_up_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  }).select("id, nurture_token").single();

  if (leadErr) {
    console.error("app-signup: lead insert failed", leadErr);
    return json({ ok: false, error: leadErr.message }, 500);
  }

  if (lead) {
    await supabase.from("activities").insert({
      org_id: org.id, lead_id: lead.id, type: "system",
      content: "Signed up on app.abrobot.ai — welcome email sent.",
    });
    if (RESEND_KEY) {
      try {
        const unsubUrl = `${FN_BASE}/nurture?unsub=${lead.nurture_token}`;
        const { subject, html } = welcomeEmail(name, unsubUrl);
        await sendEmail(email, subject, html);
      } catch (_e) { /* lead still created even if email hiccups */ }
    }
  }
  return json({ ok: true, created: true });
});
