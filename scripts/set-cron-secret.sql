-- AbroBot CRM — restore the cron secret.
--
-- ════════════════════════════════════════════════════════════════════════════
-- What happened
-- ════════════════════════════════════════════════════════════════════════════
-- 20260903140000 added a shared-secret header so the four open cron endpoints
-- could not be triggered by anyone who guessed a URL. It seeded app_settings
-- with the literal 'REPLACE_WITH_YOUR_CRON_SECRET' and required a human to
-- replace it. That never happened.
--
-- call_edge_function refuses to send when it sees the placeholder, so since
-- 6 September every scheduled HTTP call has raised instead of firing:
--
--   2,502 attempts, all failed:
--   ERROR: cron_secret is not configured in app_settings
--
-- Eight days. The failure was recorded every fifteen minutes in
-- cron.job_run_details — a table nothing reads.
--
-- ════════════════════════════════════════════════════════════════════════════
-- What was actually affected
-- ════════════════════════════════════════════════════════════════════════════
-- Only the three jobs that call an edge function over HTTP:
--
--   abrobot-run-automations   every 15 min   time-based rules
--   nurture-daily             03:30 daily    ALL follow-up email, every tenant
--   abrobot-system-health     hourly         the operator alerting
--
-- The other four are pure SQL inside the database and never stopped:
-- mark-lapsed-subscriptions, purge-archived, prune-webhook-deliveries,
-- reconcile-webhooks. So billing still lapsed correctly, retention still
-- purged, and failed webhooks were still retried.
--
-- Note the second item and the third together: the job that exists to tell you
-- a job has stopped was itself one of the stopped jobs.
--
-- ════════════════════════════════════════════════════════════════════════════
-- How to use this file
-- ════════════════════════════════════════════════════════════════════════════
-- Two places must hold the SAME value, and the value must never be pasted into
-- a chat window or committed.
--
--   1. Run PART 1 below. It generates a random secret, stores it, and prints
--      it once. Copy that value.
--
--   2. Supabase Dashboard → Edge Functions → Secrets → Add new secret
--        Name:  CRON_SECRET
--        Value: (paste)
--      Save.
--
--   3. Redeploy the three functions so they pick the secret up:
--        supabase functions deploy run-automations --no-verify-jwt
--        supabase functions deploy nurture         --no-verify-jwt
--        supabase functions deploy system-health
--
--   4. Run PART 2 to confirm the loop closed. Wait for :00, :15, :30 or :45.
--
-- If you would rather choose the value yourself, skip PART 1 and run:
--   update public.app_settings set value = 'your-secret', updated_at = now()
--    where key = 'cron_secret';


-- ════════════════════════════════════════════════════════════════════════════
-- PART 1 — generate, store, and show it once
-- ════════════════════════════════════════════════════════════════════════════
-- 32 random bytes as hex: 64 characters, no punctuation, safe in an HTTP
-- header and safe to paste into a dashboard field without quoting surprises.

insert into public.app_settings (key, value, updated_at)
values ('cron_secret', encode(gen_random_bytes(32), 'hex'), now())
on conflict (key) do update
  set value = encode(gen_random_bytes(32), 'hex'),
      updated_at = now();

-- COPY THIS VALUE into the Supabase dashboard as CRON_SECRET.
-- It is shown here and nowhere else. If you lose it, re-run PART 1 — it
-- generates a fresh one, and you simply update the dashboard to match.
select 'COPY THIS INTO Edge Functions → Secrets → CRON_SECRET' as instruction,
       value as cron_secret
  from public.app_settings
 where key = 'cron_secret';


-- ════════════════════════════════════════════════════════════════════════════
-- PART 2 — verify, AFTER the dashboard secret is saved and the three
--          functions are redeployed. Run it on the quarter hour.
-- ════════════════════════════════════════════════════════════════════════════
-- Run this block on its own — the SQL editor shows only the last result.
/*
select * from (
  select 1 as ord, 'the placeholder is gone' as check,
         case when value = 'REPLACE_WITH_YOUR_CRON_SECRET'
              then 'FAIL — still the placeholder'
              else 'PASS — ' || length(value) || ' chars, set ' || updated_at::text end as detail
    from public.app_settings where key = 'cron_secret'

  union all
  select 2, 'the most recent scheduled attempt',
         coalesce((select r.status || ' at ' || r.start_time::text
                        || coalesce(' — ' || left(r.return_message, 120), '')
                     from cron.job_run_details r
                     join cron.job j on j.jobid = r.jobid
                    where j.jobname = 'abrobot-run-automations'
                    order by r.start_time desc limit 1),
                  'no attempts recorded')

  union all
  select 3, 'HTTP responses in the last hour',
         coalesce((select count(*) || ' response(s): '
                        || count(*) filter (where status_code between 200 and 299) || ' ok, '
                        || count(*) filter (where status_code = 401) || ' unauthorised, '
                        || count(*) filter (where status_code >= 500) || ' server error'
                     from net._http_response where created > now() - interval '1 hour'),
                  'none')

  union all
  select 4, 'heartbeats',
         coalesce((select string_agg(job_name || ': ' ||
                    case when last_detail = 'never reported' then 'STILL NEVER RAN'
                         else coalesce(last_status, '?') || ' at ' || last_run_at::text end,
                    '; ' order by job_name)
                    from public.job_heartbeats), '(none)')

  union all
  select 5, 'the stalled-records rule',
         coalesce((select 'last run ' || coalesce(a.last_run_at::text, 'never')
                        || ', ' || coalesce(a.run_count, 0) || ' runs'
                     from public.automations a
                    where a.name = 'Flag stalled records' limit 1),
                  '(not found)')
) t order by ord;
*/

-- Expected once it is working: check 2 shows `succeeded`, check 3 shows at
-- least one 2xx and zero 401s, and check 4 shows run-automations with a
-- timestamp from the last fifteen minutes instead of STILL NEVER RAN.
--
-- A 401 in check 3 means the two values differ — the dashboard secret is not
-- what PART 1 stored. Re-copy it.
