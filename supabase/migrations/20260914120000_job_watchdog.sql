-- AbroBot CRM — a watchdog that lives inside the database.
--
-- ════════════════════════════════════════════════════════════════════════════
-- Why this exists
-- ════════════════════════════════════════════════════════════════════════════
-- On 14 September we found the scheduled sweep had been dead since the 6th.
-- Eight days. The post-mortem is worth recording, because the shape recurs:
--
--   Layer 1  app_settings.cron_secret was never changed from the placeholder
--            the 3 September migration seeded. call_edge_function raised on
--            every invocation. 2,502 failures, each faithfully recorded in
--            cron.job_run_details — a table nothing reads.
--
--   Layer 2  system-health exists to notice exactly this. It reaches the
--            database over the same HTTP path that was broken, so it was one
--            of the three jobs that had stopped. The alarm was wired to the
--            thing it was alarming about.
--
--   Layer 3  When the secret was finally set, the dashboard paste carried an
--            invisible trailing newline. Every call returned 401, and a 401
--            looks identical to a wrong secret. The fix failed silently too.
--
-- Every alarm here ran on the machinery that broke. This one does not: plain
-- SQL on pg_cron, no edge function, no HTTP dependency for DETECTION, and no
-- shared secret in its path.
--
-- ════════════════════════════════════════════════════════════════════════════
-- What it will and will not catch
-- ════════════════════════════════════════════════════════════════════════════
-- Catches: a job that has never reported; one that has stopped reporting; one
-- reporting unhealthy; a cron entry failing repeatedly; and an edge function
-- returning non-2xx, attributed BY NAME — the step that cost a human an hour.
--
-- Does NOT catch: pg_cron itself dying, because this runs on pg_cron. That is
-- a real residual risk, stated plainly rather than papered over. The honest
-- mitigation is an external ping, not a cleverer query.
--
-- The design rule that matters: it must be useful with NOTHING configured. An
-- alarm whose only output is a Telegram message nobody set up is the original
-- bug again. Every incident is written to a durable table first; notification
-- is a bonus on top, never the mechanism.
--
-- ════════════════════════════════════════════════════════════════════════════
-- The trap this nearly fell into
-- ════════════════════════════════════════════════════════════════════════════
-- The first draft had the watchdog report its own heartbeat as 'warn' whenever
-- ANY incident was open — including its own. Trace it: open incident → warn →
-- the unhealthy detector selects job-watchdog → opens an incident against
-- itself → which keeps it warn. The fixed point is unreachable from any
-- direction. It would have been permanently red about itself within thirty
-- minutes, needing two simultaneous manual UPDATEs to escape.
--
-- A monitor that cannot be green is a monitor nobody reads, which is how the
-- eight days happened. So: the watchdog is excluded from its own heartbeat
-- detection, and its own status ignores its own incidents.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Attribute HTTP results to the function that was called
-- ════════════════════════════════════════════════════════════════════════════
-- net._http_response records status_code and body but NOT the url, so a 401
-- there cannot be traced to a job without guessing. call_edge_function already
-- knows the name and already gets the request id back — it threw it away.

create table if not exists public.edge_call_log (
  request_id bigint primary key,
  fn         text        not null,
  called_at  timestamptz not null default now()
);

comment on table public.edge_call_log is
  'Maps a pg_net request id to the edge function it was for, so an HTTP failure can be attributed by name. net._http_response does not record the url.';

alter table public.edge_call_log enable row level security;
-- RLS with no policies denies every row to anon and authenticated. The revoke
-- is belt-and-braces on top, matching app_settings rather than the looser
-- posture used for automation_sweep_state: this table's rows are operational
-- detail, and the revoke survives someone disabling RLS.
revoke all on public.edge_call_log from anon, authenticated;

create index if not exists edge_call_log_called_idx
  on public.edge_call_log (called_at desc);

create or replace function public.call_edge_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  req_id bigint;
  secret text;
