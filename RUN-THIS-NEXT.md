# Run this next — 14 September 2026

The previous release (`RUN-THIS.md`) is done. This one is a correctness release
for the **automations engine** and for **soft delete**, and it exists because a
review of the automation sweep turned up a class of bug that repeats across the
codebase: a query with no `LIMIT` is silently truncated by PostgREST at 1,000
rows, and truncation is not always a degraded answer — sometimes it is an
inverted one.

Nothing here is cosmetic. Three of these are invisible today and certain at the
volume the paid plans sell.

**Do Step 0 first.** Everything below it was fixing a sweep that has not run
since 6 September.

---

## Step 0 — URGENT: the cron secret was never set

```
scripts/set-cron-secret.sql
```

`app_settings.cron_secret` still holds the literal placeholder the 3 September
migration seeded it with. `call_edge_function` refuses to send when it sees
that, so since **6 September** every scheduled HTTP call has raised instead of
firing — 2,502 failed attempts, recorded every fifteen minutes in a table
nothing reads.

Three jobs are affected. The other four are pure SQL inside the database and
never stopped, so billing still lapsed correctly, retention still purged, and
failed webhooks were still retried.

| Job | Every | Down for |
|---|---|---|
| `abrobot-run-automations` | 15 min | 8 days — no time-based rule has fired |
| `nurture-daily` | 03:30 | 8 days — **no follow-up email to any tenant** |
| `abrobot-system-health` | hourly | 8 days — no operator alerting at all |

`nurture-daily` is the commercially serious one. Follow-up email is a headline
feature on every paid plan and it has been silently off for eight days across
every customer.

And the third line is why the first two went unnoticed: the job whose entire
purpose is telling you a job has stopped was itself one of the stopped jobs.

The file explains the sequence — generate the secret in SQL, paste it into
**Supabase → Edge Functions → Secrets → `CRON_SECRET`**, redeploy the three
functions, then run its PART 2 to confirm. The value never needs to leave your
screen; don't paste it to me.

---

## Step 1 — SQL: scale, assignment and the assignee guard

Supabase → SQL Editor → paste the whole file → Run.

```
supabase/migrations/20260914090000_scale_and_assignment.sql
```

Ten indexes on the hot paths (the leads list had exactly two), a database-side
`org_assignment_load()` to replace counting assignment load in JavaScript, and
a trigger that refuses to assign a record to someone in another organisation.

**Expect:** the verify block ends with `PASS — all 10`, three `PASS` rows, and
`existing records assigned outside their own org → none`.

If that last row is not `none`, tell me the number before going further.

---

## Step 2 — SQL: cooldowns, the resume cursor and plan quota

Run it **after** step 1 — it is built around an index step 1 creates.

```
supabase/migrations/20260914100000_automation_cooldown_lookup.sql
```

Seven things. The three that matter most:

- **`automation_last_runs()`** — the cooldown check, asked per batch so it
  cannot overflow. The old query pulled the whole cooldown window with no
  limit. Truncation there is inverted, not degraded: a row present means
  "already ran, skip"; a row missing means "never ran, go ahead". Past a
  thousand runs in the window a rule stopped seeing its own history and
  re-fired for leads it had already processed — a second Telegram alert, a
  second stage move, on the same lead, the same day.
- **`automation_sweep_state`** — a resume cursor. The sweep now stops before
  the platform kills it, which is only safe with somewhere to record how far it
  got; without one, a large tenant's tail would never be processed at all.
- **Plan quota stops counting deleted records.** Deleted rows were consuming
  the cap for the thirty days until the retention job purged them, and the
  refusal message told customers to "archive some first" — which is exactly
  what had already happened.

**Expect:** all `PASS`, `the cooldown index is present exactly once`, and
`leads that received a repeat firing inside a cooldown window → none`.

Two rows are informational rather than pass/fail — `quota that deleted records
were holding` and the repeat-firing count. **Send me both**, whatever they say.
They are the evidence of how much these bugs had actually cost.

---

## Step 3 — Terminal: deploy and commit

