-- AbroBot CRM — read-only check of live configuration.
--
-- Run the whole file in the Supabase SQL editor (project pomsltnrxvbcafwtbtlc).
-- It is ONE query, so the editor shows every row. It changes nothing: no
-- inserts, updates, DDL or temp objects — only SELECTs against the catalog,
-- cron.job and a handful of settings rows. Safe to run at any time.
--
-- Every row is   section | item | verdict | detail
--   PASS   as expected
--   CHECK  look at it — not necessarily wrong, but a human should decide
--   INFO   context only
--
-- Secret values are never printed: rows say "set" / "missing", not the value.
--
-- What it covers:
--   1. cron.job — every scheduled job, duplicate nurture jobs, the jobs that
--      must exist, and any job that failed in the last 24 hours
--   2. app_settings — cron secret and the operator (ops) Telegram alert target
--   3. RLS policies on the tables that hold credentials or per-tenant content
--   4. public tables with row-level security switched OFF
--   5. SECURITY DEFINER functions the anon role can execute
--   6. the mnb-research organisation: Telegram chat id and member count

with
-- ── 1. cron ──────────────────────────────────────────────────────────────────
jobs as (
  select jobname, schedule, active, command from cron.job
),
recent_failures as (
  select j.jobname, count(*) as n, max(r.start_time) as last_at,
         (array_agg(left(coalesce(r.return_message, ''), 120) order by r.start_time desc))[1] as last_msg
    from cron.job_run_details r
    join cron.job j on j.jobid = r.jobid
   where r.status = 'failed' and r.start_time > now() - interval '24 hours'
   group by j.jobname
),
required_jobs(jobname, what) as (
  values ('abrobot-run-automations', 'run-automations every 15 min'),
         ('abrobot-system-health',   'system-health hourly (operator alerts)'),
         ('reconcile-webhooks',      'outbound webhook retries'),
         ('mark-lapsed-subscriptions','plan expiry'),
         ('purge-archived',          '30-day archive purge'),
         ('abrobot-checkout-recovery','abandoned checkout reminders'),
         ('job-watchdog',            'scheduled job failure detector')
),
-- ── 3. policies ──────────────────────────────────────────────────────────────
sensitive(tbl) as (
  values ('agent_config'), ('profiles'), ('webhook_keys'), ('message_templates'),
         ('chat_messages'), ('imports')
),
pol as (
  select s.tbl,
         c.oid is not null                        as exists_,
         coalesce(c.relrowsecurity, false)        as rls_on,
         count(p.policyname)                      as n_policies,
         count(p.policyname) filter (
           where (p.roles && array['anon','public']::name[])
             and coalesce(p.qual, 'true') in ('true', '(true)')) as open_to_anon,
         string_agg(p.policyname || ' [' || p.cmd || ' → ' || array_to_string(p.roles, ',') || ']',
                    '; ' order by p.policyname) as detail
    from sensitive s
    left join pg_class c
           on c.relname = s.tbl and c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
    left join pg_policies p
           on p.schemaname = 'public' and p.tablename = s.tbl
   group by s.tbl, c.oid, c.relrowsecurity
),
-- ── 6. mnb-research ──────────────────────────────────────────────────────────
mnb as (
  select o.id, o.name from public.organizations o where o.slug = 'mnb-research'
)

