// AbroBot CRM — abandoned-checkout reminders for our own customers.
//
// Deploy:  supabase functions deploy checkout-recovery --no-verify-jwt
//   (--no-verify-jwt because pg_cron calls it with the cron secret, and the
//    unsubscribe link is opened by a recipient who has no session. Both paths
//    authenticate themselves below.)
//
// Secrets: RESEND_API_KEY (already set for nurture), and the sender address in
//   RECOVERY_FROM — falls back to NURTURE_FROM. Optional RECOVERY_REPLY_TO,
//   falling back to NURTURE_REPLY_TO.
//
//   GET  ?unsub=<token>   -> "stop these reminders?" page (a GET changes nothing)
//   POST ?unsub=<token>   -> adds the address to platform_email_suppressions
//   POST {mode:"run"}     -> the hourly job (cron secret, or a super admin).
//                            FIRST reconciles lost webhooks (below) — on every
//                            run, even with reminders disabled — then sends.
//   POST {mode:"dry_run"} -> who WOULD be emailed; sends nothing (super admin)
//   POST {mode:"test"}    -> one sample email with made-up data to the
//                            configured test recipient only (super admin)
//
// Eligibility is decided in SQL (checkout_recovery_candidates, 20261013110000)
// from the payments table, whose status only billing-checkout, the
// signature-verified webhook, and the reconciliation below (on Cashfree's own
// PAID answer from its API, never on a redirect) write. Nothing here trusts a
// browser redirect.
//
// Never claims a send that did not happen: a row is 'sent' only after Resend
// accepted it, and a missing key or sender is a 503, not a quiet success.
//
// ── Lost-webhook reconciliation ─────────────────────────────────────────────
// billing-webhook is the only thing that grants a plan, and webhooks get lost
// (CASHFREE-WEBHOOK-BUG.md). A customer whose PAYMENT_SUCCESS never arrived
// stayed on 'created' forever — paid, ungranted, and (until the PAID check in
// the send loop) reminded to pay again. Each run now asks Cashfree about
// recent unpaid rows and, for a PAID order whose amount/currency reconcile
// with the SAME check the webhook uses (_shared/cashfree.ts reconcile), marks
// the row paid and grants it. A mismatch is reported to the operator and NOT
// granted. Everything is reported via _shared/operator.ts.

import { createClient } from "npm:@supabase/supabase-js@2";
import { requireCronOrMember } from "../_shared/cron-auth.ts";
import { fetchWithTimeout } from "../_shared/http.ts";
import { buildRecoveryEmail } from "../_shared/recovery-email.ts";
import { fetchOrder, reconcile } from "../_shared/cashfree.ts";
import { notifyOperator } from "../_shared/operator.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const RESEND_KEY = (Deno.env.get("RESEND_API_KEY") ?? "").trim();
// `||`, not `??`: a secret saved as an empty string must still fall back.
const FROM = (Deno.env.get("RECOVERY_FROM") || Deno.env.get("NURTURE_FROM") || "").trim();
const REPLY_TO = (Deno.env.get("RECOVERY_REPLY_TO") || Deno.env.get("NURTURE_REPLY_TO") || "").trim();
const SITE = Deno.env.get("CRM_BASE_URL") || "https://crm.mnbresearch.com";
const FN_URL = `${SUPABASE_URL}/functions/v1/checkout-recovery`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

const page = (title: string, body: string, status = 200, form = false) =>
  new Response(
    `<html><body style="font-family:sans-serif;text-align:center;padding:60px">` +
    `<h2>${title}</h2><p>${body}</p>` +
    (form
      ? `<form method="POST"><button type="submit" style="background:#b45309;color:#fff;border:none;padding:12px 26px;border-radius:8px;font-size:15px;cursor:pointer">Yes, stop these reminders</button></form>`
      : "") +
    `</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

async function heartbeat(status: string, detail: string) {
  try {
    const { error } = await admin.rpc("record_heartbeat", { p_job: "checkout-recovery", p_status: status, p_detail: detail });
    if (error) console.warn("checkout-recovery: heartbeat not recorded:", error.message);
  } catch (e) {
    console.warn("checkout-recovery: heartbeat failed:", (e as Error).message);
  }
}

async function send(to: string, subject: string, html: string, text: string, unsubUrl: string, idempotencyKey?: string) {
  const r = await fetchWithTimeout("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}`,
      // A send that times out on our side but was delivered must not be sent
      // again on the retry: Resend drops a repeat of the same key.
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: FROM, to: [to], subject, html, text,
      ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
      headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as { id?: string };
}

