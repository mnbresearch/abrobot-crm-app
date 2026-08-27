# Enabling payments (Cashfree)

Three commands, one dashboard step, one test payment.

**Your secret key never goes into this repo, this chat, or the browser.** It is
set once as a Supabase function secret and read only server-side.

---

## 1. Apply the billing migration

Supabase → SQL Editor → run:

```
supabase/migrations/20260820090000_billing.sql
```

Creates `payments`, `subscriptions`, and `grant_plan_from_payment()`.

Note the RLS on `payments`: members may **read** their org's payments, and
there is deliberately **no insert or update policy**. Even a compromised admin
session cannot mark an order paid — only the service role writes there.

---

## 2. Set the credentials

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app

npx -y supabase@latest secrets set \
  CASHFREE_APP_ID=1262058a1d3f90a9ba73aaacd8d8502621 \
  CASHFREE_SECRET_KEY=PASTE_YOUR_SECRET_KEY_HERE \
  CASHFREE_ENV=sandbox \
  CRM_BASE_URL=https://crm.mnbresearch.com
```

`CASHFREE_ENV` has **no default, on purpose**. Defaulting to sandbox means real
customers pay into a test account and you find out from an angry email;
defaulting to production means your own test run takes real money. Refusing to
start is the safer failure.

Start on `sandbox`. Switch to `production` after the test below passes:

```bash
npx -y supabase@latest secrets set CASHFREE_ENV=production
```

---

## 3. Deploy the functions

```bash
npx -y supabase@latest functions deploy billing-checkout
npx -y supabase@latest functions deploy billing-webhook --no-verify-jwt
```

The flags are not interchangeable:

- **`billing-checkout` keeps JWT verification ON.** It spends money and must
  know which signed-in admin is asking.
- **`billing-webhook` must be `--no-verify-jwt`.** Cashfree cannot send a
  Supabase JWT. Its authentication is the HMAC signature, which the function
  verifies before touching anything.

---

## 4. Register the webhook

Cashfree dashboard → **Developers → Webhooks → Add**

- **URL:** `https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/billing-webhook`
- **Events:** `PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`,
  `PAYMENT_USER_DROPPED_WEBHOOK`

Use Cashfree's **Test webhook** button. Expect `200 {"received":true,...}`.

A **401** means the signature did not verify — almost always `CASHFREE_SECRET_KEY`
not matching the environment you registered the webhook in.

---

## 5. Make a test payment

1. Open the CRM → **Settings → Plan & Usage**
2. Pick a plan → **Upgrade**
3. Pay with a Cashfree test card (sandbox mode)
4. Confirm, in order:

```sql
select order_id, plan, amount, status, paid_at from payments order by created_at desc limit 3;
select org_id, plan, status, current_period_end from subscriptions;
select name, plan from organizations where slug = 'abrobot';
```

`payments.status = 'paid'`, a `subscriptions` row, and `organizations.plan`
updated. The Plan & Usage tab should now show the new limits.

---

## How this is protected

**Only the signature-verified webhook grants a plan.** The page a customer
lands on after paying is attacker-controllable — anyone can open
`/settings?billing=return&order_id=anything`. If that page granted plans, the
product would be free to whoever read a URL. So it displays status and nothing
more.

The webhook:

| Property | Why |
|---|---|
| Fails **closed** | No secret configured rejects every webhook rather than accepting forged ones |
| Verifies **raw bytes** | Re-serialising parsed JSON changes whitespace and key order; the signature would never match |
| 5-minute replay window | A captured request cannot be replayed later |
| Constant-time compare | A fast-exit compare leaks the signature byte by byte |
| Idempotent | Cashfree retries until it gets a 2xx; a retry must not extend a plan twice |
| 500 on grant failure | Cashfree retries, so a taken payment is never left ungranted |

**Prices come from the database, never the request.** `billing-checkout` reads
`plan_limits.price_inr` server-side. A client-supplied amount is a
client-supplied discount.

**Only org admins can start a checkout** — it spends money, and the order
carries the org id that a successful payment upgrades.

---

## What is deliberately not built

**Auto-renewal.** Charging a stored card without a mandate is an unauthorised
debit. Recurring billing on Cashfree is a separate authorisation the customer
gives at checkout (eNACH / UPI AutoPay), and a different API. Today a
subscription simply expires at `current_period_end` and the customer pays
again. Worth adding — but as its own piece of work, not bolted on quietly.

**Refunds.** Issue them from the Cashfree dashboard. The `refunded` status
exists on `payments` for when this is automated.

**Dunning / expiry enforcement.** Nothing yet downgrades an org when
`current_period_end` passes. Until that exists, check it periodically:

```sql
select o.name, s.plan, s.current_period_end
from subscriptions s join organizations o on o.id = s.org_id
where s.current_period_end < now();
```
