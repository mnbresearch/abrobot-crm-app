# Free-tier hardening — what replaces Supabase Pro

Everything the audit flagged as "needs Pro" now has a free equivalent, except
one thing I'll be honest about at the end.

| Gap | Pro solution | What I built instead | Cost |
|---|---|---|---|
| No backups | PITR (~₹2,000/mo) | Nightly encrypted `pg_dump` → GitHub artifact, 90-day retention, self-verifying | £0 |
| No undo | PITR | Soft delete with 30-day restore | £0 |
| Cron dies silently | — | Heartbeat table + `stale_jobs()` + reads `net._http_response` | £0 |
| 4 open endpoints | — | Shared cron secret, fails closed | £0 |
| No CI | — | GitHub Action: typecheck, build, tests, SQL parse | £0 |
| Storage fills | bigger plan | Purge job on archived rows + `automation_runs` | £0 |

---

## Do these in order

### 1. Backups — 5 minutes, biggest single win

Two repository secrets: **Settings → Secrets and variables → Actions**.

- `SUPABASE_DB_URL` — Supabase → Project Settings → Database → Connection
  string → URI. **Use the session pooler (port 5432), not 6543** — `pg_dump`
  needs prepared statements.
- `BACKUP_PASSPHRASE` — `openssl rand -base64 32`

**Store the passphrase somewhere that is not this repo.** Without it the
backups are unreadable, which is the entire point of encrypting them.

Then run it once by hand — Actions → "Nightly database backup" → Run workflow —
rather than waiting for 01:00 IST to find out whether it works.

The job verifies itself: it decrypts the backup back, checks it's over 10 KB,
confirms `organizations`, `leads`, `profiles` and `agent_config` are present,
and checks for PostgreSQL's completion marker. A 200-byte "backup" that is
really an auth error fails the build instead of sitting there looking healthy.

**Rehearse a restore on a scratch Supabase project before you need one.** An
untested backup is a hope, not a backup.

### 2. Cron secret — order matters, or you break your own jobs

**This sequence, not any other:**

1. `openssl rand -hex 32` → Supabase → Edge Functions → Secrets → `CRON_SECRET`
2. Deploy the four functions:
   ```
   cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && npx -y supabase@latest functions deploy run-automations --no-verify-jwt && npx -y supabase@latest functions deploy nurture --no-verify-jwt && npx -y supabase@latest functions deploy system-health --no-verify-jwt && npx -y supabase@latest functions deploy summarize-chats --no-verify-jwt
   ```
3. Edit `20260903140000_cron_secret_and_heartbeat.sql` — replace
   `REPLACE_WITH_YOUR_CRON_SECRET` with the same string — then run it.

Between steps 2 and 3 the jobs will 401. That is deliberate: it fails in the
safe direction. The reverse order would leave the endpoints open while you
believed they were closed.

The guard **fails closed** when `CRON_SECRET` is unset. `app-signup` shipped
the opposite pattern (`if (SECRET && header !== SECRET)`) and was
unauthenticated in production because unset is the deployment default.

**The unsubscribe link stays public** — I checked the ordering explicitly. The
guard sits after that branch, so `?unsub=` still works without a secret, which
it must.

### 3. Soft delete

Run `20260903150000_soft_delete.sql`. Deleting becomes an UPDATE that hides the
row; it's restorable for 30 days, then purged nightly.

Enforced in RLS, not in queries — so every screen, every edge function and
every direct PostgREST call gets the same answer, and nobody has to remember
`.is("deleted_at", null)` on a new query.

```sql
select public.archive_lead('<uuid>');
select * from public.archived_leads();
select public.restore_lead('<uuid>');
```

The same job purges `automation_runs` older than 90 days. That table is the
fastest-growing thing in the schema — one row per rule per lead per fire,
forever, with nothing deleting it. On a 500 MB free tier it's a real ceiling.

The UI still has no Archive button; these are RPCs ready to wire up.

### 4. CI

Nothing to configure — it runs on the next push. Typecheck, build, `deno check`
on every edge function, the three committed test files (which existed and were
never run by anything), and a parse check on every migration.

It also fails the build if a bundle references a source map, so the leak I
fixed can't quietly come back.

### 5. Optional: alerts that reach you

Two more repo secrets, `OPS_TELEGRAM_BOT_TOKEN` and `OPS_TELEGRAM_CHAT_ID`, and
the backup job will tell you whether it worked. Without them, a backup job
failing for three weeks looks exactly like one that's working.

---

## After it's running

```sql
select * from public.job_heartbeats order by last_run_at;
select * from public.stale_jobs();
select * from public.recent_cron_failures(24);
```

`stale_jobs()` is the one that matters. `pg_cron` only records that the
*statement* succeeded — which it does the moment `pg_net` queues the request —
so a job whose HTTP call 500s every night has always looked healthy. A job that
stops reporting now shows up here.

`recent_cron_failures()` reads `net._http_response`, where the real status
codes were going and being discarded.

---

## What this does NOT fix

**Project pause.** Free Supabase projects pause after ~7 days of inactivity.
Yours stays awake only because `pg_cron` fires every 15 minutes — that's
load-bearing infrastructure you didn't intend. If cron ever stops, the project
sleeps and everything goes down for every customer at once, and nothing
monitors it because `system-health` runs *inside* the thing that paused.

The free mitigation is an external pinger (UptimeRobot's free tier, 5-minute
checks) against `chat-agent?org=abrobot&config=1`. It has to live outside
Supabase to be useful — I can't set that up for you, but it's a two-minute job
and it's also your outage detector.

**Recovery granularity.** PITR restores to the second. This restores to last
night. For a five-tenant CRM that is a reasonable trade at zero cost, but it is
a trade, and the honest framing is "up to 24 hours of data loss" rather than
"we have backups".

**Connection limits.** You're already seeing 503s on parallel queries at 21
records. That's a free-tier symptom no amount of code fixes.

My read: this gets you to a defensible position for launching to a handful of
customers. Revisit Pro when a customer's data loss would cost more than
₹2,000 — which, for a business paying you ₹4,999/month, is roughly immediately.
