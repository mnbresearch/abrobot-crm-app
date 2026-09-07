-- Two jobs to sort out. Run the whole file; the last SELECT is the report.
--
-- Note on style: the schedule below is a PLAIN TOP-LEVEL STATEMENT, not wrapped
-- in a DO block. My previous attempt hid its own failure inside `raise notice`,
-- which is why reconcile-webhooks silently never appeared. If this errors, you
-- will see the error.

-- ── 1. What do the two nurture jobs actually send? ──────────────────────────
-- `nurture-daily` and `abrobot-nurture` both call the same function.
-- The rewritten nurture runs EVERY organisation when the body is empty, so a
-- leftover single-tenant job is now either a duplicate full sweep or a second
-- pass over AbroBot. Nobody receives two emails — the gap check
-- (nurture_last_sent_at + GAP_HOURS) prevents that — but one job is redundant
-- and redundant scheduled jobs are how confusion starts.
select jobname, schedule, command
  from cron.job
 where jobname in ('nurture-daily', 'abrobot-nurture')
 order by jobname;

-- ── 2. Schedule the reconciler ──────────────────────────────────────────────
-- Safe to re-run: unschedule first, then schedule.
select cron.unschedule('reconcile-webhooks')
 where exists (select 1 from cron.job where jobname = 'reconcile-webhooks');

select cron.schedule(
  'reconcile-webhooks',
  '*/5 * * * *',
  'select public.reconcile_webhook_deliveries();'
);

-- ── 3. Report ───────────────────────────────────────────────────────────────
select jobname, schedule, active
  from cron.job
 order by jobname;

-- ── 4. When you have looked at the commands in step 1 ───────────────────────
-- If abrobot-nurture is the leftover single-tenant job, remove it — the
-- multi-tenant nurture-daily covers AbroBot along with everyone else:
--
--   select cron.unschedule('abrobot-nurture');
--
-- Do NOT remove nurture-daily: that is the one that runs every organisation.
