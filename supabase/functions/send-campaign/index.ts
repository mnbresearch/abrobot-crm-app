// AbroBot CRM — send an email to one record, or to an audience.
//
// Deploy:  supabase functions deploy send-campaign     (KEEP Verify JWT ON)
// Secrets: RESEND_API_KEY, NURTURE_FROM?
//
// POST {
//   subject, body,                  // body is plain text; merge tokens allowed
//   lead_ids?: string[],            // explicit selection
//   audience?: { stage_key?, country?, tag?, onlyMine?, source? },
//   test_to?: string,               // send one copy here and stop
//   count_only?: true               // resolve the audience, send nothing
// }
//
// ── What changed and why ────────────────────────────────────────────────────
// This function existed, was correct about authentication, and had ZERO
// callers — Templates was a notepad with no Send button, so nothing in the
// product could send an email at all. Wiring it up first meant fixing what it
// would have sent:
//
//  * It stamped AbroBot's wordmark and "you enquired with AbroBot about
//    studying abroad" on every message, for every tenant.
//  * It ignored the merge tokens the Templates screen advertises, so
//    "Hi {{first_name}}" was delivered literally.
//  * It filtered on the legacy `stage` column, which the industry packs
//    replaced with stage_key — so audience filters matched nothing.
//  * It sent up to 2000 emails with no confirmation step and no plan gate.
//
// count_only exists because of the last one: the UI resolves the audience and
// makes the person read the number before anything leaves.

import { createClient } from "npm:@supabase/supabase-js@2";
import { applyTemplate, escapeHtml, textToHtml } from "../_shared/template.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const PLATFORM_RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_ADDRESS = Deno.env.get("NURTURE_FROM") || "hello@updates.mnbresearch.com";
const FN_BASE = (Deno.env.get("SUPABASE_URL") || "") + "/functions/v1";

const MAX_RECIPIENTS = 2000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

function wrap(bodyHtml: string, brand: string, contactUrl: string, unsubUrl: string) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;line-height:1.6;font-size:15px">
  <div style="text-align:center;padding:8px 0 18px;font-size:19px;font-weight:800">${escapeHtml(brand)}</div>
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
  <p style="font-size:12px;color:#64748b">
    You are receiving this because you enquired with ${escapeHtml(brand)}. Reply to this email to reach us, or
    <a href="${unsubUrl}" style="color:#64748b">unsubscribe</a>.${
      contactUrl ? ` <a href="${escapeHtml(contactUrl)}" style="color:#64748b">Contact ${escapeHtml(brand)}</a>.` : ""
    }
  </p>
