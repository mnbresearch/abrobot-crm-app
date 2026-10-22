// AbroBot CRM — Resend webhook receiver: hard bounces and spam complaints.
//
// Without this, an address that hard-bounced or marked us as spam kept getting
// nurture and recovery mail, which is what gets a sending domain throttled.
//
// Setup:
//   1. Deploy:  supabase functions deploy resend-events --no-verify-jwt
//      (Resend cannot send a Supabase JWT; the Svix signature is the auth)
//   2. Resend dashboard → Webhooks → Add endpoint:
//        https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/resend-events
//      Events: email.bounced, email.complained
//   3. Copy the endpoint's signing secret (whsec_...) into the Supabase secret
//        supabase secrets set RESEND_WEBHOOK_SECRET=whsec_...
//
// For every recipient of a hard bounce / complaint:
//   * insert into platform_email_suppressions (reason 'bounced'|'complained',
//     source 'resend-webhook'); an existing row is left as it is
//   * set leads.nurture_opted_out = true for every lead with that address, in
//     every organisation — a dead or complaining mailbox is a property of the
//     address, not of the tenant that happened to send to it
//
// Properties:
//   * fails CLOSED — RESEND_WEBHOOK_SECRET unset → 503, nothing touched
//   * signature over the exact raw body, ±5 min timestamp window (_shared/svix.ts)
//   * idempotent — a replayed svix-id re-applies the same no-op writes
//   * 200 for handled and ignored events; 500 on a database error so Svix
//     retries; 401 when the request is not from Resend

import { createClient } from "npm:@supabase/supabase-js@2";
import { classifyResendEvent, verifySvix } from "../_shared/svix.ts";

const MAX_BODY_BYTES = 256 * 1024;
const PAGE = 500;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type Admin = any;

/** LIKE metacharacters escaped, so ilike behaves as case-insensitive equality
 *  for `%`, `_` and `\`. PostgREST also treats `*` as a wildcard and offers no
 *  escape for it, so every candidate is re-checked exactly before updating. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

async function optOutLeads(admin: Admin, address: string): Promise<number> {
  const ids: string[] = [];
  let after: string | null = null;
  for (;;) {
    let q = admin
      .from("leads")
      .select("id, email")
      .ilike("email", likeEscape(address))
      .eq("nurture_opted_out", false)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (after) q = q.gt("id", after);
    const { data, error } = await q;
    if (error) throw new Error(`leads lookup: ${error.message}`);
    const rows = (data ?? []) as { id: string; email: string | null }[];
    for (const r of rows) {
      if ((r.email ?? "").trim().toLowerCase() === address) ids.push(r.id);
    }
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1].id;
  }

  let updated = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin
      .from("leads")
      .update({ nurture_opted_out: true })
      .in("id", ids.slice(i, i + 200))
      .eq("nurture_opted_out", false)
      .select("id");
    if (error) throw new Error(`leads update: ${error.message}`);
    updated += (data ?? []).length;
  }
  return updated;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (!secret) {
    console.error("resend-events: RESEND_WEBHOOK_SECRET is not set — rejecting");
    return json({ error: "Webhook not configured" }, 503);
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json({ error: "Payload too large" }, 413);
  const body = await req.text();
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    return json({ error: "Payload too large" }, 413);
  }

  const svixId = req.headers.get("svix-id");
  const v = await verifySvix({
    secret,
    id: svixId,
    timestamp: req.headers.get("svix-timestamp"),
    signature: req.headers.get("svix-signature"),
    body,
  });
  if (!v.ok) {
    console.warn(`resend-events: rejected (${v.reason})`);
    return json({ error: "Invalid signature" }, 401);
  }

  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return json({ error: "Body is not valid JSON" }, 400);
  }

  const action = classifyResendEvent(event);
  if (action.action === "ignore") {
    console.log(`resend-events: ${svixId} ignored (${action.why})`);
    return json({ ok: true, ignored: action.why });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const { data: inserted, error: supErr } = await admin
      .from("platform_email_suppressions")
      .upsert(
        action.recipients.map((email) => ({ email, reason: action.reason, source: "resend-webhook" })),
        { onConflict: "email", ignoreDuplicates: true },
      )
      .select("email");
    if (supErr) throw new Error(`suppressions upsert: ${supErr.message}`);

    let leadsOptedOut = 0;
    for (const address of action.recipients) leadsOptedOut += await optOutLeads(admin, address);

    const suppressed = (inserted ?? []).length;
    console.log(
      `resend-events: ${svixId} ${action.reason} recipients=${action.recipients.length} ` +
        `new_suppressions=${suppressed} leads_opted_out=${leadsOptedOut}`,
    );
    return json({
      ok: true,
      reason: action.reason,
      recipients: action.recipients.length,
      new_suppressions: suppressed,
      leads_opted_out: leadsOptedOut,
    });
  } catch (e) {
    // Non-2xx makes Svix retry; every write above is idempotent.
    console.error(`resend-events: ${svixId} failed: ${(e as Error).message}`);
    return json({ error: "Temporary failure" }, 500);
  }
});
