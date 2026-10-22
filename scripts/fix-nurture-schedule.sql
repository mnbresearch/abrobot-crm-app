-- AbroBot CRM — restore the daily follow-up email (nurture) job.
--
-- Found 14 Oct 2026: job_heartbeats says nurture last reported on 17 September,
-- while three workspaces have automatic follow-up switched on. Either its cron
-- entry was removed (scripts/cron-tidy.sql once advised unscheduling one of two
-- duplicates) or every run since has failed before reporting.
--
-- This script:
--   1. keeps EXACTLY ONE nurture job, named abrobot-nurture, at 09:30 UTC
--      (15:00 IST) calling the multi-tenant nurture function — the same entry
--      20260819160000_schedules.sql defines. A leftover nurture-daily is removed
--      so follow-ups are never sent twice a day.
--   2. reports what the last runs actually returned, so a failing function is
--      visible rather than silent.
-- Safe to re-run. Run the whole file; the last statement is the report.

select cron.unschedule('nurture-daily')
  where exists (select 1 from cron.job where jobname = 'nurture-daily');

select cron.unschedule('abrobot-nurture')
  where exists (select 1 from cron.job where jobname = 'abrobot-nurture');

select cron.schedule(
  'abrobot-nurture',
  '30 9 * * *',
  $$select public.call_edge_function('nurture', '{}'::jsonb)$$
);

select 'nurture jobs scheduled' as item,
       string_agg(jobname || ' @ ' || schedule || case when active then '' else ' (INACTIVE)' end, '; ') as detail
  from cron.job where command ilike '%nurture%'
union all
select 'last 5 nurture cron runs',
       coalesce(string_agg(to_char(r.start_time, 'DD Mon HH24:MI') || ' ' || r.status || ' ' ||
                           left(coalesce(r.return_message, ''), 60), ' | ' order by r.start_time desc), 'none recorded')
  from (select r.* from cron.job_run_details r join cron.job j on j.jobid = r.jobid
         where j.command ilike '%nurture%' order by r.start_time desc limit 5) r
union all
select 'nurture heartbeat',
       last_status || ' at ' || to_char(last_run_at, 'DD Mon HH24:MI') || ' — ' || coalesce(last_detail, '')
  from public.job_heartbeats where job_name = 'nurture'
union all
select 'workspaces with follow-up on',
       count(*)::text from public.agent_config where nurture_enabled is true;
-- After tomorrow 09:30 UTC the heartbeat should show today's date. If it does
-- not, open Supabase → Edge Functions → nurture → Logs for that time.
