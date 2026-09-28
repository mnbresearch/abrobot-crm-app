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

// Money arrives as a JSON number from Cashfree and as numeric(12,2) from
// Postgres (PostgREST may hand it back as a string). Everything that compares
// two amounts goes through here so "49990" and 49990.00 cannot disagree.
const toAmount = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// One paisa. amount is numeric(12,2), and the gateway rounds to two decimals
// too, so anything larger than this is a real difference, not float noise.
const AMOUNT_EPSILON = 0.01;

// ── Dispute outcomes ────────────────────────────────────────────────────────
//
// Cashfree emits a dispute webhook at creation AND at every transition, so the
// event type alone says nothing about who won. Only these statuses mean the
// money is gone and the plan must go with it.
const DISPUTE_LOST = new Set([
  "DISPUTE_LOST", "DISPUTE_MERCHANT_LOST", "MERCHANT_LOST", "LOST",
  "CHARGEBACK_LOST", "DISPUTE_ACCEPTED", "CHARGEBACK_ACCEPTED", "ACCEPTED",
  "MERCHANT_ACCEPTED", "DISPUTE_CLOSED_CUSTOMER_FAVOUR",
  "DISPUTE_CLOSED_CUSTOMER_FAVOR", "CUSTOMER_FAVOUR", "CUSTOMER_FAVOR",
]);

// Recognised statuses that must NOT revoke: the dispute is open, or it closed
// our way. A merchant-won dispute means we kept the money — revoking there
// takes a paying customer's plan away over a complaint they lost.
const DISPUTE_OPEN_OR_WON = new Set([
  "DISPUTE_CREATED", "CREATED", "DISPUTE_DOCS_RECEIVED", "DOCS_RECEIVED",
  "DISPUTE_DOCS_SUBMITTED", "DOCS_SUBMITTED", "DISPUTE_UNDER_REVIEW",
  "UNDER_REVIEW", "DISPUTE_MERCHANT_WON", "MERCHANT_WON", "WON",
  "DISPUTE_CLOSED_MERCHANT_FAVOUR", "DISPUTE_CLOSED_MERCHANT_FAVOR",
  "DISPUTE_CANCELLED", "CANCELLED", "DISPUTE_CLOSED", "CLOSED",
]);

// ── Amount / currency reconciliation ────────────────────────────────────────
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
// all, because the two call sites want different things from that case.
type Reconciliation =
  | { ok: true; absent: boolean }
  | { ok: false; absent: false; reason: string; gateway: string; recorded: string };