One block, one paste:

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && supabase functions deploy run-automations --no-verify-jwt && supabase functions deploy lead-webhook --no-verify-jwt && supabase functions deploy chat-agent --no-verify-jwt && supabase functions deploy nurture --no-verify-jwt && supabase functions deploy send-campaign && supabase functions deploy api --no-verify-jwt && supabase functions deploy whatsapp-send && supabase functions deploy rescore-leads && supabase functions deploy app-signup --no-verify-jwt && supabase functions deploy system-health
```

Then the frontend and the commit:

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app/app && npm run build && cd .. && ./scripts/deploy-all.sh
```

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && git add -A && git commit -m "Automations: one executor, bounded queries, a resume cursor; soft delete honoured by every service-role read" && git push
```

---

## Step 4 — Check it

After the next scheduled sweep (top of the hour), in SQL:

```sql
select job_name, last_run_at, last_status, last_detail
  from public.job_heartbeats where job_name = 'run-automations';

select * from public.automation_sweep_state;
```

`last_status` should be `ok`. If it is `warn`, `last_detail` names the reason —
send it to me. A `cursor` that is not null means that org was mid-walk when the
sweep stopped, which is the design working, not a fault; it should be null again
after a later tick.

In the app: **Automations → Test run**. It now reports what would fire *and*
whether the run was incomplete, instead of showing "Nothing would fire right
now" for a sweep that silently skipped everything.

---

## What this release actually fixes

| | Was | Now |
|---|---|---|
| Action execution | Two copies of the nine-case switch; the round-robin fix had landed in only one, so a rule behaved differently at intake than at 3am | One shared executor |
| Database errors | `postgrest-js` resolves with `{error}` rather than throwing, so refused writes were recorded as successes | Every call checked; a failure stops the rule |
| Round-robin | Counted an arbitrary 1,000 rows in JavaScript; ties kept sending to the same person | Counted in the database, one aggregation per batch, ties broken by id |
| Cooldown | Whole window fetched unbounded; truncation read as "never ran" | Per-batch, one row per lead |
| The sweep | Saw an unordered 1,000 leads per org; everything after was invisible forever | Paged with a resume cursor, least-recently-swept org first |
| Deleted records | Invisible to the app, visible to every service-role read — so nurture emailed them, campaigns messaged them, the public API returned them, and they consumed plan quota | Excluded everywhere except the unsubscribe endpoint |
| `last_run_at` | Stamped for every rule whether or not it ran | Stamped per rule, only when that rule was executed |
| Health | A sweep that skipped everything reported `ok` | Reports `warn`; `stale_jobs()` now surfaces status, not just lateness |
| CI | Every `.test.cjs` printed `SKIP` and exited 0 — a green tick over zero assertions | esbuild installed; a skip is a hard failure; 46 tests genuinely run |

## Still open

Unchanged from `RUN-THIS.md`, plus:

- **Meta payment method by 30 September.** Still the hard deadline.
- **Nothing watches the watchman.** Every alarm in this system — heartbeats,
  `stale_jobs()`, the operator Telegram alert — is raised by `system-health`,
  which reaches the database over the same HTTP path that just failed for eight
  days. A watchdog that runs as pure SQL inside Postgres, with no edge function
  in the loop, is the missing piece. Say the word and I will build it.
- The super-admin console's per-org record count still includes deleted rows.
  Deliberate for now — an operator arguably should see everything — but it will
  not match what the customer sees on their own usage screen.
- Dedupe no longer matches deleted records, so re-contacting someone whose
  record was deleted creates a new one rather than reviving the old. There is
  no merge tool if both are later restored.
- `org_assignment_load()`'s batch snapshot can drift within a single page if a
  rule both closes and assigns. Self-corrects on the next page.

---

# 17 September — the audit fixes

Six agents audited every feature area. 91 confirmed defects; `AUDIT-2026-09-17.md`
has all of them. Five blockers are fixed below. **Two blockers remain open** and
are listed at the end.

## Step A — SQL: billing

```
supabase/migrations/20260917090000_billing_plan_change_and_refunds.sql
```

- **A plan change no longer inherits the old period.** Buying Starter annual and
  then Business monthly used to give thirteen months of Business for ₹14,989
  instead of ₹49,990 — ₹35,001, through the ordinary UI. Unused time now carries
  across as value, verified value-conserving to 0.0% across upgrade, downgrade,
  renewal and first purchase.
- **A refund or chargeback now removes access.** There was no refund branch, and
  `effective_plan` selected `subscriptions.status` and never read it, so even a
  manual cancellation revoked nothing.

**Already run — all four checks PASS**, and both diagnostics returned `none`:
nobody had exploited the plan hole, and no payment has ever been granted.

## Step B — Deploy: five blockers

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && supabase functions deploy billing-webhook && supabase functions deploy chat-agent --no-verify-jwt && supabase functions deploy nurture --no-verify-jwt
```