// ── Lost-webhook reconciliation ─────────────────────────────────────────────
// Window: old enough that a webhook in flight has had its chance (Cashfree
// retries for ~10 minutes), young enough to stay cheap. 50 rows per run.
const RECONCILE_MIN_AGE_MS = 15 * 60_000;
const RECONCILE_MAX_AGE_MS = 7 * 86400_000;
const RECONCILE_LIMIT = 50;

interface Reconciled { checked: number; recovered: number; mismatched: number; unconfirmed: number; errors: string[] }

async function reconcileLostWebhooks(): Promise<Reconciled> {
  const out: Reconciled = { checked: 0, recovered: 0, mismatched: 0, unconfirmed: 0, errors: [] };
  const now = Date.now();
  const { data: rows, error } = await admin.from("payments")
    .select("id, org_id, order_id, plan, amount, currency, status, period_months, raw")
    .in("status", ["created", "dropped", "failed"])
    .is("revoked_at", null)
    .lt("created_at", new Date(now - RECONCILE_MIN_AGE_MS).toISOString())
    .gt("created_at", new Date(now - RECONCILE_MAX_AGE_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(RECONCILE_LIMIT);
  if (error) {
    out.errors.push(`payments lookup failed: ${error.message}`);
    console.error("checkout-recovery: reconcile lookup failed:", error.message);
    return out;
  }

  for (const row of (rows ?? []) as {
    id: string; org_id: string; order_id: string; plan: string; amount: unknown; currency: unknown;
    status: string; period_months: number; raw: Record<string, unknown> | null;
  }[]) {
    out.checked++;
    const order = await fetchOrder(row.order_id);
    if (!order) { out.unconfirmed++; continue; }   // fetchOrder logs why
    if (String((order as { order_status?: string }).order_status ?? "") !== "PAID") continue;

    const check = reconcile(order, null, row);
    if (!check.ok || check.absent) {
      out.mismatched++;
      // Reported ONCE per payment, not hourly for a week: the marker is merged
      // into raw (the last gateway payload) without discarding what is there.
      const prior = (row.raw ?? {}) as Record<string, unknown>;
      if (!prior.reconcile_mismatch_reported_at) {
        await notifyOperator(admin,
          `LOST WEBHOOK, AMOUNT DOES NOT RECONCILE — plan NOT granted\n` +
          `Order ${row.order_id} (${row.plan}) · org ${row.org_id}\n` +
          (check.ok
            ? `Cashfree says PAID but reported no amount (recorded ${String(row.amount ?? "?")} ${String(row.currency ?? "")})`
            : `Gateway ${check.gateway} vs recorded ${check.recorded}: ${check.reason}`) +
          `\nReview in the Cashfree dashboard and grant or refund by hand.`);
        const { error: markErr } = await admin.from("payments")
          .update({ raw: { ...prior, reconcile_mismatch_reported_at: new Date().toISOString(), reconcile_order: order } })
          .eq("id", row.id);
        if (markErr) console.error("checkout-recovery: could not mark mismatch reported:", markErr.message);
      }
      continue;
    }

    // Compare-and-swap on the status we read: if the webhook lands at the same
    // moment, exactly one of us moves the row to 'paid'. grant_plan_from_payment
    // is itself a CAS on granted_at, so the grant cannot happen twice either.
    const { data: claimed, error: updErr } = await admin.from("payments").update({
      status: "paid",
      paid_at: new Date().toISOString(),
      raw: { source: "checkout-recovery reconciliation", order },
      cf_order_id: (order as { cf_order_id?: unknown }).cf_order_id != null
        ? String((order as { cf_order_id?: unknown }).cf_order_id)
        : undefined,
    }).eq("id", row.id).eq("status", row.status).is("revoked_at", null).select("id");
    if (updErr) {
      out.errors.push(`${row.order_id}: could not mark paid (${updErr.message})`);
      await notifyOperator(admin,
        `LOST WEBHOOK FOUND but could not mark paid — plan NOT granted\n` +
        `Order ${row.order_id} (${row.plan}) · org ${row.org_id}\n${updErr.message}\nWill retry next run.`);
      continue;
    }
    if (!claimed?.length) continue;   // the webhook (or another run) got there first

    const { data: granted, error: grantErr } = await admin.rpc("grant_plan_from_payment", { p_payment_id: row.id });
    if (grantErr) {
      out.errors.push(`${row.order_id}: grant failed (${grantErr.message})`);
      await notifyOperator(admin,
        `PAYMENT TAKEN BUT PLAN NOT GRANTED (lost-webhook recovery)\n` +
        `Order ${row.order_id} (${row.plan}) · org ${row.org_id}\n${grantErr.message}\n` +
        `Row is now status=paid, granted_at=null: the next PAYMENT_SUCCESS retry will grant it, or grant by hand.`);
      continue;
    }
    out.recovered++;
    await notifyOperator(admin,
      `Recovered lost webhook — plan granted\n` +
      `Order ${row.order_id} (${row.plan}, ${row.period_months} month(s)) · org ${row.org_id}\n` +
      `Amount ${String((order as { order_amount?: unknown }).order_amount ?? "?")} ` +
      `${String((order as { order_currency?: unknown }).order_currency ?? "")} · ${JSON.stringify(granted).slice(0, 200)}`);
  }

  if (out.unconfirmed) {
    console.warn(`checkout-recovery: ${out.unconfirmed} payment(s) could not be confirmed with Cashfree this run`);
  }
  return out;
}

const reconcileSummary = (r: Reconciled | null) => !r ? "" :
  ` | reconcile: ${r.checked} checked, ${r.recovered} recovered, ${r.mismatched} mismatched` +
  (r.unconfirmed ? `, ${r.unconfirmed} unconfirmed` : "") +
  (r.errors.length ? `, ${r.errors.length} error(s): ${r.errors.slice(0, 2).join("; ")}` : "");

interface Candidate {
  payment_id: string; order_id: string; org_id: string; org_name: string; plan: string; plan_label: string;
  amount: number | null; period_months: number; email: string; full_name: string | null;
  started_at: string; attempt: number; last_sent_at: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);

  // ── unsubscribe (no auth: the token is the authority) ─────────────────────
  const unsub = url.searchParams.get("unsub");
  if (unsub !== null) {
    // The CRM-site page (/unsubscribe) asks for JSON; mail clients get a page.
    // Supabase renders function GETs as text/plain, which is why the human
    // link in the email points at the CRM site rather than here.
    const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
    const reply = (title: string, body: string, status = 200, form = false) => wantsJson
      ? json({ ok: status < 400, title, message: body }, status)
      : page(title, body, status, form);
    if (!/^[0-9a-f-]{36}$/i.test(unsub)) return reply("That link isn't valid", "Please email contact@mnbresearch.com and we'll stop the reminders.", 400);
    // GET only asks: mail scanners prefetch links, and must not unsubscribe anyone.
    if (req.method === "GET") return reply("Stop checkout reminders?", "You won't receive more reminders about unfinished upgrades.", 200, true);

    const { data: row, error } = await admin.from("checkout_followups")
      .select("recipient_email").eq("unsub_token", unsub).maybeSingle();
    if (error) {
      console.error("checkout-recovery: unsubscribe lookup failed:", error.message);
      return reply("We couldn't process that just now", "Please email contact@mnbresearch.com and we'll stop the reminders straight away.", 500);
    }
    if (!row) return reply("That link has expired", "If you're still receiving reminders, email contact@mnbresearch.com.", 200);

    const { error: supErr } = await admin.from("platform_email_suppressions")
      .upsert({ email: row.recipient_email.toLowerCase(), reason: "unsubscribed", source: "checkout-recovery" },
              { onConflict: "email", ignoreDuplicates: true });
    if (supErr) {
      console.error("checkout-recovery: unsubscribe FAILED:", supErr.message);
      return reply("We couldn't process that just now", "Please email contact@mnbresearch.com and we'll stop the reminders straight away.", 500);
    }
    return reply("Done — no more reminders", "You won't receive more emails about unfinished upgrades.");
  }

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // ── who is asking ─────────────────────────────────────────────────────────
  const auth = await requireCronOrMember(req, CORS, admin);
  if (!auth.ok) return auth.response!;
  const isCron = !auth.userId;
  if (!isCron && auth.role !== "super_admin") return json({ error: "platform admins only" }, 403);

  let body: { mode?: string } = {};
  try { body = await req.json(); } catch { /* empty body = run */ }
  const requested = body.mode ?? "run";
  if (!["run", "dry_run", "test"].includes(requested)) return json({ error: "mode must be run, dry_run or test" }, 400);
  if (isCron && requested !== "run") return json({ error: "the scheduler may only run" }, 400);

  // Before anything else, and regardless of whether reminders are enabled or
  // the settings row is readable: granting a plan someone has paid for is not
  // a marketing feature.
  const rec: Reconciled | null = requested === "run" ? await reconcileLostWebhooks() : null;

  const { data: settings, error: setErr } = await admin.from("checkout_recovery_settings")
    .select("*").eq("id", true).maybeSingle();
  if (setErr || !settings) {
    console.error("checkout-recovery: settings unavailable:", setErr?.message);
    await heartbeat("error", "settings unavailable — is 20261013110000 applied?" + reconcileSummary(rec));
    return json({ error: "settings unavailable" }, 503);
  }

  // ── test: made-up data, configured recipient only ─────────────────────────
  if (requested === "test") {
    if (!settings.test_recipient) return json({ error: "Set a test recipient first" }, 400);
    if (!RESEND_KEY || !FROM) return json({ error: "RESEND_API_KEY and RECOVERY_FROM (or NURTURE_FROM) must be set" }, 503);
    // The real Growth price, not a hardcoded guess (it said 2999; the plan is
    // ₹2,499 since 20260908090000). Read live so a future price change is
    // reflected; the constant is only the fallback if the read fails.
    const { data: growth } = await admin.from("plan_limits")
      .select("label, price_inr").eq("plan", "growth").maybeSingle();
    const mail = buildRecoveryEmail({
      firstName: "Sample", orgName: "Sample Workspace", planLabel: growth?.label ?? "Growth",
      amountInr: Number(growth?.price_inr) || 2499, months: 1,
      startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), attempt: 1,
      settingsUrl: `${SITE}/settings?tab=usage`, unsubUrl: `${FN_URL}?unsub=00000000-0000-0000-0000-000000000000`,
    });
    try {
      const r = await send(settings.test_recipient, "[TEST] " + mail.subject, mail.html, mail.text, `${FN_URL}?unsub=00000000-0000-0000-0000-000000000000`);
      return json({ ok: true, mode: "test", to: settings.test_recipient, provider_message_id: r.id ?? null });
    } catch (e) {
      return json({ ok: false, mode: "test", error: (e as Error).message }, 502);
    }
  }

  // A run that died between Resend accepting a message and our status update
  // leaves a 'pending' claim that would block that reminder forever. After an
  // hour, release it as failed: the retry reuses the same Idempotency-Key, so
  // if the first send did go out, Resend drops the repeat.
  {
    const { error: staleErr } = await admin.from("checkout_followups")
      .update({ status: "failed", error: "interrupted — outcome unknown; retried with the same idempotency key" })
      .eq("mode", "live").eq("status", "pending").lt("created_at", new Date(Date.now() - 3600_000).toISOString());
    if (staleErr) console.error("checkout-recovery: could not release stale claims:", staleErr.message);
  }

  const dry = requested === "dry_run" || settings.dry_run;
  if (requested === "run" && !settings.enabled) {
    await heartbeat(rec?.errors.length ? "error" : "ok", "disabled — nothing sent" + reconcileSummary(rec));
    return json({ ok: true, skipped: "disabled", reconcile: rec });
  }
  if (!dry && (!RESEND_KEY || !FROM)) {
    await heartbeat("error", "RESEND_API_KEY or RECOVERY_FROM/NURTURE_FROM missing — nothing sent" + reconcileSummary(rec));
    return json({ error: "email is not configured — nothing was sent" }, 503);
  }

  const { data: cands, error: cErr } = await admin.rpc("checkout_recovery_candidates", { p_limit: 50 });
  if (cErr) {
    console.error("checkout-recovery: candidate query failed:", cErr.message);
    await heartbeat("error", "candidate query failed" + reconcileSummary(rec));
    return json({ error: "could not read candidates" }, 503);
  }
  const list = (cands ?? []) as Candidate[];

  // ── dry run: record what WOULD go, send nothing ───────────────────────────
  if (dry) {
    // Log each would-be reminder once per 20 hours, not once per hourly run.
    const { data: recent } = await admin.from("checkout_followups")
      .select("payment_id, attempt").eq("mode", "dry_run")
      .gt("created_at", new Date(Date.now() - 20 * 3600_000).toISOString());
    const seen = new Set((recent ?? []).map((x: { payment_id: string; attempt: number }) => `${x.payment_id}:${x.attempt}`));
    const rows = list.filter((c) => !seen.has(`${c.payment_id}:${c.attempt}`)).map((c) => ({
      payment_id: c.payment_id, org_id: c.org_id, recipient_email: c.email,
      attempt: c.attempt, mode: "dry_run", status: "would_send",
    }));
    if (rows.length) {
      const { error } = await admin.from("checkout_followups").insert(rows);
      if (error) console.error("checkout-recovery: dry-run log failed:", error.message);
    }
    await heartbeat(rec?.errors.length ? "error" : "ok", `dry run — ${list.length} would be emailed` + reconcileSummary(rec));
    return json({
      ok: true, mode: "dry_run", would_send: list.length,
      candidates: list.map((c) => ({ org: c.org_name, plan: c.plan_label, email: c.email, started_at: c.started_at, attempt: c.attempt })),
    });
  }

  // ── live ──────────────────────────────────────────────────────────────────
  let sent = 0, failed = 0, skipped = 0;
  for (const c of list) {
    // Claim first. The partial unique index means a concurrent run gets 23505
    // and skips, so nobody receives the same reminder twice.
    const { data: claim, error: claimErr } = await admin.from("checkout_followups").insert({
      payment_id: c.payment_id, org_id: c.org_id, recipient_email: c.email,
      attempt: c.attempt, mode: "live", status: "pending",
    }).select("id, unsub_token").single();
    if (claimErr) {
      if ((claimErr as { code?: string }).code !== "23505") console.error("checkout-recovery: claim failed:", claimErr.message);
      skipped++;
      continue;
    }

    // Ask Cashfree before telling anyone their payment did not complete. Our payments row is
    // only as current as the last webhook, and webhooks have been lost here
    // before (CASHFREE-WEBHOOK-BUG.md). Anything other than a clear "not
    // paid" answer — including no answer — means we do not send.
    const order = await fetchOrder(c.order_id);
    const gwStatus = String((order as { order_status?: string } | null)?.order_status ?? "");
    if (!order || gwStatus === "PAID") {
      const why = !order
        ? "could not confirm with Cashfree that this order is unpaid — not sent"
        : "Cashfree says this order is PAID but our record is not — check the webhook; not sent";
      await admin.from("checkout_followups").update({ status: "failed", error: why }).eq("id", claim.id);
      console.error(`checkout-recovery: ${c.order_id}: ${why}`);
      failed++;
      continue;
    }

    const unsubUrl = `${FN_URL}?unsub=${claim.unsub_token}`;
    const unsubPage = `${SITE}/unsubscribe?list=checkout&t=${claim.unsub_token}`;
    const mail = buildRecoveryEmail({
      firstName: c.full_name, orgName: c.org_name, planLabel: c.plan_label, amountInr: c.amount,
      months: c.period_months, startedAt: c.started_at, attempt: c.attempt,
      settingsUrl: `${SITE}/settings?tab=usage`, unsubUrl: unsubPage,
    });
    try {
      const r = await send(c.email, mail.subject, mail.html, mail.text, unsubUrl, `recovery-${c.payment_id}-${c.attempt}`);
      await admin.from("checkout_followups")
        .update({ status: "sent", provider_message_id: r.id ?? null }).eq("id", claim.id);
      sent++;
    } catch (e) {
      await admin.from("checkout_followups")
        .update({ status: "failed", error: (e as Error).message.slice(0, 300) }).eq("id", claim.id);
      failed++;
    }
  }

  await heartbeat((failed && !sent) || rec?.errors.length ? "error" : "ok",
    `sent ${sent}, failed ${failed}, skipped ${skipped}` + reconcileSummary(rec));
  return json({ ok: true, mode: "live", eligible: list.length, sent, failed, skipped, reconcile: rec });
});