</div>`;
}

async function sendEmail(
  key: string, from: string, to: string, replyTo: string | null,
  subject: string, html: string, unsubUrl: string,
) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      from, to: [to], ...(replyTo ? { reply_to: replyTo } : {}), subject, html,
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // ── authenticate the CRM user ─────────────────────────────────────────────
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing auth" }, 401);
  const { data: userData, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !userData?.user) return json({ error: "invalid session" }, 401);

  const { data: profile } = await admin.from("profiles")
    .select("org_id, status, role, full_name, email").eq("id", userData.user.id).single();
  if (!profile || profile.status !== "active" || !profile.org_id) {
    return json({ error: "not an active member" }, 403);
  }
  const orgId = profile.org_id as string;

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  const subjectTpl = (body.subject ?? "").toString().trim();
  const bodyTpl = (body.body ?? "").toString().trim();
  if (!subjectTpl || !bodyTpl) return json({ error: "Subject and message are both required" }, 400);

  // ── who we are sending as ─────────────────────────────────────────────────
  const [{ data: org }, { data: cfg }] = await Promise.all([
    admin.from("organizations").select("name, slug").eq("id", orgId).single(),
    admin.from("agent_config").select("resend_api_key, brand_name, contact_url")
      .eq("org_id", orgId).maybeSingle(),
  ]);

  const brand = (cfg?.brand_name || org?.name || "").trim() || "Your team";
  const contactUrl = (cfg?.contact_url || "").trim();
  const key = (cfg?.resend_api_key || "").trim() || PLATFORM_RESEND_KEY;
  if (!key) return json({ error: "Email sending is not configured yet. Add a Resend API key in Integrations." }, 503);

  // The address must stay on our authenticated domain — a tenant's own domain
  // is not SPF/DKIM-authorised for us and would fail outright — but the name
  // and the reply address are theirs.
  const from = `${brand.replace(/["<>\\]/g, "")} <${FROM_ADDRESS}>`;
  const replyTo = (profile.email || "").trim() || null;

  // ── test send: to the composer, personalised against a fake record ────────
  if (body.test_to) {
    const sample = {
      name: profile.full_name || "Sample Person",
      email: String(body.test_to),
      target_country: "—", course: "—",
    };
    const html = wrap(
      textToHtml(applyTemplate(bodyTpl, sample, brand)),
      brand, contactUrl, `${FN_BASE}/nurture?unsub=preview`,
    );
    await sendEmail(key, from, String(body.test_to), replyTo,
      `[TEST] ${applyTemplate(subjectTpl, sample, brand)}`, html, `${FN_BASE}/nurture?unsub=preview`);
    return json({ ok: true, test: true, to: body.test_to });
  }

  // ── resolve the audience, inside the caller's org ─────────────────────────
  let q = admin.from("leads")
    .select("id, name, email, phone, target_country, course, course_level, intake, custom, nurture_token")
    .eq("org_id", orgId)
    .not("email", "is", null)
    .eq("nurture_opted_out", false);

  if (Array.isArray(body.lead_ids) && body.lead_ids.length) {
    q = q.in("id", body.lead_ids.slice(0, MAX_RECIPIENTS));
  } else {
    const a = body.audience || {};
    // stage_key, not the legacy `stage`. Filtering on `stage` matched nothing
    // for every industry pack introduced after it.
    if (a.stage_key) q = q.eq("stage_key", a.stage_key);
    if (a.country) q = q.eq("target_country", a.country);
    if (a.source) q = q.eq("source", a.source);
    if (a.tag) q = q.contains("tags", [a.tag]);
    if (a.onlyMine) q = q.eq("assigned_to", userData.user.id);
  }

  const { data: leads, error: leadErr } = await q.limit(MAX_RECIPIENTS);
  if (leadErr) return json({ error: leadErr.message }, 500);

  const recipients = leads ?? [];

  // ── the plan's email allowance ────────────────────────────────────────────
  // Checked BEFORE sending, not per message. Refusing halfway through a
  // 400-person send leaves the tenant with no idea who received it and no way
  // to resume without double-sending some of them.
  const { data: allowance } = await admin.rpc("email_allowance", { p_org_id: orgId });
  const remaining: number | null = allowance?.remaining ?? null;

  // ── count_only: let the UI show the number before anything is sent ────────
  if (body.count_only) {
    return json({
      ok: true, count_only: true, matched: recipients.length,
      capped: recipients.length >= MAX_RECIPIENTS,
      remaining,
      sample: recipients.slice(0, 3).map((l) => l.email),
    });
  }
  if (recipients.length === 0) {
    return json({ error: "No one matches that audience — nothing was sent." }, 422);
  }

  if (remaining !== null && recipients.length > remaining) {
    return json({
      error: remaining === 0
        ? "You have used this month's email allowance. It resets on the 1st, or upgrade your plan to send more."
        : `This would send ${recipients.length} emails but only ${remaining} are left in this month's allowance. Narrow the audience, wait for the reset on the 1st, or upgrade.`,
      remaining,
      needed: recipients.length,
    }, 402);
  }

  // ── send ──────────────────────────────────────────────────────────────────
  let sent = 0;
  const errors: string[] = [];
  for (const l of recipients) {
    try {
      const unsubUrl = `${FN_BASE}/nurture?unsub=${l.nurture_token}`;
      const html = wrap(textToHtml(applyTemplate(bodyTpl, l, brand)), brand, contactUrl, unsubUrl);
      await sendEmail(key, from, l.email, replyTo,
        applyTemplate(subjectTpl, l, brand), html, unsubUrl);

      await admin.from("activities").insert({
        org_id: orgId, lead_id: l.id, type: "email",
        content: `Email "${subjectTpl.slice(0, 60)}" sent by ${profile.full_name || profile.email}.`,
      });
      sent++;
    } catch (e) {
      errors.push(`${l.email}: ${(e as Error).message}`);
    }
  }

  // Meter what actually left, not what was attempted. A bounce at Resend is
  // not something to bill a customer's allowance for.
  if (sent > 0) {
    await admin.rpc("consume_usage", { p_org_id: orgId, p_metric: "emails", p_amount: sent });
  }

  return json({ ok: true, matched: recipients.length, sent, errors: errors.slice(0, 20) });
});
