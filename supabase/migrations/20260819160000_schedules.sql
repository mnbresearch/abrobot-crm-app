-- AbroBot CRM — scheduled jobs.
-- Run AFTER deploying run-automations, system-health and nurture.
--
-- Uses pg_cron + pg_net, both available on Supabase, so the schedule lives in
-- the database next to everything else rather than in a third-party scheduler
-- that nobody remembers exists.
--
-- All three functions are deployed with --no-verify-jwt, so the publishable
-- key is sufficient here. That key is public by design (it ships in the
-- browser bundle); RLS and the service role are what actually protect data.
--
-- Idempotent: unschedules by name first, so re-running is safe.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── helper ──────────────────────────────────────────────────────────────────
-- Wraps the HTTP call so each schedule below stays readable, and so the URL
-- and key live in exactly one place.
create or replace function public.call_edge_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  req_id bigint;
begin
  select net.http_post(
    url     := 'https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/' || p_name,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable__p-fQqmGXL0dPB5InuCznQ_U0NxtXIc'
    ),
    body    := p_body,
    timeout_milliseconds := 55000
  ) into req_id;
  return req_id;
end;
$$;

comment on function public.call_edge_function is
  'Fire-and-forget POST to an edge function from pg_cron. Returns the pg_net request id.';

-- ── schedules ───────────────────────────────────────────────────────────────

-- Time-based automations: no_contact_for, follow_up_overdue, score thresholds.
-- Every 15 minutes — frequent enough that "chase after 48h" means 48h and not
-- 48h-plus-a-day, cheap enough to be free.
select cron.unschedule('abrobot-run-automations')
  where exists (select 1 from cron.job where jobname = 'abrobot-run-automations');

select cron.schedule(
  'abrobot-run-automations',
  '*/15 * * * *',
  $$select public.call_edge_function('run-automations', '{}'::jsonb)$$
);

-- Self-monitoring. Hourly with alert:true so a provider outage surfaces in an
-- hour rather than the three days the Groq shutdown went unnoticed.
select cron.unschedule('abrobot-system-health')
  where exists (select 1 from cron.job where jobname = 'abrobot-system-health');

select cron.schedule(
  'abrobot-system-health',
  '0 * * * *',
  $$select public.call_edge_function('system-health', '{"alert": true}'::jsonb)$$
);

-- Nurture emails. Once daily at 09:30 UTC (15:00 IST) — inside working hours
-- for an Indian audience, so replies land when someone is there to answer.
select cron.unschedule('abrobot-nurture')
  where exists (select 1 from cron.job where jobname = 'abrobot-nurture');

select cron.schedule(
  'abrobot-nurture',
  '30 9 * * *',
  $$select public.call_edge_function('nurture', '{}'::jsonb)$$
);

-- ── inspect ─────────────────────────────────────────────────────────────────
-- Scheduled jobs:
--   select jobid, jobname, schedule, active from cron.job order by jobname;
--
-- Recent runs (did they fire, did they succeed):
--   select j.jobname, r.status, r.start_time, r.return_message
--     from cron.job_run_details r
--     join cron.job j on j.jobid = r.jobid
--    order by r.start_time desc limit 20;
--
-- HTTP responses from pg_net (the function's actual reply):
--   select id, status_code, left(content, 300) as body, created
--     from net._http_response order by created desc limit 10;
--
-- To pause one without deleting it:
--   update cron.job set active = false where jobname = 'abrobot-nurture';
