-- Why is the webhook reconciler not scheduled — and is anything else?
--
-- "webhook reconciler is scheduled" came back FAIL, which means section 5 of
-- 20260906100000 did not take effect. That section sits AFTER the `commit;`
-- and BEFORE the verification that errored, so on the face of it it should
-- have run. It didn't, so the assumption is wrong somewhere and guessing is
-- not good enough.
--
-- This is also the moment to check something never verified: that the OTHER
-- scheduled jobs exist at all. If cron.job is empty, then nurture, the
-- automation sweep and the health check have never run on a schedule, and the
-- heartbeats added yesterday would report stale forever — correctly.

-- ── 1. Is pg_cron even installed, and where? ────────────────────────────────
select
  'pg_cron installed' as check,
  coalesce(
    (select 'yes, in schema ' || n.nspname
       from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'pg_cron'),
    'NO — nothing can be scheduled. Enable it: Database -> Extensions -> pg_cron'
  ) as result;

-- ── 2. What is actually scheduled right now? ────────────────────────────────
-- Expect rows for the nurture / automation / health / rescore jobs as well as
-- the reconciler. An empty result means no scheduled work happens at all.
select jobid, jobname, schedule, active, command
  from cron.job
 order by jobname;

-- ── 3. Did the recent runs succeed? ─────────────────────────────────────────
-- status 'failed' here with a 401 in the message means CRON_SECRET in the
-- database does not match the one set in Edge Function secrets.
select j.jobname, r.status, r.return_message, r.start_time
  from cron.job_run_details r
  join cron.job j on j.jobid = r.jobid
 order by r.start_time desc
 limit 20;

-- ── 4. Schedule the reconciler, reporting what happened ─────────────────────
-- Idempotent: unschedules first if present, so re-running is safe.
do $$
declare v_id bigint;
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron is not available — skipping. See check 1 above.';
    return;
  end if;

  perform cron.unschedule('reconcile-webhooks')
   where exists (select 1 from cron.job where jobname = 'reconcile-webhooks');

  select cron.schedule('reconcile-webhooks', '*/5 * * * *',
                       'select public.reconcile_webhook_deliveries();')
    into v_id;

  raise notice 'reconcile-webhooks scheduled as job %', v_id;
end $$;

-- ── 5. Confirm ──────────────────────────────────────────────────────────────
select 'reconciler is scheduled' as check,
       case when exists (select 1 from cron.job where jobname = 'reconcile-webhooks')
            then 'PASS' else 'FAIL — see the notices above' end as result
union all
select 'heartbeats reporting',
       coalesce((select string_agg(job_name || '=' || last_status, ', ')
                   from public.job_heartbeats), 'none yet — jobs have not run since the deploy')
union all
select 'jobs considered stale',
       coalesce((select string_agg(job_name, ', ') from public.stale_jobs()), 'none');
