-- AbroBot CRM — why has run-automations never reported?
--
-- Prompted by this, on 14 September:
--
--   job_name        | last_run_at                   | last_status | last_detail
--   run-automations | 2026-09-05 17:14:20.904344+00 | unknown     | never reported
--
-- Those are the exact values 20260903140000 SEEDS the row with. `unknown` /
-- `never reported` is not a run that went wrong — it is the placeholder saying
-- no run has ever reached the heartbeat call, and the timestamp is when that
-- migration was applied, not when anything executed.
--
-- The heartbeat is the LAST statement in run-automations, so this means one of:
--
--   A. the cron job is not scheduled, or is scheduled under another name
--   B. it is scheduled and firing, but the HTTP call is rejected (401 — the
--      cron secret in app_settings does not match the deployed CRON_SECRET)
--   C. the call arrives and the function throws before the heartbeat line
--
-- stale_after for this job is 45 minutes, so stale_jobs() has been flagging it
-- for nine days. Nothing reads stale_jobs() except the super-admin screen,
-- which is the second finding here: the alarm worked and nobody was listening.
--
-- Read-only. Run the whole thing and send me all seven results.

-- ════════════════════════════════════════════════════════════════════════════
-- A. Is it scheduled at all?
-- ════════════════════════════════════════════════════════════════════════════
select '1. scheduled jobs' as section, jobid, jobname, schedule, active,
       left(command, 90) as command
  from cron.job
 order by jobname;

-- ════════════════════════════════════════════════════════════════════════════
-- B. Has it actually been firing, and what did pg_cron think happened?
-- ════════════════════════════════════════════════════════════════════════════
-- pg_cron calls this a success the moment pg_net QUEUES the request, so
-- "succeeded" here means almost nothing. Absence of rows, however, is
-- conclusive: it never ran.
select '2. recent run attempts' as section,
       j.jobname, r.status, r.return_message, r.start_time
  from cron.job_run_details r
  join cron.job j on j.jobid = r.jobid
 where j.jobname like '%automation%'
 order by r.start_time desc
 limit 20;

-- ════════════════════════════════════════════════════════════════════════════
-- C. What did the HTTP call actually return?
-- ════════════════════════════════════════════════════════════════════════════
-- This is the one that matters. net._http_response self-purges after a few
-- hours, so an empty result is not proof of health — but a 401 here is proof
-- of the cause.
select '3. http results (last 6h)' as section,
       id, status_code, left(coalesce(error_msg, content::text), 200) as detail, created
  from net._http_response
 where created > now() - interval '6 hours'
 order by created desc
 limit 30;

-- Same thing through the helper, which filters to failures only.
select '4. recorded cron failures' as section, *
  from public.recent_cron_failures(50);

-- ════════════════════════════════════════════════════════════════════════════
-- D. Is the secret the function is checking the same one cron is sending?
-- ════════════════════════════════════════════════════════════════════════════
-- The VALUE is never printed. What matters is whether a row exists, when it was
-- last changed, and its length and fingerprint — enough to compare against the
-- deployed CRON_SECRET without either of us pasting a secret into a chat.
select '5. cron secret' as section,
       case when exists (select 1 from public.app_settings where key = 'cron_secret')
            then 'present' else 'MISSING — this alone would explain everything' end as state,
       (select length(value) from public.app_settings where key = 'cron_secret') as length,
       (select left(encode(digest(value, 'sha256'), 'hex'), 12)
          from public.app_settings where key = 'cron_secret') as sha256_prefix,
       (select updated_at from public.app_settings where key = 'cron_secret') as last_changed;

-- ════════════════════════════════════════════════════════════════════════════
-- E. Every job's health, not just this one
-- ════════════════════════════════════════════════════════════════════════════
select '6. all heartbeats' as section,
       job_name, last_run_at, last_status, left(coalesce(last_detail, ''), 80) as detail,
       stale_after,
       case when last_detail = 'never reported' then 'NEVER RAN'
            when now() - last_run_at > stale_after then 'LATE'
            when coalesce(last_status, 'ok') <> 'ok' then 'UNHEALTHY'
            else 'ok' end as verdict
  from public.job_heartbeats
 order by job_name;

-- ════════════════════════════════════════════════════════════════════════════
-- F. What was missed
-- ════════════════════════════════════════════════════════════════════════════
-- If the sweep has not run since 5 September, no time-based rule has fired in
-- nine days. This shows whether that is visible in the data: automation_runs
-- should contain event-fired rows (lead_created / stage_changed still work,
-- they run inline at intake) and nothing from the cron triggers.
select '7. automation activity by day' as section,
       date_trunc('day', r.created_at)::date as day,
       count(*) as runs,
       count(*) filter (where a.trigger in ('lead_created','stage_changed')) as event_fired,
       count(*) filter (where a.trigger not in ('lead_created','stage_changed')) as time_fired
  from public.automation_runs r
  join public.automations a on a.id = r.automation_id
 where r.created_at > now() - interval '21 days'
 group by 1
 order by 1 desc;

-- And whether there are any time-based rules that SHOULD have been firing.
select '8. enabled time-based rules' as section,
       o.slug, a.name, a.trigger, a.trigger_value, a.last_run_at, a.run_count
  from public.automations a
  join public.organizations o on o.id = a.org_id
 where a.enabled
   and a.trigger not in ('lead_created', 'stage_changed')
 order by o.slug, a.name;
