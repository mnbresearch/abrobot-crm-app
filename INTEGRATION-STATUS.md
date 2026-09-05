# Integrations — what's real now, and what still isn't

An audit traced every capability the product promises back to its
implementation. The results were worse than expected, so this file stayed
blunt. It is now the record of closing that gap.

---

## Apply, in this order

Order matters in two places: the cron secret must exist before the functions
that require it go live, and the nurture migration must land before the new
nurture function runs, or it will look for a column that isn't there.

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && npx -y supabase@latest functions deploy api --no-verify-jwt && npx -y supabase@latest functions deploy run-automations --no-verify-jwt && npx -y supabase@latest functions deploy summarize-chats --no-verify-jwt && npx -y supabase@latest functions deploy nurture --no-verify-jwt && npx -y supabase@latest functions deploy send-campaign && npx -y supabase@latest functions deploy save-integration && bash scripts/deploy-all.sh
```

Then run these migrations in the SQL editor, in this order:

| # | File | What it does |
|---|---|---|
| 1 | `20260903140000_cron_secret_and_heartbeat.sql` | `x-cron-secret` on the scheduled endpoints, plus heartbeats |
| 2 | `20260903150000_soft_delete.sql` | deletion becomes recoverable |
| 3 | `20260905090000_public_api_and_webhooks.sql` | API keys, outbound webhooks, trigger-based automation dispatch |
| 4 | `20260905120000_credential_columns_and_status.sql` | browser loses read access to credentials; `integration_status()` |
| 5 | `20260905130000_tenant_nurture.sql` | follow-up sequence becomes the tenant's own content, opt-in |
| 6 | `20260905140000_email_limits.sql` | monthly email allowance per plan, metered like AI replies |

`--no-verify-jwt` on `api` is correct: callers authenticate with an AbroBot API
key, not a Supabase JWT. The key check *is* the authentication. `send-campaign`
and `save-integration` keep JWT verification **on** — both act as a signed-in
member.

---

## Built

### 1. A real REST API (`API.md`)
Scoped keys, hashed at rest, shown once. List / fetch / create / update
records, read the pipeline. Every query filtered by the org resolved **from the
key** — the org is not a parameter, so it cannot be asked for.

Phone numbers are normalised identically to the widget and capture URLs, so a
record created through the API deduplicates against one captured on the
website instead of making a second copy of the same person.

### 2. Outbound webhooks
Signed `lead.created` and `lead.stage_changed` callbacks, HMAC-SHA256, 7 days
of delivery logs, fired via `pg_net` so a slow endpoint of yours can never
delay a record being saved.

### 3. Settings → Integrations
API keys, capture URLs, outbound endpoints, and credential panels for WhatsApp
and Telegram with "send test" buttons that pass Meta's and Telegram's own error
codes through — 131030 and 190 are worth an hour of guessing each.

### 4. The automation engine actually fires
`fireEventAutomations` was imported by **one** of the five paths that create a
lead; the chat widget bypassed it, and `stage_changed` was dispatched by
nothing, ever. Fixed with a database trigger rather than by patching each
caller — two of those paths are browser inserts that cannot call an edge
function at all.

### 5. Email exists now
`send-campaign` was fully built, correctly authenticated, and had **zero
callers**, so nothing in the product could send an email and the merge tokens
the Templates screen documents were substituted nowhere. Now:

* **Templates → Send** — pick an audience, *see the count*, then send. The
  two-step exists because a few hundred emails is not undoable and the number
  of recipients was the one thing the composer never showed.
* **Record → ✉️ Email** — one person, from a template or freehand, logged
  against the record.
* Merge tokens have one implementation (`_shared/template.ts`) shared by email
  and WhatsApp. An unknown token is left visible rather than blanked: a stray
  `{{discount}}` is a mistake someone fixes, a silently missing word ships.
* `List-Unsubscribe` headers, because Gmail and Yahoo filter bulk senders
  without them regardless of how good the copy is.

### 6. Follow-up belongs to the tenant
`nurture` contained three study-abroad emails signed AbroBot, defaulted to org
`abrobot`, and treated a *missing* config row as consent to send. The first
correct cron run would have emailed a dental clinic's patients about university
shortlists — a spam complaint against our sending domain, which costs every
other tenant their deliverability.

Now: the sequence is templates the tenant writes (Templates → "Use in automatic
follow-up"), sending is opt-**in**, an org with no templates sends **nothing**,
the run covers every org rather than one, replies go to the tenant's admin
rather than a personal Gmail, and it stops at won/lost stages via `stage_key`
instead of three legacy stage names no industry pack uses.

### 7. Credentials left the browser
`agent_config` keeps tokens on the same row as the greeting, and RLS is
row-level, so any member who could read the greeting could read the tokens.
The earlier hardening note rejected column GRANTs because Supabase cannot tell
a counsellor from an admin — true, and irrelevant: **no** browser user needs
those columns, since admins configure through `save-integration` on the service
role. SELECT/INSERT/UPDATE on the five credential columns are now revoked from
`authenticated` and `anon`.

### 8. The setup checklist stopped lying
"Turn on new-record alerts" was ticked by the *toggle*, with no bot token
behind it — certifying a configuration that cannot deliver anything. A ticked
box is worse than an empty one, because the customer stops looking. It now asks
`integration_status()` (booleans only, never a value) and says explicitly when
alerts are on but unconfigured.

### 9. Export is an export
It emitted eight columns: no custom fields, tags, owner, stage label, industry
fields, lost reason or notes. Now it resolves stage and owner to the names on
screen, discovers custom-field columns from the data so each industry gets its
own, chunks the notes query at 100 ids because ids travel in the URL, and
writes a UTF-8 BOM so Excel on Windows doesn't turn every Devanagari name into
mojibake.

### 10. Fixed a regression I introduced
Adding the cron secret broke **"▶ Test run"** and **"✨ AI summary"** — the
browser sends a user JWT and cannot send a server-side secret. Both now accept
either, with the org taken from the token rather than the request body.

### 11. Email is metered, and the sending identity is the tenant's

Two things that only became risks once email existed:

* **`max_emails` per plan** (trial 50, Starter 1,000, Growth 5,000, Business
  20,000, Enterprise unlimited), metered through the same `consume_usage` path
  as AI replies. This is a limit because email costs *reputation*, and
  reputation is shared: one trial account blasting cold email gets the sending
  domain flagged, and the tenant who caused it is not the tenant who pays for
  it. The allowance is checked **before** a send, not per message — refusing
  halfway through 400 recipients leaves nobody able to say who received it.
* **Integrations → Email** takes a tenant's own Resend key, with a test button.
  The column was already read in preference to the platform key; there was
  simply no field to set it, so every tenant rode on our shared reputation.

### 12. `conversations:read` grants something

It was a scope you could tick in the key-creation UI, documented in API.md, and
honoured by no endpoint — worse than a missing feature, because someone grants
it, believes their integration is scoped, and finds out otherwise in
production. `GET /conversations` and `GET /conversations/:id` now exist.

---

## Published claims, corrected

| Was | Now | Why |
|---|---|---|
| Starter ₹1,499 | ₹999 | `plan_limits` says 999 |
| "750 / 5,000 / 25,000 leads per month" | 1,000 / 10,000 / 50,000 **records** | the limit is total records, not monthly |
| "Pipeline, alerts, Excel" | CSV export | there is no Excel writer in the codebase |
| "Up to 5 brands, one login", "Full white-label", "white-label from ₹9,999/mo" | removed; named as roadmap | one org is one brand; no reseller or theming layer exists |
| "paid plans renew automatically until cancelled" | plans are prepaid and expire | `billing-checkout` creates a one-time Cashfree order, not a mandate |
| "cancel any time from your account settings" | nothing to cancel | there is no such flow, because nothing recurs |
| "Every plan includes a 7-day free trial" | trial is its own plan (2 users, 100 records), no card | it is not free access to a paid tier |

The last three were consumer-law exposure, not product gaps.

---

---

## Still open

**1. Tenant isolation has never been tested with two real orgs.** The policies
read correctly and `api` resolves the org from the key rather than the request,
but "reads correctly" is not evidence. Create a second org, put a record in
each, and try to reach one from the other's key and session. This is the one
item I would not launch without: an hour's work, and the only claim in this
document resting on reading code rather than running it.

**2. Activities and notes are not exposed through the API.** Transcripts are;
the human-written notes and call logs on a record are not. Stated in API.md so
nobody designs around them.

---

## Test it end to end

```bash
# 1. Create a key in Settings -> Integrations, then:
export KEY="abk_live_..."
export API="https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/api/v1"

