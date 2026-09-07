# Launch readiness — 6 September 2026

A full sweep of the frontend, all fourteen edge functions, and every migration,
looking specifically for the two failure modes that have caught us repeatedly:
**code that compiles but fails on first use**, and **failures that report
success**.

Twenty-six real defects. All fixed. What follows is what they were, because
"fixed 26 bugs" is not something you can check and this list is.

---

## Run this, in this order

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && bash scripts/deploy-all.sh
```

Then in the SQL editor:

| # | File |
|---|---|
| 8 | `20260906100000_prelaunch_hardening.sql` |

(1–7 are already applied. This one ends with its own PASS/FAIL report.)

Then re-run `scripts/verify-all.sql` — still 18/18 — and
`scripts/tenant-isolation-test.sql` — still 16/16.

---

## Money

**A customer could pay and never receive their plan.** `billing-webhook` marked
the payment `paid` *before* calling `grant_plan_from_payment`. If the grant
failed we returned 500 so Cashfree would retry — and the retry hit the
idempotency check first, saw `status = 'paid'`, returned 200, and Cashfree
stopped. Money taken, plan never granted, no further attempt, and a single
console line as the only trace.

The fix keys idempotency on `granted_at` instead of `status`, which is the
marker `grant_plan_from_payment` sets under a compare-and-swap — so retrying is
safe and a payment that is paid-but-ungranted now actively recovers.

*(A second reported bug here — double-granting under concurrent delivery — was
not real. The compare-and-swap already prevents it; the audit had read the
superseded migration.)*

---

## Security

**An open mail relay.** `app-signup` read `if (APP_SECRET && ...)`, so an unset
secret — the deployment default — disabled the check entirely. Anyone with the
URL could send from our verified domain. Now fails closed, with a constant-time
compare.

**Anyone could send email to anyone.** `send-campaign`'s `test_to` took an
unvalidated address from any active member, unmetered and unlimited. Now
admin-only, validated, and metered like every other send. The bulk path was
member-level too — a counsellor could mass-mail 2,000 people.

**The email allowance failed open.** Both senders destructured only `data` from
`email_allowance`. On an RPC error `remaining` became `null` — which is the
documented *unlimited* sentinel. A transient blip turned a metered sender into
an unmetered one, on an unattended job that repeats hourly. Both now fail
closed.

**The AI limit failed open the same way**, and its `try/catch` was dead code:
supabase-js resolves with `{ error }` rather than throwing, so the catch never
ran for an RPC failure.

**The chat widget had no rate limit.** It cannot require a key — it runs on a
visitor's browser — but org slugs are public, so anyone could drain a
competitor's monthly AI allowance to zero, at which point their widget starts
telling real prospects it is "taking a short break". Now 20 messages per org per
IP per minute.

**Anonymous callers could enumerate any organisation's plan.** PostgreSQL grants
EXECUTE to PUBLIC by default, and `grant execute ... to authenticated` *adds* to
that rather than replacing it. Six functions taking an arbitrary `p_org_id`, with
no check in the body, were reachable by `anon`. `stale_jobs()` and
`recent_cron_failures()` were worse: platform-wide, and the latter reads
`net._http_response`, which holds the HTTP result of **every tenant's** outbound
calls — granted to every logged-in customer.

**The Telegram bot token could reach a browser.** It is in the request URL, and
Deno puts the URL in `fetch`'s error message. On a network failure that message
went into a response body and a log line.

**Nothing had a timeout** — Groq, Meta, Telegram, Resend, Cashfree. A hung
upstream held the function until the platform killed it. Worst in `nurture`,
which loops 25 orgs × 100 leads: one slow call starved every tenant later in the
run, every run.

---

## Data loss and correctness

**A webhook could destroy lead capture.** `notify_lead_change` wrapped the
automation dispatch in an exception handler, with a comment explaining exactly
why — and left the two `fire_webhooks` calls outside it. It is an AFTER INSERT
trigger, so a raise there aborts the insert on **all five** creation paths.
This never bit only because `fire_webhooks` loops over endpoints and nobody had
configured one yet; the first customer to add a webhook would have found it.

**Import silently imported everything twice.** The duplicate-check read was
unchecked, so on failure the dedupe sets came out empty and every row was
imported as new — while the result card reported "0 duplicates skipped". It was
also uncapped, so PostgREST's 1,000-row default truncated the comparison set for
any org past a thousand records.

**"Pipeline saved" when it wasn't.** Every other write on that screen checked
its error; the stage-rename loop did not. Won/Lost flags failing silently is not
cosmetic — conversion rates are computed from them.

**Nine screens could hang forever.** `useLeads` returned early when there was no
org *without clearing `loading`*, which initialises to `true`. Nothing recovers,
because the loader only re-runs when the org id changes and that is what is
missing. The same shape appeared in six more screens.

**"You have no records" when the read failed.** Reports, Pipeline and Calendar
discarded the load error — the exact failure `store.tsx` documents in a comment
("a customer with 4,000 records being told, convincingly, that they have none").
Same for Conversations, Activity, Templates, Automations and Team.

**Six buttons labelled "Send…" sent nothing** and logged nothing: an `else if`
meant an action carrying both a stage and an activity type silently dropped the
activity. A law firm would have believed a proposal went out. Now they log, and
the ones that only move a card are labelled "Mark … sent".

**The CSV export didn't download in Firefox or Safari** — my own bug from
yesterday. The anchor was never appended to the document and the object URL was
revoked synchronously after `click()`. The toast said "Exported N rows".

**Every scheduled follow-up read "just now"** on the dashboard table whose only
job is telling you when to call someone: `timeAgo` had no future-date branch, so
a negative difference fell through to `if (m < 1) return "just now"`.

**Webhook deliveries recorded nothing.** `status_code`, `error`,
`failure_count`, `last_status` were written by nothing, and the auto-disable
function the migration referred to did not exist — so a customer whose endpoint
500s on every event saw "never delivered, no failures" forever, and we retried a
dead endpoint indefinitely. Now reconciled every 5 minutes, with auto-disable
after 20 consecutive failures.

**The cron-death detector never ran.** `record_heartbeat()` shipped with zero
call sites, so `job_heartbeats` stayed at "never reported" and `stale_jobs()`
flagged every job stale forever. The monitoring was itself the broken thing.

**The health card was permanently blank** — and blank is its "everything is
fine" state. It fetched `system-health` with no headers; that function required
a cron secret; it 401'd every time. Written after a three-day silent outage,
and silent by construction.

**Link scanners were unsubscribing people.** The unsubscribe acted on GET, and
corporate mail filters prefetch every URL in a message — including the
`List-Unsubscribe` one. GET now shows a confirmation page; POST does the work,
so RFC 8058 one-click still functions.

**Plan limits returned 500 to integrations.** `lead-webhook` returned a server
error for a plan-limit rejection, so Zapier and Meta retried forever against a
condition only a human can clear, while disclosing raw Postgres text. Now 402.

**Groq's status was never checked** in `summarize-chats`: on a 429 the summaries
came back empty with HTTP 200 and no error anywhere.

**`rescore-leads` counted writes it never checked**, then reported `ok: true`.

---

## Gaps that were features, not bugs

**You could not delete a record.** At all. Meanwhile `archive_lead`,
`restore_lead`, `archived_leads` and a 30-day purge job sat in the database with
zero callers, and `deleted_at` appeared nowhere in the frontend. There is now an
Archive action on each record and an **Archived** screen to restore from — a
recovery path nobody can find is not a recovery path.

**`conversations:read` was a scope that granted nothing.** Now `GET
/conversations` and `GET /conversations/:id`.

**The email allowance was enforced but shown nowhere** — the tightest cap in the
product (50/month on trial), and the first a customer knew of it was a refused
send. Now a meter on Plan & usage.

**The upgrade card vanished silently** if `plan_limits` failed to load, removing
the only path a customer has to paying you.

**The 2,000-record page limit was invisible** while the Business plan sells
50,000. Every KPI, chart, leaderboard and the CSV export silently described only
the newest 2,000. Now stated on screen.

Also: destructive deletes ask first (and stage deletion says how many records it
will strand); `super_admin` is no longer offered in a tenant's role picker; the
setup checklist no longer ticks "install the widget" for CSV-imported records
and deep-links to the right tab; and a transient load failure on a record no
longer renders as "Not found."

---

## Verified, not asserted

- `tsc --noEmit` clean; production build succeeds (720 modules)
- `deno check` clean on all 14 edge functions plus `_shared` — the CI exemption
  for `chat-agent` is gone, because that failure was real and is fixed
- 10/10 scoring unit tests pass
- 18/18 schema checks, including two that **call** the crypto functions
- 16/16 tenant isolation, including real cross-tenant INSERT/UPDATE/DELETE

---

## What I could not verify from here

Stated plainly rather than left implied:

1. **The new migration has not been run against a live database.** No Postgres
   in this environment. It ends with a PASS/FAIL report for that reason.
2. **Nothing here was clicked in a browser.** The reasoning is from the code and
   the types; a walk through the live app after deploying is still worth an hour.
3. **The API-key isolation test still needs two orgs** —
   `scripts/api-isolation-test.sh`.
4. **Scheduled jobs**: confirm they are actually firing, now that the functions
   report heartbeats:

```sql
select jobname, schedule, active from cron.job order by jobname;
select * from public.stale_jobs();
select job_name, last_run_at, last_status, last_detail from public.job_heartbeats;
```

`stale_jobs()` returning nothing is the answer you want. Before today it could
never return anything else, because nothing ever reported in.