select section, item, verdict, detail from (

  -- 1a. every job, as context
  select 10 as ord, 'cron' as section, 'job: ' || jobname as item,
         case when active then 'INFO' else 'CHECK' end as verdict,
         schedule || case when active then '' else ' — INACTIVE' end
           || ' · ' || left(regexp_replace(command, '\s+', ' ', 'g'), 110) as detail
    from jobs

  -- 1b. two nurture jobs both calling the nurture function
  union all
  select 11, 'cron', 'duplicate nurture jobs (nurture-daily vs abrobot-nurture)',
         case when count(*) > 1 then 'CHECK' else 'PASS' end,
         case when count(*) > 1
              then 'both exist: ' || string_agg(jobname || ' @ ' || schedule, ', ' order by jobname)
                   || ' — the multi-tenant nurture runs every org; keep ONE (see scripts/cron-tidy.sql)'
              when count(*) = 1 then 'one nurture job: ' || max(jobname)
              else 'no nurture job scheduled at all' end
    from jobs where jobname in ('nurture-daily', 'abrobot-nurture')

  union all
  select 12, 'cron', 'a nurture job is scheduled',
         case when exists (select 1 from jobs where jobname in ('nurture-daily','abrobot-nurture') and active)
              then 'PASS' else 'CHECK' end,
         'follow-up email for every tenant'

  -- 1c. jobs that must exist
  union all
  select 13, 'cron', 'required: ' || r.jobname,
         case when j.jobname is null then 'CHECK'
              when not j.active then 'CHECK' else 'PASS' end,
         r.what || case when j.jobname is null then ' — NOT SCHEDULED'
                        when not j.active then ' — scheduled but inactive' else '' end
    from required_jobs r left join jobs j on j.jobname = r.jobname

  -- 1d. failures in the last day
  union all
  select 14, 'cron', 'failed in last 24h: ' || jobname, 'CHECK',
         n || ' failure(s), last ' || last_at::text || ' — ' || last_msg
    from recent_failures
  union all
  select 14, 'cron', 'no job failed in the last 24h', 'PASS', ''
   where not exists (select 1 from recent_failures)

  -- ── 2. settings (values never printed) ─────────────────────────────────────
  union all
  select 20, 'app_settings', 'cron_secret',
         case when s.value is null or s.value = '' then 'CHECK'
              when s.value = 'REPLACE_WITH_YOUR_CRON_SECRET' then 'CHECK'
              else 'PASS' end,
         case when s.value is null or s.value = '' then 'missing — every scheduled HTTP job is refused (scripts/set-cron-secret.sql)'
              when s.value = 'REPLACE_WITH_YOUR_CRON_SECRET' then 'still the placeholder (scripts/set-cron-secret.sql)'
              else 'set, ' || length(s.value) || ' chars' end
    from (select (select value from public.app_settings where key = 'cron_secret') as value) s

  union all
  select 21, 'app_settings', k.key,
         case when coalesce(s.value, '') = '' then 'CHECK' else 'PASS' end,
         case when coalesce(s.value, '') = ''
              then 'missing — operator alerts fall back to the function secrets TELEGRAM_BOT_TOKEN + OPERATOR_TELEGRAM_CHAT_ID if set (_shared/operator.ts); otherwise they go nowhere'
              else 'set' end
    from (values ('ops_telegram_bot_token'), ('ops_telegram_chat_id')) as k(key)
    left join public.app_settings s on s.key = k.key

  -- ── 3. policies on sensitive tables ───────────────────────────────────────
  union all
  select 30, 'policies', tbl,
         case when not exists_ then 'INFO'
              when not rls_on then 'CHECK'
              when n_policies = 0 then 'CHECK'
              when open_to_anon > 0 then 'CHECK'
              else 'PASS' end,
         case when not exists_ then 'table does not exist in public'
              when not rls_on then 'RLS is OFF — ' || coalesce(detail, 'no policies')
              when n_policies = 0 then 'RLS on, no policies (deny-all for API roles) — confirm intended'
              when open_to_anon > 0 then open_to_anon || ' polic(ies) open to anon/public with qual true — ' || detail
              else n_policies || ' polic(ies): ' || detail end
    from pol

  -- ── 4. public tables with RLS off ─────────────────────────────────────────
  union all
  select 40, 'rls', 'RLS OFF: public.' || c.relname, 'CHECK',
         'readable/writable through PostgREST by any role with table grants'
           || case when has_table_privilege('anon', c.oid, 'SELECT') then ' — anon has SELECT' else '' end
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p')
     and not c.relrowsecurity
  union all
  select 40, 'rls', 'every public table has RLS on', 'PASS', ''
   where not exists (select 1 from pg_class c
                      where c.relnamespace = 'public'::regnamespace
                        and c.relkind in ('r','p') and not c.relrowsecurity)

  -- ── 5. SECURITY DEFINER functions anon can execute ────────────────────────
  union all
  select 50, 'anon-exec', 'public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         'CHECK',
         'SECURITY DEFINER and executable by anon — must validate its own inputs (intended for widget/unsubscribe/track RPCs only)'
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.prosecdef
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  union all
  select 51, 'anon-exec', 'non-definer public functions executable by anon', 'INFO',
         count(*) || ' function(s) — these run with the caller''s rights, so RLS still applies'
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and not p.prosecdef
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')

  -- ── 6. mnb-research ────────────────────────────────────────────────────────
  union all
  select 60, 'mnb-research', 'organisation exists',
         case when exists (select 1 from mnb) then 'PASS' else 'CHECK' end,
         coalesce((select name || ' (' || id || ')' from mnb), 'no org with slug mnb-research')
  union all
  select 61, 'mnb-research', 'Telegram chat id',
         case when coalesce(a.telegram_chat_id::text, '') = '' then 'CHECK' else 'PASS' end,
         case when coalesce(a.telegram_chat_id::text, '') = '' then 'not set — enquiries from the marketing pages alert nobody'
              else a.telegram_chat_id::text
                   || case when coalesce(a.telegram_bot_token::text, '') = '' then ' (bot token NOT set — platform bot used if configured)'
                           else ' (bot token set)' end end
    from mnb m left join public.agent_config a on a.org_id = m.id
  union all
  select 62, 'mnb-research', 'members',
         case when count(pr.id) = 0 then 'CHECK' else 'INFO' end,
         count(pr.id) || ' profile(s): '
           || coalesce(string_agg(coalesce(pr.role::text, '?') || '/' || coalesce(pr.status::text, '?'), ', '), 'none')
    from mnb m left join public.profiles pr on pr.org_id = m.id

) report
order by ord, verdict = 'PASS', item;
