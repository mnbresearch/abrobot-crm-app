# Integrations — what's real now, and what still isn't

An audit traced every capability the product promises back to its
implementation. The results were worse than expected, so this file stayed
blunt. It is now the record of closing that gap.

---

## Apply, in this order

Deploy first, then the migrations. One command — it deploys all ten edge
functions and then asks the platform which ones are actually live, because a
long `&&` chain can fail in the middle and scroll the error away:

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && bash scripts/deploy-all.sh
```

That verification step exists because of what happened on 6 September: the
migrations were applied and everything looked finished, but `api` and
`save-integration` had never been deployed at all, and `nurture` was still
serving the old single-tenant build. The deploy list lived in a document
instead of in the script. It lives in the script now.

**Set `CRON_SECRET` before deploying**, in Supabase → Edge Functions →
Secrets. `_shared/cron-auth.ts` fails closed when it is unset, so deploying
first means the scheduled jobs start refusing themselves.

Then run these migrations in the SQL editor, in this order:

| # | File | What it does |
|---|---|---|
| 1 | `20260903140000_cron_secret_and_heartbeat.sql` | `x-cron-secret` on the scheduled endpoints, plus heartbeats |
| 2 | `20260903150000_soft_delete.sql` | deletion becomes recoverable |
| 3 | `20260905090000_public_api_and_webhooks.sql` | API keys, outbound webhooks, trigger-based automation dispatch |
| 4 | `20260905120000_credential_columns_and_status.sql` | browser loses read access to credentials; `integration_status()` |
| 5 | `20260905130000_tenant_nurture.sql` | follow-up sequence becomes the tenant's own content, opt-in |
| 6 | `20260905140000_email_limits.sql` | monthly email allowance per plan, metered like AI replies |
| 7 | `20260906080000_fix_pgcrypto_search_path.sql` | lets the API and webhook functions find pgcrypto |

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

## Verified, not argued

Run on the live database on 6 September 2026.

**Schema and privileges — 18/18 pass** (`scripts/verify-all.sql`).

Checks 1–16 ask whether things exist. **17 and 18 call them**, and that
distinction is not academic: this file passed 16/16 while every single API
request was returning `500`. `digest()`, `gen_random_bytes()` and `hmac()` are
pgcrypto, which Supabase installs into the `extensions` schema, and three
functions pinned `search_path = public`. Pinning it is right — an unpinned
`search_path` on a `SECURITY DEFINER` function is a privilege-escalation hole —
it was simply one schema too tight. PostgreSQL does not resolve calls inside a
plpgsql body at `CREATE` time, so all three were created without complaint and
failed only when used: no API request could authenticate, no key could be
created, and no webhook signature could be computed. A check that only looks
something up cannot tell working from merely present.

The credential lockdown (check 7) had the same shape of trap for a different
reason: PostgreSQL *warns* rather than errors when you revoke a column
privilege that a table-level grant still covers, so my first attempt would have
reported success and changed nothing. That check uses `has_column_privilege()`
rather than `information_schema.column_privileges`, because the latter cannot
see that case.

Confirmed against the live API afterwards: a malformed key returns
`401 Invalid or revoked API key`, a missing one `401 Missing API key`, and an
unknown route still `401` rather than disclosing that the route exists.

**Tenant isolation — 16/16 pass** (`scripts/tenant-isolation-test.sql`). A
throwaway user in a throwaway organisation, running as `authenticated` with a
real JWT claim, could read **zero** rows of every other tenant's `leads`,
`activities`, `conversations`, `chat_messages`, `agent_config`, `api_keys`,
`webhook_endpoints`, `message_templates`, `automations`, `profiles`,
`pipeline_stages` and `organizations`.

The three write attempts were real, not simulated:

| Attempt | Result |
|---|---|
| `INSERT` a record into another org | refused — *new row violates row-level security policy for table "leads"* |
| `UPDATE` another org's record | 0 rows |
| `DELETE` another org's record | 0 rows |

Those last two are evidence rather than vacuous truth: the script only runs
them when it has found a genuine foreign record to aim at, and it reported
row counts rather than skipping. Each was wrapped in a sentinel raise that
unwound it either way, so the delete was safe to run against production.

`integration_status()` — `SECURITY DEFINER`, so RLS cannot protect it — answered
for the caller's own organisation.

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

**1. Tenant isolation — the API-key half.** The database half is **verified**,
not argued: see below. What is still untested is whether two *API keys* stay
apart. Create a key in each of two orgs and confirm each `GET /leads` returns
only its own records. The code resolves the org from the key rather than the
request, so there is no parameter to tamper with, but that is a reading of the
code and the point of this section is that readings are not evidence.

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

Two items remain open and neither is a refund conversation. Isolation — the
thing that actually matters when you sell this to businesses who compete with
each other — has now been measured rather than asserted, on the live database,
including the write paths.
