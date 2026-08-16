# AbroBot CRM — edge function changes (2026-08-16)

Four features were fully configured in the CRM Settings UI but had **no
implementation anywhere** — not in the frontend bundle, not in any edge
function. This change set implements all four.

**No frontend changes are required.** All six config fields
(`telegram_bot_token`, `telegram_chat_id`, `notify_new_leads`,
`whatsapp_token`, `whatsapp_phone_id`, `whatsapp_autoreply`) are already
written by the existing Settings screens. Only the delivery side was missing.

Nothing here is deployed yet.

---

## New shared modules

| File | Purpose |
|---|---|
| `_shared/notify.ts` | Telegram new-lead alerts. Best-effort — never throws into the request path. |
| `_shared/score.ts` | Lead scoring engine. Pure, deterministic, returns a breakdown so a score is explainable. |
| `_shared/whatsapp.ts` | Meta Cloud API sender + config loader. Surfaces Meta's real error codes. |

## New functions

| Function | JWT | Purpose |
|---|---|---|
| `rescore-leads` | **ON** | Backfill/refresh `leads.score` for the caller's org. Supports `{ dry_run: true }`. |
| `whatsapp-send` | **ON** | Send a WhatsApp message to a lead; logs a `whatsapp` activity. |

## Modified functions

| Function | Change |
|---|---|
| `lead-webhook` | Scores the lead at intake; fires a Telegram alert; sends a WhatsApp autoreply for inbound WhatsApp when enabled. Response now includes `score`, `alert`, `autoreply`. |
| `chat-agent` | Scores chat-captured leads (using conversation turns as engagement); fires a Telegram alert on capture. |
| `nurture` | **Now respects `agent_config.nurture_enabled`.** Also accepts an optional `{ org: "slug" }`; defaults to `abrobot` so existing cron callers are unaffected. |

---

## ⚠️ Read before deploying

**1. `nurture` behaviour change.** Until now the toggle was ignored and every
run emailed leads regardless. After this deploy, an org with
`nurture_enabled = false` stops receiving sends. Check the current value first
so you know what to expect:

```sql
select o.slug, c.nurture_enabled
from agent_config c join organizations o on o.id = c.org_id;
```

Fail-open is deliberate: a *missing* `agent_config` row still nurtures (as
today). Only an explicit `false` stops it.

**2. WhatsApp needs a Meta app.** `whatsapp-send` and the autoreply will return
`not_configured` until `whatsapp_token` and `whatsapp_phone_id` are set in
Settings. `whatsapp_phone_id` is the **Phone Number ID** from the Meta
dashboard, not the phone number itself.

**3. The 24-hour rule.** Meta only allows free-form WhatsApp text inside the
24h window opened by the customer's last message. The autoreply is always
inside it. Manual sends from the CRM may not be — in that case Meta returns
error `131047` and `whatsapp-send` passes it through rather than reporting a
false success. Sending outside the window needs an approved template.

**4. `CRM_BASE_URL`** (optional) controls the "Open in CRM →" deep link in
Telegram alerts. Defaults to `https://crm.mnbresearch.com`.

---

## Deploy

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app

# modified — keep existing JWT settings
npx -y supabase@latest functions deploy lead-webhook --no-verify-jwt
npx -y supabase@latest functions deploy chat-agent   --no-verify-jwt
npx -y supabase@latest functions deploy nurture      --no-verify-jwt

# new — JWT verification ON (they act on behalf of a logged-in user)
npx -y supabase@latest functions deploy rescore-leads
npx -y supabase@latest functions deploy whatsapp-send
```

## Verify

**Telegram** — set a bot token + chat ID in Settings, tick "Send me a phone
alert for every new lead", then POST a test lead:

```bash
curl -X POST "https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/lead-webhook?key=<A_WEBHOOK_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Lead","email":"test@example.com","phone":"+919999999999","country":"USA","course_level":"Masters","intake":"Fall 2026"}'
```

The response now carries `"alert":{"sent":true}` — or a `reason` explaining
exactly why it didn't send (`disabled`, `not_configured`, or Telegram's own
error text). Delete the test lead afterwards.

**Scoring** — dry run first, which changes nothing:

```bash
curl -X POST "https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/rescore-leads" \
  -H "Authorization: Bearer <YOUR_CRM_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" -d '{"dry_run":true}'
```

It returns `scanned`, `updated`, `unchanged` and a 10-lead `sample` showing
`was`, `now` and the full per-component `breakdown`. Re-run without `dry_run`
once the numbers look right.

## Scoring model

Weights live in one table at the top of `_shared/score.ts`:

| Component | Max | Notes |
|---|---|---|
| phone | 15 | strongest intent signal held |
| budget | 25 | banded by INR tier |
| engagement | 12 | saturates at 5 interactions |
| email | 10 | |
| intake | 10 | nearer = hotter; a past intake scores 0 |
| country | 8 | |
| stage | 8 | pipeline progression |
| course | 6 | |
| course_level | 6 | |

Verified: empty lead → 0, phone only → 15, a fully-qualified engaged lead with
a near intake → 96, and the theoretical maximum caps at exactly 100.

**Known edge case:** a bare year like `"2026 intake"` is interpreted as
mid-2026, which is already past as of August 2026 and therefore scores 0 for
intake. If your leads commonly use bare years, that rule should be revisited.
