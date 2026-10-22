import { fetchWithTimeout } from "./http.ts";
// AbroBot CRM — Cashfree Payment Gateway client.
//
// Ported from the AuditFlow implementation in this workspace, keeping its
// security properties. Credentials live in Supabase function secrets and are
// read only here, server-side:
//
//   CASHFREE_APP_ID
//   CASHFREE_SECRET_KEY
//   CASHFREE_ENV          "production" | "sandbox"  (no default — see below)
//
// They are never sent to the browser and never stored in the database.

const API_VERSION = "2023-08-01";

export interface Creds { appId: string; secret: string }

/**
 * Environment. Deliberately has NO default.
 *
 * Defaulting to sandbox means real customers pay into a test account and you
 * find out from an angry email. Defaulting to production means test runs take
 * real money. Both are worse than refusing to start.
 */
export function cashfreeEnv(): "production" | "sandbox" | null {
  const v = (Deno.env.get("CASHFREE_ENV") ?? "").trim().toLowerCase();
  if (v === "production" || v === "sandbox") return v;
  return null;
}

export function credentials(): Creds | null {
  const appId = (Deno.env.get("CASHFREE_APP_ID") ?? "").trim();
  const secret = (Deno.env.get("CASHFREE_SECRET_KEY") ?? "").trim();
  if (!appId || !secret) return null;
  return { appId, secret };
}

export function isConfigured(): boolean {
  return credentials() !== null && cashfreeEnv() !== null;
}

// Explicit per environment. This used to be `production ? api : sandbox`, so
// an unset or misspelt CASHFREE_ENV silently meant sandbox — and fetchOrder,
// which (unlike createOrder) never checked the env, asked the SANDBOX about
// PRODUCTION orders, got a 404, and reported "could not confirm". Callers now
// pass an env they have already validated.
function baseUrl(env: "production" | "sandbox"): string {
  return env === "production"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";
}

export interface CreateOrderInput {
  orderId: string;
  amount: number;
  currency?: string;
  customer: { id: string; email?: string | null; phone?: string | null; name?: string | null };
  returnUrl: string;
  notifyUrl?: string;
  note?: string;
}

export interface CreateOrderResult {
  ok: true;
  paymentSessionId: string;
  cfOrderId: string;
  env: "production" | "sandbox";
}
export interface CashfreeFailure { ok: false; status: number; message: string; code?: string }