begin
  -- Reject anything that is not a plain function name. p_name used to be
  -- concatenated into the url unvalidated, which made this a blind same-host
  -- SSRF primitive.
  if p_name !~ '^[a-z0-9][a-z0-9-]{0,62}$' then
    raise exception 'invalid function name: %', p_name;
  end if;

  select value into secret from public.app_settings where key = 'cron_secret';
  if secret is null or secret = 'REPLACE_WITH_YOUR_CRON_SECRET' then
    raise exception 'cron_secret is not configured in app_settings';
  end if;

  -- btrim, for the same reason cron-auth.ts now trims: the dashboard's secret
  -- field is a textarea and a paste can carry an invisible trailing newline.
  -- That cost eight days once.
  select net.http_post(
    url     := 'https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/' || p_name,
    headers := jsonb_build_object(
                 'Content-Type',   'application/json',
                 'x-cron-secret',  btrim(secret)
               ),
    body    := p_body,
    timeout_milliseconds := 55000
  ) into req_id;

  -- Best-effort: a logging failure must never stop the call it is logging.
  --
  -- ON CONFLICT DO UPDATE rather than DO NOTHING. net.http_request_queue is
  -- UNLOGGED, so on PG15+ its sequence is unlogged too and RESETS on crash
  -- recovery. A recycled id would otherwise collide with a retained row and
  -- attribute a failure to the wrong function — the one thing this table
  -- exists to get right. Newest write wins.
  begin
    insert into public.edge_call_log (request_id, fn) values (req_id, p_name)
    on conflict (request_id) do update set fn = excluded.fn, called_at = now();
  exception when others then
    raise notice 'edge_call_log insert failed for % (%): %', p_name, req_id, sqlerrm;
  end;

  return req_id;
end;
$$;

revoke all on function public.call_edge_function(text, jsonb) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Incidents — durable, queryable, independent of any notifier
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.job_incidents (
  id           bigint generated always as identity primary key,
  job_name     text        not null,
  kind         text        not null,   -- heartbeat | cron_failing | http_error
  detail       text,
  opened_at    timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  notify_state text,                   -- queued as N | not configured | the failure
  notify_req   bigint                  -- pg_net request id, so a send can be checked
);

comment on table public.job_incidents is
  'One row per detected job problem, opened when it starts and resolved when it clears. Written unconditionally, so the record survives with no notification channel configured — an alarm that exists only as an unsent message is the failure this table was created after.';

alter table public.job_incidents enable row level security;
revoke all on public.job_incidents from anon, authenticated;

-- Super admins can read it, matching job_heartbeats. Without this the table
-- comment's promise of a "queryable" record is only true in the SQL editor.
drop policy if exists incidents_read on public.job_incidents;
create policy incidents_read on public.job_incidents
  for select using (public.is_super_admin());

create index if not exists job_incidents_recent_idx
  on public.job_incidents (opened_at desc);

-- One open incident per (job, kind). Without this an ongoing problem would
-- open a fresh row every fifteen minutes — 2,502 rows in eight days, which is
-- exactly the noise that made the original failure invisible.
create unique index if not exists job_incidents_one_open_idx
  on public.job_incidents (job_name, kind) where resolved_at is null;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Where an alert goes, if anywhere
-- ════════════════════════════════════════════════════════════════════════════
-- Two OPTIONAL rows in app_settings, the same deny-all table as cron_secret:
--
--   ops_telegram_bot_token   from @BotFather
--   ops_telegram_chat_id     an operator chat, NOT a customer's
--
-- Deliberately separate from the per-tenant telegram settings in agent_config:
-- an operator alert must not depend on a customer's configuration and must
-- never be delivered into a customer's chat.
--
-- Seeded ABSENT, not with a placeholder. A placeholder is what started all of
-- this — code cannot tell "not set up yet" from "set up wrong" when the value
-- is a plausible-looking string.
--
-- ⚠ The token necessarily goes in the url: Telegram's sendMessage takes it in
-- the path, not the body. pg_net records that url in net.http_request_queue
-- until its worker drains the row. The x-cron-secret header is already stored
-- there the same way by call_edge_function above, so this is a pre-existing
-- exposure rather than a new one — but the verify block at the end checks
-- whether anon or authenticated can read the net schema, because if they can,
-- both secrets are readable and that is worth knowing today.