| | Was | Now |
|---|---|---|
| `billing-webhook` | No refund or dispute branch; the idempotency check answered 200 to every refund event | Revokes on refund and chargeback, ahead of the idempotency short-circuit |
| `chat-agent` | `.order("created_at")` is ascending, so the agent read the **oldest** 20 messages and never saw anything after turn 20 | Newest 20, reversed |
| `nurture` | Per-lead failures went to a local array nothing read; a run where 2,400 of 2,500 sends failed wrote `last_status = 'ok'` | Failures set the heartbeat to `warn` and return 500 so `recent_cron_failures()` sees it |
| `nurture` | Due-ness computed in JS **after** fetching, so the oldest 100 leads held the page through their whole waiting window | Due-ness is a query predicate, per step |
| `nurture` | Up to 2,500 sends per run against a 100/day provider tier | Capped at 80 per run, reported when reached |

Simulated on 300 overdue leads: the last lead's first email moves from **day 20
to day 2**, and the list completes in 12 days instead of 30.

## Step C — Frontend

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app/app && npm run build && cd .. && ./scripts/deploy-all.sh
```

- **`router.ts`** — `navigate()` stored the query string as part of the route, so
  `/settings?tab=install` matched nothing and rendered "Page not found" under a
  topbar still saying "Settings". Four of the seven onboarding CTAs landed there.
- **`LeadDetail.tsx`** — discarded the send result, so the toast said "Email sent"
  for a send that returned `sent: 0`.

## Step D — 17 September, later: the watchdog, B8 and the three security findings

**All the SQL below is already applied and verified.** What is left for you is
one terminal block, at the end.

### Already run in Supabase

| Migration | What it did | Result |
|---|---|---|
| `20260914120000_job_watchdog.sql` | The pure-SQL watchdog, scheduled `*/15` | `PASS` — scheduled, reported its own heartbeat, and immediately opened one real incident |
| `20260917110000_webhook_reconciler_fix.sql` | B8 | `PASS` — all checks; no endpoints existed yet, so nothing had been damaged |
| `20260917120000_ssrf_guard_inet.sql` | H4 | `PASS — all 43 cases`, and the constraint is now `VALID` rather than `NOT VALID` |

**The watchdog's first act was to catch something**, which is the outcome you
want from a monitor on install day:

```
system-health [heartbeat] reporting warn: overall warn
```

That is genuine, and Step D's deploy clears it. Three points below.

### What `system-health` was actually warning about

Nothing broken. Three orgs have captured no records recently:

| org | |
|---|---|
| `aa-enterprises` | nothing captured in 35 days |
| `ednex` | nothing captured in 70 days |
| `toppers-hub` | no records captured yet |

AI, replies, automations and credential exposure are `ok` on all five orgs.

But the heartbeat detail was the literal string `overall warn`, which names
nothing — an operator reading it could not tell a quiet demo tenant from the AI
provider being down for every customer. And because a quiet tenant held the
platform status at `warn` permanently, `stale_jobs()` returned `system-health`
on every single call. **A permanently-on alarm is not an alarm**, and that is
precisely how the eight-day outage went unnoticed. Three changes:

- Tenant quietness is now marked `advisory`: still shown on that customer's own
  card, excluded from the rollup that drives alerting. A day-one account gets
  "Nothing's wrong — just quiet" instead of an amber warning.
- The heartbeat detail names the org and the check.
- Every read in the five check functions is now error-checked. `checkSecurity`
  was the worst: a refused read returned **"No keys stored in the database"** —
  the one check whose job is noticing stored credentials could only ever return
  an all-clear when it couldn't see them.

### `nurture` was never broken

It showed `never reported` because it runs once a day at 03:30, and today's
03:30 was *before* the cron secret was fixed. Invoking it directly wrote a
clean heartbeat: `ok | 1 org(s), 0 sent, 0 failed`. No code change needed.

### The three security findings

| | Was | Now |
|---|---|---|
| **H2** widget XSS | `linkify` escaped `& < >` but not `"`, and the URL pattern `[^\s]+` matches a quote — so model output containing `https://x/"onmouseover="…` closed the `href` and ran script **on the customer's own domain** | URLs are matched on raw text, where the charset excludes `" ' < > \``; escaping happens once, last. **124 DOM-parsed assertions**, both widget copies |
| **H3** WhatsApp | `whatsapp_phone_id` is tenant-writable with no ownership check, and the token fell back to the platform's — which owns *every* number on our Meta app. An admin could clear their token, paste another tenant's Phone Number ID, and send as them, billed to us | The platform token is only ever paired with `WHATSAPP_PHONE_ID` from function secrets. A tenant's own token still works normally — Meta's own check covers that case. 10 assertions |
| **H4** SSRF | The guard matched how an address was *spelled*. `https://2852039166/`, `https://0xa9fea9fe/`, `https://0251.0376.0251.0376/` and `https://169.254.43518/` all reach 169.254.169.254 and none start with `169.` | The host is parsed with `inet_aton` semantics and tested by CIDR containment. **43 cases pass**, including every bypass, the near-misses, and the public addresses that must keep working |

