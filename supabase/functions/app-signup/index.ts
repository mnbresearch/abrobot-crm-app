// AbroBot CRM — app.abrobot.ai signup hook.
// Deploy: supabase functions deploy app-signup --no-verify-jwt
// Secrets: RESEND_API_KEY, APP_WEBHOOK_SECRET, NURTURE_FROM?, NURTURE_REPLY_TO?, BOOKING_URL?,
//          APP_SIGNUP_ORG_SLUG?, CRM_BASE_URL?
//
// The app calls this once when a user signs in / signs up:
//   POST { email, name?, country?, course? }  with header  x-app-secret: <APP_WEBHOOK_SECRET>
// -> creates a CRM lead (source "app"), sends a one-time welcome email, and lets the
//    daily nurture engine continue the follow-up. Existing emails are de-duplicated so
//    a returning user never gets a second welcome.

import { createClient } from "npm:@supabase/supabase-js@2";
import { fetchWithTimeout } from "../_shared/http.ts";
import { escapeHtml } from "../_shared/template.ts";
import { loadSuppressed } from "../_shared/suppression.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const APP_SECRET = Deno.env.get("APP_WEBHOOK_SECRET") ?? "";
const FROM = Deno.env.get("NURTURE_FROM") || "AbroBot <hello@updates.mnbresearch.com>";
// No personal fallbacks. These defaulted to a founder's personal Gmail and
// personal Calendly, so a deployment that had not set the secrets routed
// every new user's reply to one person's private inbox and offered their
// private calendar. Unset now means omitted: no Reply-To header (replies go to
// the From address, which is ours) and no booking button.
const REPLY_TO = (Deno.env.get("NURTURE_REPLY_TO") ?? "").trim() || null;
const BOOKING_URL = (Deno.env.get("BOOKING_URL") ?? "").trim();
const FN_BASE = (Deno.env.get("SUPABASE_URL") || "").replace(".supabase.co", ".supabase.co/functions/v1");
// The footer link goes to the CRM-site page, which renders properly and POSTs
// back to nurture; see the same constant in nurture/index.ts for why a link
// straight at the function showed recipients raw HTML.
const SITE = Deno.env.get("CRM_BASE_URL") || "https://crm.mnbresearch.com";

