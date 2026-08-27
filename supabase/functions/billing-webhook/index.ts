// AbroBot CRM — Cashfree webhook. The ONLY thing that grants a paid plan.
//
// Deploy:  supabase functions deploy billing-webhook --no-verify-jwt
//          (Cashfree cannot send a Supabase JWT; the HMAC signature is the auth)
//
// Register in Cashfree → Developers → Webhooks:
//   https://<project>.supabase.co/functions/v1/billing-webhook
//   Events: PAYMENT_SUCCESS_WEBHOOK, PAYMENT_FAILED_WEBHOOK,
//           PAYMENT_USER_DROPPED_WEBHOOK
//
// ── Why the return page grants nothing ──────────────────────────────────────
// The page a customer lands on after paying is attacker-controllable — anyone
// can open /settings?billing=return&order_id=anything. If that granted plans,
// the product would be free to anyone who read a URL. So this endpoint, with a
// verified HMAC, is the only path that upgrades an organisation.
//
// Properties that matter here:
//   * fails CLOSED — no secret configured means every webhook is rejected
//   * exact raw bytes are verified, never re-serialised JSON
//   * 5-minute replay window
//   * constant-time signature comparison
//   * idempotent — Cashfree retries, and a retry must not extend a plan twice
//   * always 200 on a *handled* event, so Cashfree stops retrying; 4xx only
//     when the request is genuinely not from Cashfree

import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyWebhook } from "../_shared/cashfree.ts";
import { notifyNewLead } from "../_shared/notify.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Raw bytes, before any parsing. Re-serialising breaks the signature.
  const rawBody = await req.text();

  const verified = await verifyWebhook(
    rawBody,
    req.headers.get("x-webhook-signature"),
    req.headers.get("x-webhook-timestamp"),
  );

  if (!verified.ok) {
    // 401, not 200: this did not come from Cashfree, or the secret is wrong.
    console.error("webhook rejected:", verified.reason);
    return json({ error: "unauthorised", reason: verified.reason }, 401);
  }

  const event = verified.event;
  const type: string = event?.type ?? "";
  const order = event?.data?.order ?? {};
  const payment = event?.data?.payment ?? {};
  const orderId: string | undefined = order?.order_id;

  if (!orderId) {
    console.error("webhook had no order_id:", JSON.stringify(event).slice(0, 300));
    return json({ received: true, ignored: "no order_id" });
  }

  const { data: row } = await admin.from("payments")
    .select("id, org_id, plan, status, period_months").eq("order_id", orderId).maybeSingle();

  if (!row) {
    // An order we never created. Acknowledge so Cashfree stops retrying, but
    // log loudly — it means either a stale test or someone probing.
    console.error("webhook for unknown order:", orderId);
    return json({ received: true, ignored: "unknown order" });
  }

  // Idempotency: Cashfree retries until it gets a 2xx. Once an order is paid,
  // further deliveries must not extend the subscription again.
  if (row.status === "paid") {
    return json({ received: true, already: "paid" });
  }

  const isSuccess = /PAYMENT_SUCCESS/i.test(type) || payment?.payment_status === "SUCCESS";
  const isFailed = /PAYMENT_FAILED/i.test(type) || payment?.payment_status === "FAILED";
  const isDropped = /USER_DROPPED/i.test(type) || payment?.payment_status === "USER_DROPPED";

  const status = isSuccess ? "paid" : isFailed ? "failed" : isDropped ? "dropped" : null;
  if (!status) {
    return json({ received: true, ignored: `unhandled type ${type}` });
  }

  const { error: upErr } = await admin.from("payments").update({
    status,
    raw: event,
    paid_at: isSuccess ? new Date().toISOString() : null,
    cf_order_id: order?.cf_order_id ?? undefined,
  }).eq("id", row.id);

  if (upErr) {
    // 500 so Cashfree retries — we do not want to lose a successful payment
    // because of a transient database error.
    console.error("could not update payment:", upErr.message);
    return json({ error: "could not record payment" }, 500);
  }

  if (!isSuccess) {
    return json({ received: true, status });
  }

  // Grant the plan. Runs in Postgres so the entitlement change is atomic.
  const { data: granted, error: grantErr } = await admin
    .rpc("grant_plan_from_payment", { p_payment_id: row.id });

  if (grantErr) {
    console.error("PAYMENT TAKEN BUT PLAN NOT GRANTED", orderId, grantErr.message);
    // 500 → Cashfree retries → the grant is attempted again. The payment row
    // is already 'paid', and grant_plan_from_payment is safe to repeat.
    return json({ error: "granted failed" }, 500);
  }

  // Best-effort operator alert. Never let this fail the webhook.
  try {
    await notifyNewLead(admin, row.org_id, {
      id: "billing",
      name: `💰 Payment received — ${row.plan}`,
      message: `Order ${orderId}\nAmount ${order?.order_amount ?? "?"} ${order?.order_currency ?? "INR"}`,
    });
  } catch (_e) { /* ignore */ }

  console.log("plan granted:", orderId, JSON.stringify(granted));
  return json({ received: true, status: "paid", granted });
});