Two bugs in my own H4 fix were caught by that case table before it shipped:
the shorthand multiplier was `256^(4-n)` instead of `256^(5-n)`, and numeric
`/` in Postgres is exact division — `::bigint` **rounded**, turning
169.254.169.254 into 170.255.170.254, a public address that passes every
reserved-block test. The guard would have parsed correctly and then approved
the metadata endpoint on its last line. That is why the table asserts exact
addresses rather than just safe/unsafe.

### Also fixed alongside B8

Outbound endpoints could be added and removed but never **paused or resumed**,
while the reconciler could disable one on its own — a one-way door whose only
exit was delete-and-re-add, which issues a new signing secret the customer then
has to redeploy. There is now an active/paused badge, a Resume button, and
resuming clears the failure counter.

### Step D — your terminal

**First, clear a lock I left behind.** Run this before anything else, or your
next `git add` will fail with *"Unable to create '.git/index.lock': File
exists."*

```bash
rm -f ~/Projects/mnb-recovery/repos/abrobot-crm-app/.git/index.lock
```

My fault, and the fourth time. I had a rule against running git *write*
commands and I kept it — but I ran `git status`, and `git status` is not a read:
it refreshes the index, which takes the lock. My sandbox can create that file
and then cannot unlink it. The actual fix, now written down rather than just
intended: **every git command from here uses `git --no-optional-locks`**, which
never takes the lock. Verified working just now.

Then **one line** — `deploy-all.sh` links the project, deploys every function,
verifies what is actually live, builds and copies the frontend, commits and
pushes. You do not need separate git commands.

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && rm -f .git/index.lock && bash scripts/deploy-all.sh "Watchdog, SSRF guard, reconciler, widget XSS, WhatsApp pairing, one-field capture"
```

(The `rm` and the run are combined so the lock cannot be forgotten. Run the
script, don't paste its contents — a pasted multi-line block is how a stray
directory called `#` got created earlier in this project.)

### What changed in that script today

