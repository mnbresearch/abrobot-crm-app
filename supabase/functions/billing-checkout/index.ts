// AbroBot CRM — start a Cashfree checkout.
// Deploy:  supabase functions deploy billing-checkout   (KEEP Verify JWT ON)
//
// POST { plan: "growth" | "business" | "starter", months?: 1 | 12 }
//  -> { payment_session_id, order_id, env, amount }
//
// The caller must be a signed-in ORG ADMIN. Two reasons this is not open:
// it spends money, and the order carries the org id that a successful payment
// will upgrade. A counsellor should not be able to start either.
//
// Note what this function does NOT do: it never marks anything paid. It
// creates an order and hands back a session id. Only the signature-verified
// webhook grants a plan.

import { createClient } from "npm:@supabase/supabase-js@2";
import { createOrder, isConfigured, cashfreeEnv } from "../_shared/cashfree.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SITE = Deno.env.get("CRM_BASE_URL") || "https://crm.mnbresearch.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  if (!isConfigured()) {
    return json({
      error: "Payments are not configured",
      detail: "Set CASHFREE_APP_ID, CASHFREE_SECRET_KEY and CASHFREE_ENV as function secrets.",
    }, 503);
  }

  // --- authenticate ---
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing auth" }, 401);
  const { data: userData, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !userData?.user) return json({ error: "invalid session" }, 401);

  const { data: profile } = await admin.from("profiles")
    .select("id, org_id, role, status, full_name, email").eq("id", userData.user.id).single();

  if (!profile || profile.status !== "active" || !profile.org_id) {
    return json({ error: "not an active member" }, 403);
  }
  if (!["org_admin", "super_admin"].includes(profile.role)) {
    return json({ error: "only an admin can start a payment" }, 403);
  }

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  const plan = String(body?.plan ?? "").trim();
  const months = Number(body?.months) === 12 ? 12 : 1;
  if (!plan) return json({ error: "plan is required" }, 400);

  // Price comes from the database, never from the request. A client-supplied
  // amount is a client-supplied discount.
  const { data: planRow } = await admin.from("plan_limits")
    .select("plan, label, price_inr").eq("plan", plan).maybeSingle();

  if (!planRow) return json({ error: `unknown plan: ${plan}` }, 400);
  if (!planRow.price_inr || planRow.price_inr <= 0) {
    return json({ error: `${planRow.label} is not a paid plan` }, 400);
  }

  // 12 months billed as 10 — the discount lives here, server-side.
  const amount = months === 12 ? planRow.price_inr * 10 : planRow.price_inr;

  const { data: org } = await admin.from("organizations")
    .select("id, name, slug").eq("id", profile.org_id).single();
  if (!org) return json({ error: "organisation not found" }, 404);

  const orderId = `abcrm_${org.slug}_${plan}_${Date.now()}`;

  const result = await createOrder({
    orderId,
    amount,
    customer: {
      id: profile.id,
      email: profile.email,
      phone: null,
      name: profile.full_name ?? org.name,
    },
    returnUrl: `${SITE}/settings?billing=return&order_id=${orderId}`,
    notifyUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/billing-webhook`,
    note: `${planRow.label} · ${months} month(s) · ${org.name}`,
  });

  if (!result.ok) {
    console.error("cashfree createOrder failed:", result.status, result.message);
    return json({ error: result.message, code: result.code }, result.status);
  }

  // Record the intent. Status stays 'created' until the webhook says otherwise.
  const { error: insErr } = await admin.from("payments").insert({
    org_id: org.id,
    order_id: orderId,
    cf_order_id: result.cfOrderId,
    plan,
    amount,
    period_months: months,
    status: "created",
    customer_email: profile.email,
    created_by: profile.id,
  });
  if (insErr) {
    console.error("could not record payment intent:", insErr.message);
    return json({ error: "could not start checkout" }, 500);
  }

  return json({
    ok: true,
    payment_session_id: result.paymentSessionId,
    order_id: orderId,
    env: cashfreeEnv(),
    amount,
    currency: "INR",
    plan_label: planRow.label,
  });
});
