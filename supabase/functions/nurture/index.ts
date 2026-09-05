// AbroBot CRM — automated email follow-up, per tenant.
//
// Deploy:  supabase functions deploy nurture --no-verify-jwt
// Secrets:
//   RESEND_API_KEY   platform sending key (a tenant's own key overrides it)
//   NURTURE_FROM     optional; default 'hello@updates.mnbresearch.com'
//   CRON_SECRET      required — see _shared/cron-auth.ts
//
// POST {}                     -> every eligible org
// POST {"org":"slug"}         -> one org
// GET  ?unsub=<token>         -> unsubscribe (the footer link)
//
// ── What this used to be, and why it changed ────────────────────────────────
// This function contained three study-abroad emails signed AbroBot, defaulted
// to org 'abrobot', and treated a missing agent_config row as consent to send.
// As a single-tenant tool that was fine. As a product sold to other businesses
// it meant the first correct cron run would email a dental clinic's patients
// about university shortlists — from our sending domain, earning spam
// complaints that would land on every other tenant's deliverability.
//
// So: the copy now belongs to the tenant (message_templates.nurture_step, i.e.
// the Templates screen), sending is opt-IN, and an org with no templates sends
// nothing rather than falling back to somebody else's marketing.

import { createClient } from "npm:@supabase/supabase-js@2";
import { requireCronSecret } from "../_shared/cron-auth.ts";
import { applyTemplate, escapeHtml, textToHtml } from "../_shared/template.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const PLATFORM_RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_ADDRESS = Deno.env.get("NURTURE_FROM") || "hello@updates.mnbresearch.com";
const FN_BASE = (Deno.env.get("SUPABASE_URL") || "") + "/functions/v1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

// Gap before each step, in hours: ~1h after capture, then +3 days, +4 days.
// Steps beyond the third reuse the last gap.
const GAP_HOURS = [1, 72, 96];
const ORGS_PER_RUN = 25;   // free-tier edge functions have a wall-clock budget
const LEADS_PER_ORG = 100;

interface Tpl { subject: string | null; body: string; nurture_step: number }

// deno-lint-ignore no-explicit-any
type Lead = any;

function buildEmail(tpl: Tpl, lead: Lead, brand: string, unsubUrl: string, contactUrl: string) {
  const subject = applyTemplate(tpl.subject || `A quick follow-up from ${brand}`, lead, brand);
  const bodyHtml = textToHtml(applyTemplate(tpl.body, lead, brand));

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;line-height:1.6;font-size:15px">
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

  return { subject, html };
}

async function sendEmail(
  key: string,
  from: string,
  to: string,
  replyTo: string | null,
  subject: string,
  html: string,
  unsubUrl: string,
) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      from,
      to: [to],
      ...(replyTo ? { reply_to: replyTo } : {}),
      subject,
      html,
      // RFC 8058. Gmail and Yahoo require one-click unsubscribe for bulk
      // senders; without these headers this mail is filtered on reputation
      // regardless of how good the copy is.
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}