It was missing four functions, including two I had changed on 17 September:
`system-health` and `billing-webhook` were **not in it**, so they would not
have deployed even if you had run it. `billing-checkout` and `rescore-leads`
were missing too.

That is the second time this exact gap has bitten — the script's own comments
record the first, on 6 September, when `api` and `save-integration` were absent
and simply never shipped while everything looked done. A comment saying "keep
this list updated" did not prevent the repeat, so the script now **refuses to
run** if any directory under `supabase/functions/` is absent from its list:

```
    NOT IN THIS SCRIPT: some-new-function
    A function exists but would not be deployed. [...] Refusing to deploy a partial set.
```

The list is also now the single source of truth the deploy calls read from, so
it cannot be updated in one place and forgotten in another.

Then confirm the watchdog goes green — the incident should resolve on the next
tick, within fifteen minutes:

```sql
select job_name, kind, detail, opened_at, resolved_at
  from public.job_incidents order by opened_at desc limit 10;

select job_name, last_status, last_detail, last_run_at
  from public.job_heartbeats order by job_name;
```

`system-health` should read `ok` with a detail like `5 org(s) checked, no
faults (3 advisory)`.

**One optional secret.** If you ever turn on platform-level WhatsApp, set
`WHATSAPP_PHONE_ID` in Edge Functions → Secrets alongside `WHATSAPP_TOKEN`.
Without it, the platform token now refuses to send rather than trusting a
tenant-supplied number — which is the intended behaviour, not a fault. No org
has WhatsApp configured today, so nothing is affected right now.

**Operator alerts are still unconfigured**, deliberately. Incidents are
recorded in `job_incidents` regardless; Telegram is a bonus on top, never the
mechanism. To turn it on, use an operator chat and not a customer's:

```sql
insert into public.app_settings (key, value) values
  ('ops_telegram_bot_token', 'THE_BOT_TOKEN'),
  ('ops_telegram_chat_id',   'THE_CHAT_ID')
on conflict (key) do update set value = excluded.value, updated_at = now();
```

Don't paste either value to me.

---

---

# 22 September — check-in

## ⚠️ Nothing from 17 September has shipped

Confirmed, not assumed: the Integrations screen has no **Resume** button and no
paused-endpoint copy, both of which were added on 17 September. The live
frontend is the pre-17-September build. The last commit is 14 September and the
`.git/index.lock` is still sitting there from the 17th, so nothing was
committed either.

Everything in Step D is still outstanding. Until it runs, the widget XSS fix,
the WhatsApp credential pairing, the one-field capture prompt, the
`system-health` reporting fix and the router fix are all repo-only.

Side effect you can see: the **Platform** item in the sidebar does nothing —
clicking it leaves you on the Dashboard. `/admin` works if you type it. The
app's own 404 page says it: *"This route may still be served by the previous
version of the app."*

## 🐞 New bug — Archive doesn't hide anything

The test record I archived on 17 September appears in **both** lists today:

| | |
|---|---|
| Students | "22 total", archived record among them |
| Archived | same record, "26 days left" |
| Dashboard | "22 Active Students" |

`archive_lead` ran correctly and `deleted_at` is set — a direct count of live
rows returned 20 at the time. The row is reaching the browser anyway, which
means the RLS policy is not carrying its `deleted_at is null` predicate.

The frontend is not at fault and deliberately so: `deleted_at` appears nowhere
in the leads query because 20260903150000 put the rule in RLS *specifically* so
no screen would have to remember it. Only that one migration defines
`leads_read` in this repo, so whatever replaced it did not come from a
migration.

**Impact:** archiving a duplicate, a wrong number, or a record someone asked to
have removed hides nothing, and the record keeps counting toward the plan limit
on screen. `activities` and `conversations` were created in the same block and
are almost certainly affected too.

**Fix written:** `supabase/migrations/20260922090000_soft_delete_rls_repair.sql`
— re-asserts all three policies and adds `check_soft_delete_rls()`.

### Correction — the first fix was aimed at the wrong thing

`check_soft_delete_rls()` did its job and proved my diagnosis wrong:

```
activities.activities_read              -> filters
conversations.conversations_read        -> filters
leads.leads_read                        -> filters
conversations.conversations_org         -> DOES NOT FILTER
conversations.super_read_conversations  -> DOES NOT FILTER
leads.super_all_leads                   -> DOES NOT FILTER
```

`leads_read` was correct the whole time and had been applied. The rule was not
overwritten — it was **out-voted**.

PostgreSQL combines permissive policies with **OR**. A row is visible if *any*
policy allows it. So `leads_read` saying "deleted_at is null AND you're a
member" does nothing while `super_all_leads` sits beside it saying "you're a
super admin" with no such condition. That is why I saw the archived record and
an ordinary counsellor would not have — **this only ever affected super
admins.** Less severe than I reported yesterday.

The three offenders are defined in **no migration in this repo**. They are
legacy policies created in the dashboard before the migration history began,
which is precisely why reading the migrations made everything look right.

The general lesson: tightening one permissive policy is never a fix. It can
only remove a grant that another policy may still be making. 20260922090000
re-asserted three policies that were already correct and changed nothing.

**Real fix:** `supabase/migrations/20260922100000_soft_delete_restrictive.sql`
adds a `RESTRICTIVE` SELECT policy per table. Restrictive policies are AND-ed
after the permissive ones are OR-ed, so the rule cannot be out-voted by any
policy that exists now or is added later — including one created in the
dashboard, which is how this happened.

`SELECT` only, deliberately: `archive_lead`, `restore_lead` and
`archived_leads` are all `SECURITY DEFINER` (verified in 20260903150000), so
the Archived screen and the way back keep working, and `service_role` has
`BYPASSRLS`, so edge functions are untouched.

**Applied and verified 22 September**, in the app rather than only in the
catalogue — a `PASS` from `check_soft_delete_rls()` proves the policy exists,
not that it changed what anyone sees:

| | Before | After |
|---|---|---|
| Students | 22 total, ZZ TEST listed | **21 total**, ZZ TEST gone |
| Archived | ZZ TEST + Restore | **unchanged**, Restore intact |
| nandini | listed | still listed |

Archived surviving is the part worth noting: it confirms the `SECURITY
DEFINER` path really is unaffected by a restrictive policy. That was reasoning
until this check, and a restrictive policy that quietly broke the only route
back from an archive would have been a worse bug than the one it fixed.

One gotcha if you re-run this file: `create or replace function` cannot change
a return type, and the new checker adds a `kind` column — it needs the
`drop function` that now precedes it. Because every statement sits inside one
transaction, the first attempt rolled back cleanly and the policies were never
created. A failed migration that changes nothing is the right outcome; it is
only confusing if you don't notice the `BEGIN`.

## 📬 New enquiries since 17 September

**AbroBot — one new lead, and it is sitting untouched.**

- **nandini** · +919876512345 · captured **18 September** by the AI chat agent
  · stage New · **never contacted** · follow-up was due 19 September.

Six new conversations in five days. One converted; two of the others were
substantial and did not — an 8-message chat yesterday and a 6-message chat five
days ago, both anonymous. That is the pattern the capture-prompt change is
meant to address, and that change is not live yet.

Also worth seeing plainly: **all 22 AbroBot students are in stage "New" and all
22 are overdue.** Nobody has been moved or contacted. The CRM is recording
enquiries faithfully and nothing is being worked.

**MNB Research — 1 record, 11 AI messages this month.** Its chatbot is being
used. There is no way to open another tenant's records from the Platform
console, so a closer look needs a sign-in to that org.

## Two smaller things

- The onboarding checklist says *"Alerts are switched on but there is no
  Telegram bot token or chat ID saved, so nothing can be delivered."* That is
  wrong — the chat ID is saved, and the platform `TELEGRAM_BOT_TOKEN` is what
  delivers. We proved a real alert arriving on 17 September. The checklist only
  looks at the per-org column and ignores the platform fallback, so it nags
  about something that works. (Integrations → **Send test alert** is the button
  to confirm it yourself.)