create or replace function public.watch_jobs_notify(p_text text, out state text, out req_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  tok  text;
  chat text;
begin
  select btrim(value) into tok  from public.app_settings where key = 'ops_telegram_bot_token';
  select btrim(value) into chat from public.app_settings where key = 'ops_telegram_chat_id';

  if tok is null or tok = '' or chat is null or chat = '' then
    state := 'not configured'; req_id := null; return;
  end if;

  select net.http_post(
    url     := 'https://api.telegram.org/bot' || tok || '/sendMessage',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('chat_id', chat, 'text', p_text),
    timeout_milliseconds := 15000
  ) into req_id;

  state := 'queued as ' || req_id;
exception when others then
  -- Never let the notifier break the detection.
  state := 'send failed: ' || sqlerrm; req_id := null;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. The watchdog
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.watch_jobs()
returns table (opened integer, resolved integer, still_open integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r          record;
  v_opened   integer := 0;
  v_resolved integer := 0;
  v_open     integer := 0;
  v_is_new   boolean;
  v_send     record;
  v_lines    text[] := '{}';
begin
  -- The manual first run and a cron tick can land together. ON CONFLICT
  -- handles the insert race, but the resolver's UPDATE against a concurrent
  -- INSERT on the same partial index can deadlock, and both runs would send
  -- the same alert. Cheap insurance; a skipped run costs fifteen minutes.
  if not pg_try_advisory_xact_lock(hashtext('watch_jobs')) then
    return query select 0, 0,
      (select count(*)::integer from public.job_incidents where resolved_at is null);
    return;
  end if;

  -- pg_temp-qualified: the temp schema is searched implicitly even when it is
  -- not in search_path, so an unqualified DROP would silently remove a
  -- permanent public._problems if one ever existed and no temp one did.
  drop table if exists pg_temp._problems;
  create temporary table _problems (job_name text, kind text, detail text) on commit drop;

  -- ── (a) Heartbeats ───────────────────────────────────────────────────────
  -- ONE kind — 'heartbeat' — not never_ran/stale/unhealthy as three separate
  -- kinds. The three flap into one another: a job that is both late and
  -- unhealthy reclassifies the moment it runs again, which resolves one
  -- incident and opens another, sending two messages per transition forever.
  -- The distinction belongs in `detail`, where it costs nothing.
  --
  -- job-watchdog excludes ITSELF. See the header: including it makes the
  -- fixed point unreachable.
  --
  -- `watch` excludes jobs nothing schedules. summarize-chats calls
  -- record_heartbeat but has no cron entry — it is invoked on demand — so
  -- "has never reported" is its correct permanent state, not an incident.
  -- Watching it would have put a red row on the board on install day and left
  -- it there, and a board that is never green is a board nobody reads.
  --
  -- stale_after * 2, deliberately looser than stale_jobs(). One missed tick is
  -- a blip; two is a pattern. stale_jobs() stays the sensitive view for a human
  -- looking; this is the threshold that earns an interruption.
  insert into _problems
  select h.job_name, 'heartbeat',
         case when h.last_detail = 'never reported'
                then 'has never reported since its heartbeat row was created'
              when now() - h.last_run_at > h.stale_after * 2
                then 'last reported ' || to_char(h.last_run_at, 'DD Mon HH24:MI')
                     || ' (' || round(extract(epoch from (now() - h.last_run_at))/3600.0, 1)
                     || 'h ago, threshold ' || h.stale_after || ')'
              else 'reporting ' || coalesce(h.last_status,'?') || ': '
                   || left(coalesce(h.last_detail,''), 160) end
    from public.job_heartbeats h
   where h.job_name <> 'job-watchdog'
     and h.watch
     and (h.last_detail = 'never reported'
       or now() - h.last_run_at > h.stale_after * 2
       or coalesce(h.last_status, 'ok') <> 'ok');

  -- ── (b) A cron entry failing repeatedly ──────────────────────────────────
  -- The signal that sat in plain sight for eight days: `ERROR: cron_secret is
  -- not configured`, every fifteen minutes, in cron.job_run_details.
  --
  -- status = 'failed', NOT status <> 'succeeded'. pg_cron writes
  -- starting/running/sending rows before the terminal status, so the negated
  -- test counts every in-flight run as a failure — and a job that overruns its
  -- own interval would trip the threshold while working perfectly.
  --
  -- NOTE: these are pg_cron job names (abrobot-run-automations), which are not
  -- the heartbeat names (run-automations). One broken job can therefore appear
  -- as two incidents under two names. Left as-is rather than mapped by string
  -- surgery, which would break the moment someone renames a job.
  insert into _problems
  select j.jobname, 'cron_failing',
         count(*) || ' failed run(s) in the last hour, most recent: '
         || left(coalesce((array_agg(r2.return_message order by r2.start_time desc))[1],
                          'no message'), 160)
    from cron.job_run_details r2
    join cron.job j on j.jobid = r2.jobid
   where r2.start_time > now() - interval '1 hour'
     and r2.status = 'failed'
   group by j.jobname
  having count(*) >= 2;

  -- ── (c) An edge function answering non-2xx, attributed by name ───────────
  -- array_agg ordered by time, not max(). max() returns the largest status
  -- code, so a run with a 500 and a later 401 would report the 500 as "most
  -- recent" — the precise species of misdiagnosis this file exists to stop.
  insert into _problems
  select l.fn, 'http_error',
         count(*) || ' non-2xx response(s) in the last hour, most recent: '
         || coalesce((array_agg(resp.status_code order by resp.created desc))[1]::text, '?')
         || ' - ' || left(coalesce((array_agg(coalesce(resp.error_msg, resp.content::text)
                                              order by resp.created desc))[1], ''), 140)
    from public.edge_call_log l
    join net._http_response resp on resp.id = l.request_id
   where l.called_at > now() - interval '1 hour'
     and (resp.status_code is null or resp.status_code < 200 or resp.status_code >= 300)
   group by l.fn
  having count(*) >= 2;

  -- ── Open what is new ─────────────────────────────────────────────────────
  for r in select * from _problems loop
    insert into public.job_incidents (job_name, kind, detail)
    values (r.job_name, r.kind, r.detail)
    on conflict (job_name, kind) where resolved_at is null
    do update set detail = excluded.detail, updated_at = now()
    -- opened_at = updated_at identifies a genuine INSERT. The `xmax = 0` trick
    -- would also work but rests on heap implementation detail rather than
    -- documented behaviour — the wrong foundation for the one test that
    -- decides whether a human gets woken up.
    returning (opened_at = updated_at) into v_is_new;

    if v_is_new then
      v_opened := v_opened + 1;
      v_lines := v_lines || (r.job_name || ' [' || r.kind || '] ' || r.detail);
    end if;
  end loop;

  -- ── Notify: ONE message per run, not one per incident ───────────────────
  -- A platform-wide outage opens one incident per job per kind. Sending each
  -- separately would hit Telegram's ~20/min cap and get rate-limited, which
  -- would then fail silently — the same shape as everything else in the
  -- post-mortem above.
  if v_opened > 0 then
    select * into v_send from public.watch_jobs_notify(
      '🔴 AbroBot CRM — ' || v_opened || ' job incident(s) opened' || chr(10)
      || array_to_string(v_lines, chr(10)));

    -- `opened_at = updated_at` alone was wrong here. It is the right test for
    -- "was this row just INSERTED" inside the RETURNING above, but as a
    -- standalone predicate it also matches every incident opened in an EARLIER
    -- run that has not been touched since — so an old, still-open incident
    -- would have its notify_state overwritten with the state of a send that
    -- never mentioned it.
    --
    -- now() is transaction_timestamp(), and opened_at defaults to now(), so
    -- this matches exactly the rows inserted by THIS transaction.
    update public.job_incidents
       set notify_state = v_send.state, notify_req = v_send.req_id
     where resolved_at is null and opened_at = now();
  end if;

  -- ── Resolve what has cleared ─────────────────────────────────────────────
  with cleared as (
    update public.job_incidents i
       set resolved_at = now()
     where i.resolved_at is null
       and not exists (select 1 from _problems p
                        where p.job_name = i.job_name and p.kind = i.kind)
    returning 1
  )
  select count(*)::integer into v_resolved from cleared;

  if v_resolved > 0 then
    perform public.watch_jobs_notify(
      '🟢 AbroBot CRM — ' || v_resolved || ' job incident(s) cleared');
  end if;

  -- ── Its own status ───────────────────────────────────────────────────────
  -- Counts incidents OTHER than its own. Including its own is the feedback
  -- loop described in the header.
  select count(*)::integer into v_open
    from public.job_incidents
   where resolved_at is null and job_name <> 'job-watchdog';

  -- Housekeeping: edge_call_log only needs to outlive net._http_response,
  -- which self-purges in hours. A week is generous.
  delete from public.edge_call_log where called_at < now() - interval '7 days';

  perform public.record_heartbeat(
    'job-watchdog',
    case when v_open > 0 then 'warn' else 'ok' end,
    v_opened || ' opened, ' || v_resolved || ' resolved, ' || v_open || ' open');

  return query select v_opened, v_resolved, v_open;
end;
$$;

comment on function public.watch_jobs is
  'Detects stopped, stale, unhealthy or erroring scheduled jobs from database state alone and records each as an incident. Pure SQL on pg_cron with no edge function in the path — every previous alarm in this system depended on the machinery it was meant to watch, which is how a sweep stayed dead for eight days.';

revoke all on function public.watch_jobs()                  from public, anon, authenticated;
revoke all on function public.watch_jobs_notify(text)       from public, anon, authenticated;
grant execute on function public.watch_jobs()               to service_role;

-- ── Which jobs are actually watched ─────────────────────────────────────────
-- A heartbeat row means "this job reports in". It does not mean "something
-- schedules it", and the watchdog needs the second fact, not the first.
--
-- Without this column the only available inference is the job name, and the
-- pg_cron names (abrobot-run-automations) are not the heartbeat names
-- (run-automations), so matching them means string surgery that breaks the
-- moment someone renames a job. An explicit flag states the thing directly.
alter table public.job_heartbeats
  add column if not exists watch boolean not null default true;

comment on column public.job_heartbeats.watch is
  'Whether watch_jobs() should raise an incident for this job. False for functions invoked on demand rather than on a schedule — for those, "has never reported" is the correct steady state, not a fault.';

-- ── Seed heartbeat rows for every job that reports ──────────────────────────
-- record_heartbeat() inserts without stale_after, taking the column default of
-- one hour. summarize-chats calls it and has no seeded row, so the first time
-- it ran it would create itself a 1-hour threshold and become a permanent
-- incident two hours later. Seed every reporter with a threshold that matches
-- its real schedule.
--
-- job-watchdog is seeded with 'ok', NOT 'never reported': it is inserted in
-- this transaction and the first run happens moments later, so the placeholder
-- would make the watchdog's first act be an alert that the watchdog has never
-- run.
--
-- summarize-chats is seeded with watch = false. It has no cron entry — grep
-- the migrations and deploy script and nothing schedules it — so seeding it
-- watched would have opened an incident during this very transaction and never
-- closed it. If it is ever put on a schedule, flip the flag:
--   update public.job_heartbeats set watch = true where job_name = 'summarize-chats';
insert into public.job_heartbeats (job_name, stale_after, last_status, last_detail, watch) values
  ('job-watchdog',    interval '45 minutes', 'ok',      'seeded at install',        true),
  ('summarize-chats', interval '26 hours',   'unknown', 'on demand, not scheduled', false)
on conflict (job_name) do nothing;

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Schedule it (after commit — cron.schedule writes to cron.job)
-- ════════════════════════════════════════════════════════════════════════════
select cron.unschedule('job-watchdog')
 where exists (select 1 from cron.job where jobname = 'job-watchdog');

select cron.schedule('job-watchdog', '*/15 * * * *', $$select public.watch_jobs();$$);

-- First run, in a DO block that CANNOT raise.
--
-- Everything after `commit` shares one implicit transaction, so an exception
-- here would roll back the cron.schedule above and leave the schema in place
-- with no watchdog scheduled — a silently absent monitor, which is the exact
-- failure class this file was written after.
do $$
declare res record;
begin
  select * into res from public.watch_jobs();
  raise notice 'watchdog first run: % opened, % resolved, % open',
    res.opened, res.resolved, res.still_open;
exception when others then
  raise warning 'watchdog first run FAILED (schema and schedule are intact): %', sqlerrm;
end $$;

-- ── Verify — a SEPARATE statement ───────────────────────────────────────────
-- Deliberately not unioned with the run above. In READ COMMITTED every branch
-- of a single statement uses the snapshot taken at statement start, so rows
-- the run inserted would be invisible to a branch reporting on them: "opened
-- 3" and "open incidents: none" on the same screen.
select 'the watchdog is scheduled' as check,
       coalesce((select 'PASS - ' || schedule from cron.job where jobname = 'job-watchdog'),
                'FAIL - not scheduled') as result
union all
select 'it reported its own heartbeat',
       coalesce((select 'PASS - ' || last_status || ': ' || left(coalesce(last_detail,''),60)
                   from public.job_heartbeats where job_name = 'job-watchdog'),
                'FAIL - no row')
union all
select 'what is being watched',
       coalesce((select string_agg(job_name || case when watch then '' else ' (not watched)' end,
                                   ', ' order by job_name)
                   from public.job_heartbeats), '(no rows)')
union all
select 'open incidents',
       coalesce((select string_agg(job_name || ' [' || kind || '] ' || left(coalesce(detail,''),60),
                                   '  |  ' order by opened_at)
                   from public.job_incidents where resolved_at is null),
                'none')
union all
select 'alert destination',
       case when exists (select 1 from public.app_settings
                          where key = 'ops_telegram_bot_token' and btrim(value) <> '')
             and exists (select 1 from public.app_settings
                          where key = 'ops_telegram_chat_id' and btrim(value) <> '')
            then 'Telegram configured'
            else 'not configured - incidents are still recorded, which is the point' end
union all
-- The exposure worth knowing about today. pg_net stores request urls and
-- headers, so both the Telegram bot token and the x-cron-secret sit in
-- net.http_request_queue until its worker drains them. If anon or
-- authenticated can read that schema, both are readable over PostgREST.
select 'can anon/authenticated read the net schema?',
       coalesce((select string_agg(distinct grantee || ' on ' || table_name, ', ')
                   from information_schema.role_table_grants
                  where table_schema = 'net' and grantee in ('anon','authenticated')),
                'PASS - neither role has grants on net');

-- ── Turning on Telegram alerts (optional) ───────────────────────────────────
--   insert into public.app_settings (key, value) values
--     ('ops_telegram_bot_token', 'PUT_THE_BOT_TOKEN_HERE'),
--     ('ops_telegram_chat_id',   'PUT_THE_CHAT_ID_HERE')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
--
-- Use an operator chat, not a customer's. Then confirm a send actually landed
-- rather than merely queueing — pg_net returns a request id immediately and a
-- bad token fails later, which is Layer 3 of the post-mortem all over again:
--
--   select i.job_name, i.notify_state, r.status_code, r.content
--     from public.job_incidents i
--     left join net._http_response r on r.id = i.notify_req
--    order by i.opened_at desc limit 10;
--
-- ── What to look at when something breaks ───────────────────────────────────
--   select * from public.job_incidents where resolved_at is null;
--   select * from public.stale_jobs();
--   select l.fn, r.status_code, r.created
--     from public.edge_call_log l join net._http_response r on r.id = l.request_id
--    order by r.created desc limit 20;
