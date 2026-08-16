// AbroBot CRM — one-off "compose & send" campaign sender (Resend, free tier).
// Deploy:  supabase functions deploy send-campaign   (KEEP Verify JWT ON)
// Secrets: RESEND_API_KEY, NURTURE_FROM?, NURTURE_REPLY_TO?  (shared with nurture)
//
// Auth: caller must send the logged-in user's Supabase access token in the
// Authorization header. Only active members of the org may send, and only to
// their own org's leads. This is why the endpoint keeps JWT verification ON.
//
// POST {
//   subject: string,
//   body: string,               // HTML or plain text typed by the user
//   audience?: { stage?, country?, tag?, onlyMine?: bool },
//   lead_ids?: string[],        // optional explicit selection (overrides audience)
//   test_to?: string            // if set, sends ONE test email here and stops
// }

import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("NURTURE_FROM") || "AbroBot <hello@updates.mnbresearch.com>";
const REPLY_TO = Deno.env.get("NURTURE_REPLY_TO") || "mnbgotyou@gmail.com";
const FN_BASE = (Deno.env.get("SUPABASE_URL") || "").replace(".supabase.co", ".supabase.co/functions/v1");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

function template(bodyHtml: string, unsubUrl: string) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;line-height:1.6;font-size:15px">
    <div style="text-align:center;padding:8px 0 16px"><span style="font-size:20px;font-weight:800;background:linear-gradient(90deg,#f59e0b,#f97316);-webkit-background-clip:text;background-clip:text;color:transparent">AbroBot</span></div>
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
    <p style="font-size:12px;color:#64748b">You're receiving this because you enquired with AbroBot about studying abroad. Reply to reach our team, or
    <a href="${unsubUrl}" style="color:#64748b">unsubscribe</a>. AbroBot · MNB Research · +91 97114 88480 · <a href="https://www.abrobot.ai" style="color:#64748b">abrobot.ai</a></p>
  </div>`;
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
  if (!RESEND_KEY) return json({ error: "RESEND_API_KEY not set" }, 503);

  // --- authenticate the CRM user ---
  const authz = req.headers.get("Authorization") || "";
  const token = authz.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing auth" }, 401);
  const { data: userData, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !userData?.user) return json({ error: "invalid session" }, 401);
  const { data: profile } = await admin.from("profiles")
    .select("org_id, status, role, full_name, email").eq("id", userData.user.id).single();
  if (!profile || profile.status !== "active" || !profile.org_id) return json({ error: "not an active member" }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const subject = (body.subject ?? "").toString().trim();
  const rawBody = (body.body ?? "").toString().trim();
  if (!subject || !rawBody) return json({ error: "subject and body are required" }, 400);

  // --- test send (to the composer only) ---
  if (body.test_to) {
    const unsubUrl = `${FN_BASE}/nurture?unsub=preview`;
    await sendEmail(String(body.test_to), `[TEST] ${subject}`, template(rawBody, unsubUrl));
    return json({ ok: true, test: true, to: body.test_to });
  }

  // --- resolve audience within the caller's org ---
  let q = admin.from("leads")
    .select("id, name, email, nurture_token, assigned_to")
    .eq("org_id", profile.org_id)
    .not("email", "is", null)
    .eq("nurture_opted_out", false);

  if (Array.isArray(body.lead_ids) && body.lead_ids.length) {
    q = q.in("id", body.lead_ids.slice(0, 2000));
  } else {
    const a = body.audience || {};
    if (a.stage) q = q.eq("stage", a.stage);
    if (a.country) q = q.eq("target_country", a.country);
    if (a.tag) q = q.contains("tags", [a.tag]);
    if (a.onlyMine) q = q.eq("assigned_to", userData.user.id);
  }
  const { data: leads } = await q.limit(2000);

  let sent = 0; const errors: string[] = [];
  for (const l of leads ?? []) {
    try {
      const unsubUrl = `${FN_BASE}/nurture?unsub=${l.nurture_token}`;
      await sendEmail(l.email, subject, template(rawBody, unsubUrl));
      await admin.from("activities").insert({
        org_id: profile.org_id, lead_id: l.id, type: "email",
        content: `Campaign email "${subject.slice(0, 60)}" sent by ${profile.full_name || profile.email}.`,
      });
      sent++;
    } catch (e) {
      errors.push(`${l.email}: ${(e as Error).message}`);
    }
  }
  return json({ ok: true, matched: leads?.length ?? 0, sent, errors });
});