/** Create an order and return the session id the checkout SDK needs. */
export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult | CashfreeFailure> {
  const creds = credentials();
  const env = cashfreeEnv();
  if (!creds || !env) {
    return { ok: false, status: 503, message: "Payment gateway is not configured", code: "NOT_CONFIGURED" };
  }

  // Cashfree requires a phone number. A blank one fails with an opaque error,
  // so send a documented placeholder rather than an empty string.
  const phone = (input.customer.phone ?? "").replace(/[^\d]/g, "").slice(-10) || "9999999999";

  try {
    const res = await fetchWithTimeout(`${baseUrl(env)}/orders`, {
      method: "POST",
      headers: {
        "x-api-version": API_VERSION,
        "x-client-id": creds.appId,
        "x-client-secret": creds.secret,
        "Content-Type": "application/json",
        "x-request-id": crypto.randomUUID(),
        // Same key never charges twice — makes a retry safe.
        "x-idempotency-key": input.orderId,
      },
      body: JSON.stringify({
        order_id: input.orderId,
        order_amount: Number(input.amount.toFixed(2)),
        order_currency: input.currency ?? "INR",
        customer_details: {
          customer_id: input.customer.id,
          customer_email: input.customer.email ?? undefined,
          customer_phone: phone,
          customer_name: input.customer.name ?? undefined,
        },
        order_meta: {
          return_url: input.returnUrl,
          notify_url: input.notifyUrl,
        },
        order_note: input.note,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        message: data?.message ?? `Cashfree returned ${res.status}`,
        code: data?.code,
      };
    }
    if (!data?.payment_session_id) {
      return { ok: false, status: 502, message: "Cashfree did not return a payment session" };
    }
    return {
      ok: true,
      paymentSessionId: data.payment_session_id,
      cfOrderId: data.cf_order_id ?? input.orderId,
      env,
    };
  } catch (e) {
    return { ok: false, status: 502, message: `Could not reach Cashfree: ${(e as Error).message}` };
  }
}

/**
 * Ask Cashfree the truth about an order. Returns null when it cannot answer.
 *
 * Fails CLOSED on a missing or unrecognised CASHFREE_ENV, with the reason
 * logged, rather than querying the sandbox about production orders.
 */
export async function fetchOrder(orderId: string): Promise<Record<string, unknown> | null> {
  const creds = credentials();
  const env = cashfreeEnv();
  if (!creds) {
    console.error("cashfree fetchOrder: CASHFREE_APP_ID / CASHFREE_SECRET_KEY not set — not queried:", orderId);
    return null;
  }
  if (!env) {
    console.error(
      "cashfree fetchOrder: CASHFREE_ENV is not 'production' or 'sandbox' — refusing to guess which gateway holds",
      orderId,
    );
    return null;
  }
  try {
    const res = await fetchWithTimeout(`${baseUrl(env)}/orders/${encodeURIComponent(orderId)}`, {
      headers: {
        "x-api-version": API_VERSION,
        "x-client-id": creds.appId,
        "x-client-secret": creds.secret,
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Amount / currency reconciliation (pure) ─────────────────────────────────
//
// Moved here from billing-webhook so checkout-recovery's lost-webhook
// reconciler asks exactly the same question before granting a plan.
//
// The HMAC proves the event came from Cashfree. It proves NOTHING about how
// much was paid. order_amount and order_currency were stored in `raw` and never
// looked at, so the only question that mattered — "did this person pay what
// this order is for?" — was never asked.
//
// Two ways that bites, both reachable without forging anything:
//   * a partially-paid order: payments.amount is ₹49,990 for annual Business,
//     the gateway reports order_amount 4,999.00, and the old code granted the
//     full twelve months anyway;
//   * a reused order_id: an order row created for ₹49,990 collects a genuine
//     signature-valid success event for a ₹999 Starter charge.
//
// Returns `absent` rather than throwing when the payload carries no amount at
// all, because the call sites want different things from that case.

// Money arrives as a JSON number from Cashfree and as numeric(12,2) from
// Postgres (PostgREST may hand it back as a string). Everything that compares
// two amounts goes through here so "49990" and 49990.00 cannot disagree.
export const toAmount = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// One paisa. amount is numeric(12,2), and the gateway rounds to two decimals
// too, so anything larger than this is a real difference, not float noise.
export const AMOUNT_EPSILON = 0.01;

export type Reconciliation =
  | { ok: true; absent: boolean }
  | { ok: false; absent: false; reason: string; gateway: string; recorded: string };

// deno-lint-ignore no-explicit-any
export function reconcile(order: any, payment: any, row: { amount: unknown; currency: unknown }): Reconciliation {
  const recorded = toAmount(row.amount);

  // ── Take the LOWEST amount the payload reports, not the first one ────────
  //
  // `order_amount ?? payment_amount` defeated both scenarios in the comment
  // above, because in each of them `order_amount` is the amount the order was
  // CREATED for — which equals `payments.amount` by construction — while
  // `payment_amount` is what was actually captured. A partially-paid order
  // reports order_amount 49,990 and payment_amount 4,999; preferring the
  // former reconciles cleanly and grants the plan.
  //
  // `payment_amount` is the money that actually moved, so it is the one that
  // must clear the bar. Taking the minimum of whatever is present is stricter
  // than either alone and does not depend on getting the field precedence
  // right, which is the part that was wrong.
  const orderAmt = toAmount(order?.order_amount);
  const paidAmt = toAmount(payment?.payment_amount);
  const present = [orderAmt, paidAmt].filter((v): v is number => v !== null);
  const gateway = present.length ? Math.min(...present) : null;

  if (gateway === null) {
    return { ok: true, absent: true };
  }
  if (recorded === null) {
    // Our own row has no amount to compare against. Nothing to check, and
    // refusing here would strand a customer over our own bad data.
    return { ok: true, absent: true };
  }

  // "At least", not "equal": overpayment is the customer's loss to reclaim
  // through support, and blocking it would hold up a plan they have paid for.
  if (gateway + AMOUNT_EPSILON < recorded) {
    return {
      ok: false, absent: false, reason: "amount underpaid",
      gateway: String(gateway), recorded: String(recorded),
    };
  }

  // Currency is compared only when the payload states one. An amount check
  // already catches the realistic attack (₹999 against a ₹49,990 order); a
  // payload that omits the currency entirely is a shape change, not a swap,
  // and hard-failing on it would block legitimate grants.
  const gatewayCur = String(order?.order_currency ?? payment?.payment_currency ?? "").trim().toUpperCase();
  const recordedCur = String(row.currency ?? "").trim().toUpperCase();
  if (gatewayCur && recordedCur && gatewayCur !== recordedCur) {
    return {
      ok: false, absent: false, reason: "currency mismatch",
      gateway: gatewayCur, recorded: recordedCur,
    };
  }
  if (!gatewayCur) {
    console.warn("cashfree reconcile: payload carried no currency; reconciled on amount only");
  }

  return { ok: true, absent: false };
}

// ── webhook verification ────────────────────────────────────────────────────

/**
 * Reject webhooks older than this.
 *
 * 15 minutes, not the more common 5.
 *
 * Cashfree reuses the ORIGINAL timestamp when it retries a failed delivery.
 * Observed on order abcrm_abrobot_starter_1787812523559: event_time 12:06:10,
 * retries at 12:06, 12:07, 12:09 and 12:14 — all carrying the 12:06 timestamp.
 * A 5-minute window silently rejects the later retries, so a transient failure
 * (a brief outage, a secret mid-rotation) becomes a permanently lost payment
 * even after the underlying problem is fixed.
 *
 * Widening this does not weaken us much: replay protection here is really
 * provided by idempotency — an order already marked 'paid' is never granted
 * twice, regardless of how many times a captured request is replayed. The
 * timestamp check is a second line of defence, not the only one.
 */
const MAX_WEBHOOK_AGE_SECONDS = 15 * 60;

export type Verification =
  | { ok: true; event: Record<string, any> }   // deno-lint-ignore no-explicit-any
  | { ok: false; reason: string };

/** Constant-time comparison — a fast-exit compare leaks the signature byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/**
 * Verify a Cashfree webhook.
 *
 * Signature is base64(HMAC-SHA256(timestamp + rawBody, secret)).
 *
 * `rawBody` MUST be the exact bytes received. Re-serialising parsed JSON
 * changes whitespace and key order, and the signature will never match.
 *
 * Fails CLOSED: an unset secret rejects every webhook rather than accepting
 * forged ones. A payment webhook that can be forged is a way to get a paid
 * plan for free — this is the single most security-sensitive function in the
 * codebase.
 */
export async function verifyWebhook(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
): Promise<Verification> {
  const creds = credentials();
  if (!creds) return { ok: false, reason: "Payment gateway not configured" };
  if (!signature) return { ok: false, reason: "Missing x-webhook-signature" };
  if (!timestamp) return { ok: false, reason: "Missing x-webhook-timestamp" };

  const tsRaw = Number(timestamp);
  if (!Number.isFinite(tsRaw)) return { ok: false, reason: "Malformed timestamp" };

  // Cashfree sends x-webhook-timestamp in epoch MILLISECONDS (13 digits),
  // e.g. "1787814895250" — not seconds.
  //
  // Comparing that against Date.now()/1000 made every real webhook look ~1.79
  // trillion seconds old, so all of them were rejected on the age check before
  // the signature was ever compared. Live payments 401'd while hand-built test
  // requests passed, because those were generated with `date +%s` — seconds.
  // The test harness was hiding the bug.
  //
  // Normalise by magnitude rather than assuming a unit: anything past ~1973 in
  // seconds (1e11) must be milliseconds.
  const tsSeconds = Math.abs(tsRaw) > 1e11 ? tsRaw / 1000 : tsRaw;

  if (Math.abs(Date.now() / 1000 - tsSeconds) > MAX_WEBHOOK_AGE_SECONDS) {
    return { ok: false, reason: `Timestamp outside the ${MAX_WEBHOOK_AGE_SECONDS}s window` };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(creds.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp + rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

  if (!timingSafeEqual(expected, signature)) {
    return { ok: false, reason: "Signature mismatch" };
  }

  try {
    return { ok: true, event: JSON.parse(rawBody) };
  } catch {
    return { ok: false, reason: "Body is not valid JSON" };
  }
}
