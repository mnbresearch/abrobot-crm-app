-- AbroBot CRM — authenticate the scheduled jobs, and make a dead job visible.
-- NOT APPLIED.
--
-- ⚠️  ORDER MATTERS. Do this in three steps or you will break your own cron:
--
--   1. Set CRON_SECRET in Supabase → Edge Functions → Secrets.
--        openssl rand -hex 32
--   2. Deploy the four functions (they now require the header).
--   3. Run THIS migration (so pg_cron starts sending it).
--
--   Between 2 and 3 the jobs will 401. That is intentional and brief — it is
--   the safe direction to fail. The reverse order would leave the endpoints
--   open while you think they are closed.
--
-- ── Part 1: send the secret ─────────────────────────────────────────────────
-- run-automations, nurture, system-health and summarize-chats are deployed
-- --no-verify-jwt (pg_cron carries no Supabase JWT) and each takes the target
-- org from the request body — so anyone could run another tenant's automations,
-- email another tenant's leads, or drain the shared Groq quota.
--
-- ── Part 2: notice when a job dies ──────────────────────────────────────────
-- pg_cron records that `select call_edge_function(...)` succeeded — which it
-- does the instant pg_net QUEUES the request. The HTTP result lands in
-- net._http_response, which nothing reads and which self-purges in hours. So a
-- nightly job could fail every night for a month with no signal anywhere.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Where the secret lives
-- ════════════════════════════════════════════════════════════════════════════
-- Not hardcoded in the function body. The publishable key already is
-- (schedules.sql line 33), which means rotating it silently kills all
-- scheduling with no alert. A table row can be updated without editing DDL.

create table if not exists public.app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
-- No policies at all: deny-all to every browser role. Only SECURITY DEFINER
-- functions and the service role read this. A secret readable over PostgREST
-- is not a secret.
revoke all on public.app_settings from anon, authenticated;

comment on table public.app_settings is
  'Operational secrets for server-side use only. RLS enabled with NO policies, so PostgREST can never read it.';

-- ⚠️ REPLACE THE VALUE BELOW with the same string you set as CRON_SECRET.
insert into public.app_settings (key, value)
values ('cron_secret', 'REPLACE_WITH_YOUR_CRON_SECRET')
on conflict (key) do update set value = excluded.value, updated_at = now();

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Send the header
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.call_edge_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  req_id bigint;
  secret text;
begin
  -- Reject anything that is not a plain function name. p_name used to be
  -- concatenated into the URL unvalidated, which made this a blind
  -- same-host SSRF primitive.
  if p_name !~ '^[a-z0-9][a-z0-9-]{0,62}$' then
    raise exception 'invalid function name: %', p_name;
  end if;

  select value into secret from public.app_settings where key = 'cron_secret';
  if secret is null or secret = 'REPLACE_WITH_YOUR_CRON_SECRET' then
    raise exception 'cron_secret is not configured in app_settings';
  end if;

  select net.http_post(
    url     := 'https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/' || p_name,
    headers := jsonb_build_object(
                 'Content-Type',   'application/json',
                 'x-cron-secret',  secret
               ),
    body    := p_body,
    timeout_milliseconds := 55000
  ) into req_id;

  return req_id;
end;
$$;

-- Was world-callable: any anon user could POST arbitrary JSON to any edge
-- function through it. pg_cron runs as the owner and is unaffected.
revoke all on function public.call_edge_function(text, jsonb) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Heartbeats — so silence is detectable
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.job_heartbeats (
  job_name     text primary key,
  last_run_at  timestamptz not null default now(),
  last_status  text not null default 'ok',
  last_detail  text,
  -- How long may pass before absence is a problem. Set to roughly 2× the
  -- schedule, so one missed run is tolerated and two is an alert.
  stale_after  interval not null default interval '1 hour'
);

alter table public.job_heartbeats enable row level security;

drop policy if exists heartbeats_read on public.job_heartbeats;
create policy heartbeats_read on public.job_heartbeats
  for select using (public.is_super_admin());

insert into public.job_heartbeats (job_name, stale_after, last_status, last_detail)
values
  ('run-automations', interval '45 minutes', 'unknown', 'never reported'),
  ('system-health',   interval '3 hours',    'unknown', 'never reported'),
  ('nurture',         interval '30 hours',   'unknown', 'never reported')
on conflict (job_name) do nothing;

-- Called by each function as its last act.
create or replace function public.record_heartbeat(
  p_job text, p_status text default 'ok', p_detail text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.job_heartbeats (job_name, last_run_at, last_status, last_detail)
  values (p_job, now(), p_status, p_detail)
  on conflict (job_name) do update set
    last_run_at = now(), last_status = excluded.last_status, last_detail = excluded.last_detail;
$$;

revoke all on function public.record_heartbeat(text, text, text) from public, anon, authenticated;

-- What system-health should read. A job that has stopped entirely reports
-- 'stale' here — which is the case that used to be invisible, because a job
-- that never runs also never writes a failure anywhere.
create or replace function public.stale_jobs()
returns table (job_name text, last_run_at timestamptz, minutes_late numeric, last_status text)
language sql
stable
security definer
set search_path = public
as $$
  select h.job_name, h.last_run_at,
         round(extract(epoch from (now() - h.last_run_at - h.stale_after)) / 60.0, 1),
         h.last_status
    from public.job_heartbeats h
   where now() - h.last_run_at > h.stale_after
   order by 3 desc;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Surface the HTTP results pg_net has been silently discarding
-- ════════════════════════════════════════════════════════════════════════════
-- net._http_response holds the actual status code. Nothing read it, and it
-- self-purges within hours — so the evidence of a failing job expired before
-- anyone could look at it.

create or replace function public.recent_cron_failures(p_hours integer default 24)
returns table (id bigint, status_code integer, error_msg text, created timestamptz)
language sql
stable
security definer
set search_path = public, net
as $$
  select r.id, r.status_code, r.error_msg, r.created
    from net._http_response r
   where r.created > now() - make_interval(hours => p_hours)
     and (r.status_code is null or r.status_code >= 300)
   order by r.created desc
   limit 100;
$$;

revoke all on function public.recent_cron_failures(integer) from public, anon;
grant execute on function public.recent_cron_failures(integer) to authenticated;

commit;


-- ── After applying ──────────────────────────────────────────────────────────
-- Confirm the secret is in place and not the placeholder:
--   select key, left(value, 6) || '…' as value_prefix, updated_at
--     from public.app_settings where key = 'cron_secret';
--
-- Within an hour, heartbeats should stop saying 'unknown':
--   select * from public.job_heartbeats order by last_run_at;
--   select * from public.stale_jobs();
--
-- And the failures pg_net was hiding:
--   select * from public.recent_cron_failures(24);
--
-- Trigger one by hand rather than waiting:
--   select public.call_edge_function('system-health', '{"alert":false}'::jsonb);