curl -H "Authorization: Bearer $KEY" $API/me
curl -H "Authorization: Bearer $KEY" "$API/leads?limit=5"

# 2. Create a record — this should also fire your webhooks and any
#    "record is created" automation.
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"API Test","email":"apitest@example.com"}' $API/leads

# 3. Post the same email again — should return deduped:true, not a second copy.
```

Then in SQL:

```sql
-- webhooks and keys
select event, status_code, created_at from webhook_deliveries order by created_at desc limit 5;
select name, key_prefix, use_count, last_used_at from api_keys where revoked_at is null;

-- credentials really are out of reach of the browser (expect zero rows)
select column_name, privilege_type from information_schema.column_privileges
 where table_name = 'agent_config' and grantee in ('authenticated','anon')
   and column_name in ('groq_api_key','resend_api_key','whatsapp_token',
                       'telegram_bot_token','app_secret');

-- who would actually receive automatic follow-up
select o.slug, c.nurture_enabled,
       (select count(*) from message_templates t
         where t.org_id = o.id and t.nurture_step is not null) as steps
  from organizations o left join agent_config c on c.org_id = o.id order by o.slug;
```

In the app: Templates → Send → **Send test** to yourself before **Check how
many**. Then Reports → Export CSV and open it in Excel — the header row should
carry your industry's own `custom.*` columns.

---

## Honest assessment

The integration layer is sellable: a customer can pull records into a
spreadsheet, push leads in from a form or ad platform, get notified in their
own systems, send email and WhatsApp from the record, and run an automatic
follow-up sequence in their own words. Every line on the pricing page now
describes something that exists.

Two items remain open and neither is a refund conversation. Item 1 is the one
worth doing before you take a second customer.
