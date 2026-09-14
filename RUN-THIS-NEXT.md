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
