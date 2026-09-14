-- AbroBot CRM — why did the automation sweep stop?
--
-- ONE query, deliberately. The previous version of this file was eight separate
-- statements, and the Supabase SQL editor returns only the LAST result set — so
-- running it showed section 8 and silently discarded the seven that mattered.
-- The migrations' verify blocks are single UNION ALL queries for exactly this
-- reason; this file should have been one from the start.
--
-- ════════════════════════════════════════════════════════════════════════════
-- What section 8 already told us
-- ════════════════════════════════════════════════════════════════════════════
--   Flag stalled records | no_contact_for | 168 | 2026-09-06 06:06:27 | 1642
--
-- run_count = 1642 means the sweep worked, for weeks. last_run_at = 6 September
-- means it stopped. So this is not "never configured" — it is "was working,
-- died on 6 September", eight days ago.
--
-- The date is the tell. 20260903140000 (the cron secret migration) was applied
-- 5 September 17:14. The sweep kept running until the next morning — the last
-- run from the OLD deployment — and has not run since the functions were
-- redeployed with requireCronOrMember. Every run since has been rejected at the
-- door, or never sent at all.
--
-- Three candidates, and the query below distinguishes them:
--
--   A. app_settings.cron_secret is still 'REPLACE_WITH_YOUR_CRON_SECRET' (or
--      absent). call_edge_function RAISES rather than sending, so pg_cron logs
--      a failure and no HTTP request is ever made.
--   B. The secret is set but differs from the CRON_SECRET deployed to the edge
--      runtime → every call returns 401.
--   C. CRON_SECRET was never added in the Supabase dashboard → cron-auth fails
--      closed with 503 and refuses everything.
--
-- Read-only. Paste the whole file, run, send me the result.

with
placeholder as (select 'REPLACE_WITH_YOUR_CRON_SECRET'::text as v),

secret as (
  select s.value,
         (select v from placeholder) = s.value as is_placeholder,
         length(s.value)   as len,
         s.updated_at
    from public.app_settings s
   where s.key = 'cron_secret'
),

jobs as (
  select count(*)                                   as n,
         count(*) filter (where active)              as n_active,
         string_agg(jobname || ' [' || schedule || ']'
                    || case when active then '' else ' INACTIVE' end, ', '
                    order by jobname)                as list
    from cron.job
),

autorun as (
  select count(*) as n,
         max(r.start_time) as last_at,
         (array_agg(r.status || ' — ' || coalesce(left(r.return_message, 120), 'no message')
                    order by r.start_time desc))[1] as latest
    from cron.job_run_details r
    join cron.job j on j.jobid = r.jobid
   where j.jobname like '%automation%'
),

http as (
  select count(*) as n,
         count(*) filter (where status_code = 401)           as n_401,
         count(*) filter (where status_code = 503)           as n_503,
         count(*) filter (where status_code between 200 and 299) as n_ok,
         (array_agg(coalesce(status_code::text, 'no status') || ' — '
                    || coalesce(left(coalesce(error_msg, content::text), 140), '')
                    order by created desc))[1] as latest
    from net._http_response
   where created > now() - interval '24 hours'
)

select * from (
  select 1 as ord, 'VERDICT' as check,
         case
           when not exists (select 1 from secret)
             then 'app_settings has no cron_secret row → call_edge_function raises every time. Cause A.'
           when (select is_placeholder from secret)
             then 'cron_secret is still the placeholder REPLACE_WITH_YOUR_CRON_SECRET → call_edge_function raises before sending. Cause A. This is almost certainly it.'
           when (select n_401 from http) > 0
             then 'The database is sending a secret the edge runtime rejects → 401. Cause B: the two values differ.'
           when (select n_503 from http) > 0
             then 'The edge runtime has no CRON_SECRET set and is refusing everything → 503. Cause C.'
           when (select n_active from jobs) = 0
             then 'No ACTIVE cron jobs. Whatever else is true, nothing is being scheduled.'
           when (select n from autorun) = 0
             then 'The job exists but pg_cron has no record of running it. Check the schedule expression.'
           else 'No single cause stands out — read the rows below and send them to me.'
         end as detail

  union all select 2, 'cron jobs',
         coalesce((select n_active || ' active of ' || n || ' — ' || coalesce(list, '(none)') from jobs), '(cron.job unreadable)')

  union all select 3, 'sweep attempts logged by pg_cron',
         case when (select n from autorun) = 0
              then 'NONE — pg_cron has never recorded running an automation job'
              else (select n || ' attempt(s), most recent ' || coalesce(last_at::text, '?')
                         || ' → ' || coalesce(latest, '?') from autorun) end

  union all select 4, 'HTTP results in the last 24h',
         case when (select n from http) = 0
              then 'none recorded (net._http_response self-purges after a few hours, so this is not proof of health)'
              else (select n || ' response(s): ' || n_ok || ' ok, ' || n_401 || ' unauthorised, '
                         || n_503 || ' refused. Most recent: ' || coalesce(latest, '?') from http) end

  union all select 5, 'cron_secret in app_settings',
         coalesce((select case when is_placeholder
                               then 'STILL THE PLACEHOLDER — never replaced'
                               else 'set, ' || len || ' chars, sha256 '
                                    || left(encode(digest(value, 'sha256'), 'hex'), 12) end
                         || ', last changed ' || updated_at::text
                    from secret),
                  'NO ROW AT ALL')

  union all select 6, 'job heartbeats',
         coalesce((select string_agg(job_name || ': ' ||
                    case when last_detail = 'never reported' then 'NEVER RAN'
                         when now() - last_run_at > stale_after then 'LATE by '
                              || round(extract(epoch from (now() - last_run_at - stale_after))/3600.0, 1) || 'h'
                         when coalesce(last_status,'ok') <> 'ok' then 'status ' || last_status
                         else 'ok' end, '; ' order by job_name)
                    from public.job_heartbeats), '(none)')

  union all select 7, 'automation runs, last 14 days',
         coalesce((select string_agg(d || ': ' || c, '; ' order by d desc)
                     from (select date_trunc('day', created_at)::date as d, count(*) as c
                             from public.automation_runs
                            where created_at > now() - interval '14 days'
                            group by date_trunc('day', created_at)::date) x),
                  'NONE in 14 days — no rule has fired at all, event-driven included')

  union all select 8, 'enabled time-based rules',
         coalesce((select string_agg(o.slug || '/' || a.name || ' (last ' ||
                    coalesce(a.last_run_at::date::text, 'never') || ', ' || coalesce(a.run_count,0) || ' runs)', '; ')
                     from public.automations a
                     join public.organizations o on o.id = a.org_id
                    where a.enabled and a.trigger not in ('lead_created','stage_changed')), '(none)')

  union all select 9, 'days since the sweep last touched a rule',
         coalesce((select round(extract(epoch from (now() - max(a.last_run_at)))/86400.0, 1)::text
                     from public.automations a
                    where a.enabled and a.trigger not in ('lead_created','stage_changed')),
                  'n/a')
) t
order by ord;