- The Platform console shows per-tenant counts but offers no way to open a
  tenant's records when supporting them.

---

# 17 September — why no Telegram alerts, and the funnel

**Nothing is broken.** There have been no new leads since **7 September**, so
there was nothing to alert about. Alerts fire on lead creation, not on chat.

Proved end to end rather than inferred: a test lead posted to the capture
webhook returned `{"ok": true, "alert": {"sent": true}, ...}` — Telegram
accepted it. The test lead was soft-deleted immediately; abrobot is back to 20
live records.

The chatbot is healthy: 6 user messages and 6 replies in the last 7 days,
**zero** fallback apologies, model responding, answers coherent and on-topic.

## The actual problem is the first message

| | |
|---|---|
| Conversations | 139 |
| Became a lead | 19 (14%) |
| Bot asked for contact details | 110 conversations |
| …and the visitor left anyway | **93** |
| Conversations that are a single message | **97 of 139 (70%)** |
| Conversion when the visitor sends 3+ messages | **14 of 20 (70%)** |

Read those last two rows together. Once a conversation exists, this bot closes
at 70%. It is very good. But 70% of visitors send one message and never send a
second — and here is what the bot was replying with, verbatim, from 15 September:

> To match you with the best scholarships, I'll need a few quick details:
> • **Full Name \*\*\*** • **Phone Number with +91 \*\*\*** • **Email Address \*\*\***

A three-field form, with required markers, to a stranger who asked one question.
The prompt caused it directly — it said *"collect the visitor's name, phone,
email in one friendly message **before** giving detailed personal guidance"* —
and it contradicted the CLOSER block two lines below, which says *"BE USEFUL
FIRST."* That contradiction is why the behaviour is inconsistent: on
16 September the bot answered three scholarship questions in a row and never
asked at all.

**Changed** (`chat-agent/index.ts`): still asks early, as you chose, but for
**one** field only — `capture_fields[0]`, so reordering that column changes what
it asks for — as a single sentence at the end of a reply that already answered
the question. Forms, bullet lists, asterisks and the word "required" are
explicitly forbidden, as is asking for more than one detail per message. The
remaining fields are collected later, one at a time.

Live after `supabase functions deploy chat-agent --no-verify-jwt` in Step D.
Worth re-checking the 1-message share in a fortnight — that number is the whole
game.

## One thing to decide

`mnb-research` has `notify_new_leads = true` but **no Telegram chat ID**, so its
alerts silently do nothing. The other four orgs all point at the same chat
(`1845062994`, yours) — fine while they are all yours, but the first real
customer org will need its own.

---

## Still open

All eight blockers and the three lead security findings are now closed. What
remains from `AUDIT-2026-09-17.md`:

- **H1 / H5 — no rate limiting on the two unauthenticated write surfaces.**
  `lead-webhook` has no payload cap either and stores the whole body in `raw`.
  `hit_rate_limit()` already exists and is called from exactly one place.
- **H6 / H7 / H8 — unchecked `{ error }` in `nurture` and `chat-agent`.** H6 is
  the sharp one: an unchecked `pipeline_stages` read leaves the `stop` set
  empty, which skips the won/lost guard entirely and emails customers who have
  already bought.
- **H9** — the model dropdown still offers `llama-3.1-8b-instant`, shut down
  2026-08-16, and picking it drops the primary from the fallback chain.
- **H10** — a failed activities read renders "Nothing logged yet."
- The remaining ~80 findings: the unchecked-`{error}` sweep as one mechanical
  pass, then the empty-vs-error states on six screens, then accessibility
  (~59 of 75 inputs have no label; `.pill-green` is 2.24:1).
- **Nothing watches the watchman — now one layer better, not solved.** The
  watchdog runs as pure SQL on pg_cron, so it survives an edge-function or HTTP
  outage. It cannot survive pg_cron itself dying, because it runs on pg_cron.
  The honest mitigation is an external ping, not a cleverer query.
- **Meta payment method by 30 September.** Still the hard deadline.