// Which CRM organisation app signups are filed into.
//
// A fixed slug looks like the multi-tenant bug fixed everywhere else, and it is
// not one: app.abrobot.ai is a SEPARATE product (the study-abroad app), and
// this hook exists to put that product's own signups into the CRM of the
// business that runs it — the 'abrobot' organisation. No tenant's data flows
// through here, and the shared secret above means only that app can call it.
// Read from the environment so a staging deployment can point at a test org
// instead of writing into the real one.
const SIGNUP_ORG_SLUG = (Deno.env.get("APP_SIGNUP_ORG_SLUG") ?? "").trim() || "abrobot";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-app-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function welcomeEmail(name: string, unsubUrl: string) {
  // `name` is whatever the app posted. Unescaped, a name of `<a href=…>` was
  // markup in an email sent from our verified domain — a phishing link with
  // our DKIM signature on it. And CR/LF in a subject line is header injection
  // territory; Resend builds the headers, but nothing here should rely on that.
  const safeName = escapeHtml(name);
  const subjectName = name.replace(/[\r\n]+/g, " ").trim();
  const cta = BOOKING_URL
    ? `<p style="margin:22px 0"><a href="${escapeHtml(BOOKING_URL)}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">📅 Book a free counselling call</a></p>`
    : "";
  return {
    subject: `Welcome to AbroBot, ${subjectName} 🎓`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;line-height:1.6;font-size:15px">
      <div style="text-align:center;padding:8px 0 16px"><span style="font-size:20px;font-weight:800;background:linear-gradient(90deg,#f59e0b,#f97316);-webkit-background-clip:text;background-clip:text;color:transparent">AbroBot</span></div>
      <p>Hi ${safeName},</p>
      <p>Welcome to the AbroBot app — you now have <b>20+ AI tools</b> for your study-abroad journey in one place: AI Counsellor, SOP Analyser, University Matcher, Scholarship Finder, ROI Predictor and more.</p>
      <p>A good first move: run the <b>Profile Evaluator</b> and the <b>University Matcher</b>, then have a human counsellor turn the results into a real plan. Want us to set that up?${BOOKING_URL ? "" : " Just reply to this email."}</p>
      ${cta}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
      <p style="font-size:12px;color:#64748b">You're receiving this because you signed up on app.abrobot.ai. Reply to reach our team, or
      <a href="${unsubUrl}" style="color:#64748b">unsubscribe</a>. AbroBot · MNB Research · +91 97114 88480 · <a href="https://www.abrobot.ai" style="color:#64748b">abrobot.ai</a></p>
    </div>`,
  };
}

async function sendEmail(to: string, subject: string, html: string, unsubUrl: string) {
  const r = await fetchWithTimeout("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({
      from: FROM, to: [to], ...(REPLY_TO ? { reply_to: REPLY_TO } : {}), subject, html,
      // RFC 8058, the same headers nurture and send-campaign set. This mail
      // goes from the shared platform domain, and Gmail and Yahoo filter bulk
      // senders without one-click unsubscribe on reputation — every tenant's.
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  // Fails CLOSED. This used to read `if (APP_SECRET && ...)`, so an unset
  // secret — the deployment default — disabled the check entirely. That made
  // this an open relay: anyone who knew the URL could POST an arbitrary
  // address and cause a send from our verified domain, plus insert a lead.
  // One abuse report on that domain costs every tenant their deliverability,
  // because nurture and campaign mail go out from the same place.
  //
  // _shared/cron-auth.ts already fails closed for exactly this reason; this
  // endpoint was written before that and never brought into line.
  if (!APP_SECRET) {
    console.error("app-signup: APP_SECRET is not set — refusing to run. Set it in Edge Function secrets.");
    return json({ error: "signup is not configured" }, 503);
  }
  const presented = req.headers.get("x-app-secret") ?? "";
  // Constant-time compare: a plain !== leaks the secret one byte at a time to
  // anyone willing to measure.
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(APP_SECRET);
  let same = a.length === b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i % (a.length || 1)] !== b[i % (b.length || 1)]) same = false;
  }
  if (!same) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const email = (body.email ?? "").toString().trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: "valid email required" }, 400);
  const name = (body.name ?? "").toString().trim().slice(0, 80) || email.split("@")[0];

  const { data: org } = await supabase.from("organizations").select("id").eq("slug", SIGNUP_ORG_SLUG).single();
  if (!org) return json({ error: "org not found" }, 404);

  // dedupe by email
  const { data: existing } = await supabase.from("leads")
    .select("id, nurture_token").eq("org_id", org.id).eq("email", email)
    .is("deleted_at", null)   // a deleted signup can sign up again
    .limit(1);
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
    // The activity line said "welcome email sent" before the send was even
    // attempted, and the send's failure was swallowed — so the record claimed
    // a welcome that, with no key or a Resend rejection, never left. The line
    // now reports what actually happened.
    let outcome: string;
    if (!RESEND_KEY) {
      outcome = "welcome email not sent (no Resend key configured)";
    } else {
      // Someone on the platform suppression list unsubscribed from, bounced on
      // or complained about our mail. Signing up to the app does not undo that.
      // An unreadable list sends nothing — the same rule as every other sender.
      const sup = await loadSuppressed(supabase, [email]);
      if (sup.error !== null) {
        console.error("app-signup: suppression list unreadable, not sending the welcome:", sup.error);
        outcome = "welcome email not sent (could not check the unsubscribe list)";
      } else if (sup.suppressed.has(email)) {
        outcome = "welcome email not sent (address has unsubscribed from our email)";
      } else {
        try {
          const unsubUrl = `${FN_BASE}/nurture?unsub=${lead.nurture_token}`;
          const unsubPage = `${SITE}/unsubscribe?list=nurture&t=${lead.nurture_token}`;
          const { subject, html } = welcomeEmail(name, unsubPage);
          await sendEmail(email, subject, html, unsubUrl);
          outcome = "welcome email sent";
        } catch (e) {
          // The lead is still created — losing the signup over an email hiccup
          // would be the worse failure — but it is logged, not swallowed.
          console.error("app-signup: welcome email failed:", (e as Error).message);
          outcome = "welcome email FAILED to send";
        }
      }
    }
    const { error: actErr } = await supabase.from("activities").insert({
      org_id: org.id, lead_id: lead.id, type: "system",
      content: `Signed up on app.abrobot.ai — ${outcome}.`,
    });
    if (actErr) console.error("app-signup: could not record the signup activity:", actErr.message);
  }
  return json({ ok: true, created: true });
});