// ── one organisation ────────────────────────────────────────────────────────
async function runOrg(org: { id: string; name: string; slug: string }) {
  const { data: cfg } = await supabase
    .from("agent_config")
    .select("nurture_enabled, resend_api_key, brand_name, contact_url, booking_url")
    .eq("org_id", org.id).maybeSingle();

  // Opt-in, explicitly. A missing config row is not consent.
  if (cfg?.nurture_enabled !== true) {
    return { org: org.slug, skipped: "nurture is off", sent: 0 };
  }

  const { data: tplRows } = await supabase
    .from("message_templates")
    .select("subject, body, nurture_step")
    .eq("org_id", org.id)
    .eq("channel", "email")
    .not("nurture_step", "is", null)
    .order("nurture_step", { ascending: true });

  const templates = (tplRows ?? []) as Tpl[];
  if (templates.length === 0) {
    // The important branch. No templates means this tenant has never written
    // follow-up copy, so there is nothing legitimate to send on their behalf.
    return { org: org.slug, skipped: "no nurture templates written", sent: 0 };
  }
  const byStep = new Map(templates.map((t) => [t.nurture_step, t]));
  const maxStep = Math.max(...templates.map((t) => t.nurture_step)) + 1;

  const key = (cfg.resend_api_key || "").trim() || PLATFORM_RESEND_KEY;
  if (!key) return { org: org.slug, skipped: "no Resend key", sent: 0 };

  // The plan's monthly email allowance. Unattended sending is exactly where a
  // limit matters most: nobody is watching, and it runs again in an hour.
  const { data: allowance } = await supabase.rpc("email_allowance", { p_org_id: org.id });
  let budget: number | null = allowance?.remaining ?? null;
  if (budget === 0) {
    return { org: org.slug, skipped: "monthly email allowance used up", sent: 0 };
  }

  const brand = (cfg.brand_name || org.name || "").trim() || org.slug;
  // Display name is the tenant's; the address stays on our verified domain,
  // because a tenant's own domain is not SPF/DKIM-authorised for us to send
  // from and would fail authentication outright.
  const from = `${brand.replace(/["<>\\]/g, "")} <${FROM_ADDRESS}>`;

  // Replies must reach the tenant, not us. The old function routed every
  // reply to a personal Gmail — which for any customer other than AbroBot
  // means their prospect's answer goes to a stranger. The org's longest-
  // standing admin is the closest thing to an owner inbox we hold.
  const { data: adminRow } = await supabase.from("profiles")
    .select("email").eq("org_id", org.id).eq("status", "active")
    .in("role", ["org_admin", "super_admin"])
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  const replyTo = (adminRow?.email || "").trim() || null;

  // Terminal stages are where follow-up must stop: a customer who has bought,
  // or explicitly said no, should not keep getting "one last nudge". The old
  // code allow-listed three legacy stage names, which meant every industry
  // pack that does not use them nurtured nobody — or, once stage_key landed,
  // nurtured people who had already converted.
  const { data: terminal } = await supabase
    .from("pipeline_stages").select("key")
    .eq("org_id", org.id).or("is_won.eq.true,is_lost.eq.true");
  const stop = new Set((terminal ?? []).map((s: { key: string }) => s.key));

  let q = supabase.from("leads")
    .select("id, name, email, phone, target_country, course, course_level, intake, custom, stage_key, nurture_step, nurture_last_sent_at, nurture_token, created_at")
    .eq("org_id", org.id)
    .not("email", "is", null)
    .eq("nurture_opted_out", false)
    .lt("nurture_step", maxStep)
    .limit(LEADS_PER_ORG);
  if (stop.size) {
    // Quoted: a stage key is normally a slug, but nothing enforces that, and an
    // unquoted comma or parenthesis in one key would silently reshape the
    // filter — which here means emailing people who have already converted.
    const list = [...stop].map((k) => `"${k.replace(/"/g, '""')}"`).join(",");
    q = q.or(`stage_key.is.null,stage_key.not.in.(${list})`);
  }

  const { data: leads, error: leadErr } = await q;
  if (leadErr) return { org: org.slug, error: leadErr.message, sent: 0 };

  const now = Date.now();
  let sent = 0;
  const errors: string[] = [];

  for (const l of (leads ?? []) as Lead[]) {
    if (budget !== null && budget <= 0) break;   // allowance exhausted mid-run

    const tpl = byStep.get(l.nurture_step);
    if (!tpl) continue;   // gap in the sequence — skip rather than substitute

    const gapH = GAP_HOURS[l.nurture_step] ?? GAP_HOURS[GAP_HOURS.length - 1];
    const since = l.nurture_last_sent_at
      ? now - new Date(l.nurture_last_sent_at).getTime()
      : now - new Date(l.created_at).getTime();
    if (since < gapH * 3600_000) continue;

    try {
      const unsubUrl = `${FN_BASE}/nurture?unsub=${l.nurture_token}`;
      const { subject, html } = buildEmail(tpl, l, brand, unsubUrl, (cfg.contact_url || "").trim());

      await sendEmail(key, from, l.email, replyTo, subject, html, unsubUrl);

      // Advance the step BEFORE anything else can fail. If the activity insert
      // errors after a successful send, the worst outcome must be a missing
      // log line, never the same email again on the next run.
      const { error: stepErr } = await supabase.from("leads").update({
        nurture_step: l.nurture_step + 1,
        nurture_last_sent_at: new Date().toISOString(),
      }).eq("id", l.id);
      if (stepErr) {
        // Cannot record that we sent → we would resend. Say so loudly.
        console.error(`nurture: SENT to ${l.email} but could not advance step:`, stepErr.message);
        errors.push(`${l.id}: sent but step not advanced (${stepErr.message})`);
      }

      await supabase.from("activities").insert({
        org_id: org.id, lead_id: l.id, type: "email",
        content: `Follow-up email ${l.nurture_step + 1} of ${maxStep} sent automatically to ${l.email}.`,
      });
      sent++;
      if (budget !== null) budget--;
    } catch (e) {
      errors.push(`${l.email}: ${(e as Error).message}`);
    }
  }

  if (sent > 0) {
    await supabase.rpc("consume_usage", { p_org_id: org.id, p_metric: "emails", p_amount: sent });
  }

  return { org: org.slug, candidates: leads?.length ?? 0, sent, errors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // ── unsubscribe ───────────────────────────────────────────────────────────
  // Kept ahead of the cron check: the recipient clicking this link has no
  // secret, and must never be told "unauthorized" for trying to opt out.
  const url = new URL(req.url);
  const unsub = url.searchParams.get("unsub");
  if (unsub) {
    // Telling someone they are unsubscribed when they are not is the one bug
    // here with legal weight. .select() makes the update report which rows it
    // actually changed, so a stale token cannot render a false confirmation.
    const { data: optedOut, error: unsubErr } = await supabase
      .from("leads")
      .update({ nurture_opted_out: true })
      .eq("nurture_token", unsub)
      .select("id");

    const page = (title: string, body: string, status: number) =>
      new Response(
        `<html><body style="font-family:sans-serif;text-align:center;padding:60px">` +
        `<h2>${title}</h2><p>${body}</p></body></html>`,
        { status, headers: { "Content-Type": "text/html" } },
      );

    if (unsubErr) {
      console.error("nurture: unsubscribe FAILED for token", unsub, unsubErr.message);
      return page(
        "We couldn't process that just now",
        "Please email contact@mnbresearch.com and we will remove you straight away. " +
        "We are sorry for the trouble.",
        500,
      );
    }
    if (!optedOut?.length) {
      return page(
        "You're not on this list",
        "That link has already been used, or the address is no longer subscribed. " +
        "If you are still receiving email, contact us at contact@mnbresearch.com.",
        200,
      );
    }
    return page(
      "You're unsubscribed",
      "You won't receive more follow-up emails. You can still reach us anytime at contact@mnbresearch.com.",
      200,
    );
  }

  // ── the scheduled run ─────────────────────────────────────────────────────
  const cronAuth = requireCronSecret(req, CORS);
  if (!cronAuth.ok) return cronAuth.response!;

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let slug: string | null = null;
  try {
    const body = await req.json();
    if (body?.org && typeof body.org === "string") slug = body.org;
  } catch { /* empty body is the normal cron case */ }

  // No org named = every org. This replaces the old default of 'abrobot',
  // which silently made a multi-tenant cron job a single-tenant one: every
  // other customer's follow-up simply never ran.
  let orgs: { id: string; name: string; slug: string }[];
  if (slug) {
    const { data } = await supabase.from("organizations")
      .select("id, name, slug").eq("slug", slug).maybeSingle();
    if (!data) return json({ error: "org not found" }, 404);
    orgs = [data];
  } else {
    const { data, error } = await supabase.from("organizations")
      .select("id, name, slug").eq("active", true).limit(ORGS_PER_RUN);
    if (error) return json({ error: error.message }, 500);
    orgs = data ?? [];
  }

  const results = [];
  for (const org of orgs) {
    try {
      results.push(await runOrg(org));
    } catch (e) {
      // One tenant's misconfiguration must not stop the others' follow-up.
      console.error(`nurture: org ${org.slug} threw:`, e);
      results.push({ org: org.slug, error: (e as Error).message, sent: 0 });
    }
  }

  const sent = results.reduce((n, r) => n + (r.sent ?? 0), 0);
  return json({ ok: true, orgs: results.length, sent, results });
});