// deno-lint-ignore no-explicit-any
function reconcile(order: any, payment: any, row: { amount: unknown; currency: unknown }): Reconciliation {
  const recorded = toAmount(row.amount);

  // ── Take the LOWEST amount the payload reports, not the first one ────────
  //
  // `order_amount ?? payment_amount` defeated both scenarios in the comment
  // above, because in each of them `order_amount` is the amount the order was
  // CREATED for — which equals `payments.amount` by construction — while
  // `payment_amount` is what was actually captured. A partially-paid order
  // reports order_amount 49,990 and payment_amount 4,999; preferring the
  // former reconciles cleanly and grants the plan. The check passed its own
  // worked example.
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
    console.warn("billing-webhook: payload carried no currency; reconciled on amount only");
  }

  return { ok: true, absent: false };
}

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
    //
    // The reason is logged (visible in the function logs) but NOT returned in
    // the body beyond a short label. A temporary diagnostic block lived here
    // while debugging the millisecond-timestamp bug; it reported the secret's
    // length and digest prefixes, which is fine for an afternoon and wrong to
    // leave in a public endpoint's response.
    //
    // If this ever needs debugging again: read the logged line below rather
    // than widening the response.
    console.error(
      "webhook rejected:", verified.reason,
      "| ts:", req.headers.get("x-webhook-timestamp"),
      "| body_bytes:", rawBody.length,
    );
    return json({ error: "unauthorised" }, 401);
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

  // amount/currency are read so the grant can be reconciled against what the
  // gateway says was actually collected; revoked_at so an already-reversed
  // payment can never be granted by a later retry.
  const { data: row, error: lookupErr } = await admin.from("payments")
    .select("id, org_id, plan, status, period_months, granted_at, amount, currency, revoked_at")
    .eq("order_id", orderId).maybeSingle();

  // A failed lookup is NOT an unknown order. The error used to be discarded,
  // so one transient database blip fell through to the 200 below — Cashfree
  // marks the webhook delivered, stops retrying, and the customer has paid for
  // a plan that will never be granted, permanently and silently.
  // 500 keeps the retry alive, which is the entire safety net here.
  if (lookupErr) {
    console.error("billing-webhook: payments lookup failed for", orderId, lookupErr.message);
    return json({ error: "lookup failed, please retry" }, 500);
  }

  if (!row) {
    // An order we never created. Acknowledge so Cashfree stops retrying, but
    // log loudly — it means either a stale test or someone probing.
    console.error("webhook for unknown order:", orderId);
    return json({ received: true, ignored: "unknown order" });
  }

  // ── Refunds, chargebacks and disputes ───────────────────────────────────
  //
  // This MUST come before the idempotency short-circuit below. A refund always
  // arrives for a payment that is already `paid` and already `granted_at`, so
  // the "already granted, return 200" branch would swallow it — which is
  // exactly how the original bug stayed invisible: the webhook answered 200 to
  // every refund event and did nothing.
  //
  // Before this existed there was no refund branch at all, and no dispute
  // branch, and `effective_plan` selected `subscriptions.status` without ever
  // reading it — so even setting the status by hand revoked nothing. Refunding
  // an annual Business order left the customer holding ₹49,990 of plan for
  // twelve months, and "pay → get granted → charge back → keep the plan"
  // worked end to end.
  const isRefund =
    /REFUND/i.test(type) ||
    String(event?.data?.refund?.refund_status ?? "").toUpperCase() === "SUCCESS";
  const isDispute = /DISPUTE|CHARGEBACK/i.test(type);

  if (isRefund || isDispute) {
    // A refund that is still pending must not revoke anything yet.
    const refundStatus = String(event?.data?.refund?.refund_status ?? "").toUpperCase();
    if (isRefund && refundStatus && refundStatus !== "SUCCESS") {
      return json({ received: true, ignored: `refund ${refundStatus}` });
    }

    // ── Which disputes actually revoke ──────────────────────────────────────
    //
    // `isDispute` matched the event TYPE and nothing else, while refunds right
    // above correctly check refund_status. Cashfree sends a dispute webhook
    // when the dispute is raised and again at every transition, so the old test
    // fired on DISPUTE_CREATED — the moment a customer complains, before anyone
    // has looked at it. The customer loses their plan immediately.
    //
    // And there is no way back. revoke_plan_from_payment leaves granted_at set
    // on purpose (it is the compare-and-swap that makes the grant idempotent),
    // so when the merchant WINS the dispute and keeps the money, replaying
    // PAYMENT_SUCCESS returns `already_granted` and grants nothing. The only
    // repair is hand-written SQL against subscriptions and organizations.
    //
    // The status field's exact name is not something we can pin down from the
    // payloads we have, so every plausible shape is checked. The event type is
    // consulted last and only because some deliveries carry the outcome there
    // (DISPUTE_MERCHANT_LOST_WEBHOOK) rather than in a status field.
    if (isDispute && !isRefund) {
      const disputeTokens = [
        String(event?.data?.dispute?.dispute_status ?? ""),
        String(event?.data?.dispute?.status ?? ""),
        String(event?.data?.dispute_status ?? ""),
        String(event?.dispute_status ?? ""),
        type.replace(/_WEBHOOK$/i, ""),
      ].map((s) => s.trim().toUpperCase()).filter(Boolean);

      const lost = disputeTokens.some((t) => DISPUTE_LOST.has(t));
      const recognised = disputeTokens.some((t) => DISPUTE_LOST.has(t) || DISPUTE_OPEN_OR_WON.has(t));

      if (!lost) {
        // Absent or unrecognised status does NOT revoke, deliberately.
        //
        // The two defaults are not symmetrical. Ignoring an event we do not
        // understand costs us a revocation an operator can still perform by
        // hand from the Cashfree dashboard plus one SQL call. Revoking on an
        // event we do not understand silently strips a paying customer of the
        // plan they bought — and because granted_at stays set, nothing in the
        // product can put it back. The day Cashfree renames a field or adds a
        // transition event, the first default logs; the second bills us support
        // tickets from customers who did nothing wrong.
        console.warn(
          "billing-webhook: dispute event NOT revoking for", orderId,
          "| type:", type,
          "| status tokens:", JSON.stringify(disputeTokens),
          recognised ? "| open or won" : "| UNRECOGNISED STATUS — review this payload by hand",
        );
        return json({
          received: true,
          ignored: recognised ? "dispute not lost" : "dispute status unrecognised",
          dispute_status: disputeTokens[0] ?? null,
        });
      }
    }

    const reason = isDispute ? "chargeback" : "refund";

    // ── Partial refunds must not revoke the whole period ────────────────────
    //
    // revoke_plan_from_payment subtracts pay.period_months wholesale — the full
    // inverse of the grant — and the old call passed it nothing but the payment
    // id. So a ₹500 goodwill refund on a ₹49,990 annual Business order removed
    // all twelve months of access. The customer is still 99% paid up and has
    // no product.
    //
    // Proportional revocation (₹500 of ₹49,990 ≈ 3.6 days off the period end)
    // needs the refunded amount pushed down into SQL and the month arithmetic
    // reworked into days. That is deliberately NOT attempted here: this file
    // cannot change the function's signature or its date maths, and half of a
    // proration implemented in TypeScript would be worse than none. Until the
    // SQL side takes an amount, a partial refund is recorded and left for an
    // operator, and only an effectively-full refund revokes.
    //
    // A missing refund_amount still revokes in full. That is the pre-existing
    // behaviour and the right direction: chargeback payloads often carry no
    // refund amount, and there the whole payment is gone.
    if (isRefund) {
      const refunded = toAmount(event?.data?.refund?.refund_amount);
      const paid = toAmount(row.amount);

      if (refunded === null) {
        console.warn(
          "billing-webhook: refund for", orderId,
          "carried no refund_amount — treating as full and revoking the whole period",
        );
      } else if (paid !== null && refunded + AMOUNT_EPSILON < paid) {
        // Record the payload so the partial refund is not invisible. status,
        // granted_at and revoked_at are all left alone: the plan stays live,
        // which is correct — most of the money is still ours.
        const { error: rawErr } = await admin.from("payments")
          .update({ raw: event }).eq("id", row.id);
        if (rawErr) {
          console.error("billing-webhook: could not record partial refund for", orderId, rawErr.message);
        }

        console.warn(
          "PARTIAL REFUND — PLAN LEFT INTACT", orderId,
          "| refunded:", refunded, "of", paid, String(row.currency ?? ""),
          "| shorten the period by hand if that is the intent",
        );
        return json({
          received: true,
          ignored: "partial refund",
          partial: true,
          refund_amount: refunded,
          paid_amount: paid,
          note: "plan not revoked; proportional revocation is not implemented",
        });
      }
    }

    const { data: revoked, error: revokeErr } = await admin
      .rpc("revoke_plan_from_payment", { p_payment_id: row.id, p_reason: reason });

    if (revokeErr) {
      // 500 so Cashfree retries. revoke_plan_from_payment is idempotent — it
      // claims the row with `and revoked_at is null` — so repeating is safe.
      console.error("REFUNDED BUT PLAN NOT REVOKED", orderId, revokeErr.message);
      return json({ error: "revoke failed" }, 500);
    }

    // ── A refund that overtakes the grant ───────────────────────────────────
    //
    // revoke_plan_from_payment claims `where granted_at is not null`, so for a
    // row that is already status='paid' but not yet granted — the webhook 500'd
    // on the grant, or the refund simply landed first — it returns
    // `nothing_to_revoke` and writes NOTHING. The row sits at status='paid',
    // granted_at=null, which is exactly the shape the recovery branch below
    // treats as "money taken, plan owed": the next PAYMENT_SUCCESS retry grants
    // twelve months for ₹49,990 that has already gone back to the customer.
    //
    // So mark it terminal ourselves. status goes to 'refunded' even for a
    // chargeback, because the payment_status enum (20260820090000) has no
    // 'chargeback' value — the distinction is carried by revoke_reason, which
    // is the same trade the SQL function makes. revoked_at is what the guard
    // further down actually reads.
    const revokedJson = revoked as { nothing_to_revoke?: boolean; until?: string } | null;
    if (revokedJson?.nothing_to_revoke === true && !row.granted_at && !row.revoked_at) {
      const { error: termErr } = await admin.from("payments").update({
        status: "refunded",
        revoked_at: new Date().toISOString(),
        revoke_reason: reason,
        raw: event,
      }).eq("id", row.id).is("revoked_at", null);   // idempotent under redelivery

      if (termErr) {
        // 500 so Cashfree retries. Leaving this write unchecked is the whole
        // bug: a payment that looks grantable and is not.
        console.error(
          "REFUND NOT RECORDED — PAYMENT IS STILL GRANTABLE", orderId, termErr.message,
        );
        return json({ error: "could not mark payment reversed" }, 500);
      }
      console.warn(
        "billing-webhook:", reason, "arrived before the grant for", orderId,
        "— payment marked terminal so it can never be granted",
      );
    }

    try {
      await notifyNewLead(admin, row.org_id, {
        id: "billing",
        name: `↩️ ${reason === "chargeback" ? "Chargeback" : "Refund"} — ${row.plan}`,
        message: `Order ${orderId}\nAccess now ends ${
          (revoked as { until?: string } | null)?.until ?? "immediately"
        }`,
      });
    } catch (_e) { /* an alert must never fail the webhook */ }

    console.log("plan revoked:", orderId, reason, JSON.stringify(revoked));
    return json({ received: true, status: reason, revoked });
  }

  // ── Never grant a payment that has been reversed ──────────────────────────
  //
  // Marking the row terminal above only helps if something reads it. Without
  // this, a payment refunded before it was granted comes back as
  // status='refunded', granted_at=null, falls past both idempotency checks
  // (they test status==='paid'), reaches the success path, is written back to
  // status='paid' and is granted — the money returned, the plan handed over.
  if (row.revoked_at) {
    console.warn(
      "billing-webhook: ignoring", type || "event", "for reversed payment", orderId,
      "| revoked_at:", row.revoked_at,
    );
    return json({ received: true, ignored: "payment already reversed" });
  }

  // Idempotency: Cashfree retries until it gets a 2xx.
  //
  // This used to short-circuit on `status === "paid"` alone, which quietly
  // created the worst bug in the product: the payment row is marked paid
  // BEFORE grant_plan_from_payment runs, so if the grant failed we returned
  // 500 to force a retry — and the retry hit this line first, saw "paid",
  // returned 200, and Cashfree stopped retrying. Money taken, plan never
  // granted, no further attempt, and the only trace a console line.
  //
  // The correct marker is granted_at, not status. grant_plan_from_payment
  // claims it with a compare-and-swap (`and granted_at is null`), so calling
  // it again after a failure is safe and calling it twice concurrently is a
  // no-op for the loser. Short-circuit only when the work is genuinely done.
  if (row.status === "paid" && row.granted_at) {
    return json({ received: true, already: "granted" });
  }
  if (row.status === "paid" && !row.granted_at) {
    console.warn("billing-webhook: payment", orderId, "is paid but ungranted — retrying the grant");

    // Reconcile here too, but tolerate an absent amount. Unlike the fresh
    // grant below, this row was already marked paid by an earlier verified
    // event, and the retry may be a redelivery whose payload no longer carries
    // the order block. A stated amount that is too small is still refused.
    const recheck = reconcile(order, payment, row);
    if (!recheck.ok) {
      console.error(
        "AMOUNT MISMATCH ON RECOVERY — NOT GRANTING", orderId,
        "| gateway:", recheck.gateway, "| recorded:", recheck.recorded, "|", recheck.reason,
      );
      return json({ error: `not granted: ${recheck.reason}`, gateway: recheck.gateway, recorded: recheck.recorded }, 409);
    }
    if (recheck.absent) {
      console.warn("billing-webhook: recovery grant for", orderId, "could not be reconciled — payload carried no amount");
    }

    const { error: retryErr } = await admin
      .rpc("grant_plan_from_payment", { p_payment_id: row.id });
    if (retryErr) {
      console.error("PAYMENT TAKEN BUT PLAN NOT GRANTED", orderId, retryErr.message);
      return json({ error: "grant failed" }, 500);   // 500 → Cashfree retries → we get here again
    }
    return json({ received: true, recovered: true });
  }

  const isSuccess = /PAYMENT_SUCCESS/i.test(type) || payment?.payment_status === "SUCCESS";
  const isFailed = /PAYMENT_FAILED/i.test(type) || payment?.payment_status === "FAILED";
  const isDropped = /USER_DROPPED/i.test(type) || payment?.payment_status === "USER_DROPPED";

  const status = isSuccess ? "paid" : isFailed ? "failed" : isDropped ? "dropped" : null;
  if (!status) {
    return json({ received: true, ignored: `unhandled type ${type}` });
  }

  // ── Reconcile before anything is written ────────────────────────────────
  //
  // This sits BEFORE the status='paid' write on purpose. Blocking after that
  // write would leave the row at status='paid', granted_at=null — the shape the
  // recovery branch above grants on — so a refused payment would be granted by
  // its own retry. Refusing first means an unreconciled order never reaches a
  // grantable state at all.
  //
  // Unlike the recovery path, a success event with NO amount is refused rather
  // than waved through. Cashfree's PAYMENT_SUCCESS payload always carries
  // order_amount; a success event without one is a shape we do not understand,
  // and the safe direction on the money-in path is the opposite of the dispute
  // path — an unreconciled grant hands over a plan for an unknown sum and
  // cannot be undone without SQL, whereas refusing costs a retry, a loud log
  // and an operator granting it by hand.
  if (isSuccess) {
    const check = reconcile(order, payment, row);
    if (!check.ok) {
      console.error(
        "AMOUNT MISMATCH — PLAN NOT GRANTED", orderId,
        "| gateway:", check.gateway, "| recorded:", check.recorded, "|", check.reason,
        "| payload:", JSON.stringify(order).slice(0, 300),
      );
      // Non-2xx: Cashfree keeps retrying and the failure stays visible in the
      // dashboard instead of being acknowledged away.
      return json({ error: `not granted: ${check.reason}`, gateway: check.gateway, recorded: check.recorded }, 409);
    }
    if (check.absent) {
      console.error(
        "PAYMENT SUCCESS WITH NO AMOUNT — NOT GRANTED", orderId,
        "| expected", String(row.amount ?? "?"), String(row.currency ?? ""),
        "| payload:", JSON.stringify(order).slice(0, 300),
      );
      return json({ error: "not granted: gateway amount missing", recorded: String(row.amount ?? "") }, 409);
    }
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
