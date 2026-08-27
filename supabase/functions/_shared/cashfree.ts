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

function baseUrl(): string {
  return cashfreeEnv() === "production"
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
    const res = await fetch(`${baseUrl()}/orders`, {
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

/** Ask Cashfree the truth about an order. Used to confirm the return page. */
export async function fetchOrder(orderId: string): Promise<Record<string, unknown> | null> {
  const creds = credentials();
  if (!creds) return null;
  try {
    const res = await fetch(`${baseUrl()}/orders/${encodeURIComponent(orderId)}`, {
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

// ── webhook verification ────────────────────────────────────────────────────

/** Reject webhooks older than this — limits replay of a captured request. */
const MAX_WEBHOOK_AGE_SECONDS = 5 * 60;

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

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "Malformed timestamp" };
  if (Math.abs(Date.now() / 1000 - ts) > MAX_WEBHOOK_AGE_SECONDS) {
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
