-- AbroBot CRM — the four jobs the watchdog cannot see, and the threshold that
-- makes a daily failure invisible.
--
-- ════════════════════════════════════════════════════════════════════════════
-- Gap 1 — four scheduled jobs are monitored by nothing at all
-- ════════════════════════════════════════════════════════════════════════════
-- 20260914120000 built the watchdog after a sweep had been dead for eight days.
-- Its heartbeat detector reads public.job_heartbeats: no row, no detection. And
-- the rows are seeded by hand, in two migrations, listing five jobs:
--
--   run-automations, system-health, nurture   20260903140000
--   job-watchdog, summarize-chats             20260914120000
--
-- Meanwhile cron.schedule is called eight times across the migrations. The four
-- that were never given a heartbeat row:
--
--   mark-lapsed-subscriptions   '30 2 * * *'     20260821080000:598
--   purge-archived              '15 3 * * *'     20260903150000:192
--   prune-webhook-deliveries    '45 3 * * *'     20260905090000:361
--   reconcile-webhooks          '*/5 * * * *'    20260906100000:354
--
-- Every one of them matters. reconcile-webhooks is what closes the loop on
-- customer webhook deliveries and disables a dead endpoint after 20 failures —
-- if it stops, deliveries pile up unreconciled and nobody is told.
-- mark-lapsed-subscriptions is what stops an expired plan billing as live.
-- purge-archived is the only thing that ever actually removes archived data,
-- which is a retention promise.
--
-- The reason they have no heartbeat is structural, not an oversight of five
-- minutes: record_heartbeat() is called from TypeScript, by the four edge
-- functions. These four jobs are plain SQL invoked straight from pg_cron. There
-- is no TypeScript in their path, so there was never anywhere to put the call.
--
-- ── How this file closes it, and the route it did NOT take ──────────────────
-- The obvious fix is a wrapper function per job that calls the real one and
-- then record_heartbeat(), with cron re-pointed at the wrapper. Rejected, for
-- two reasons:
--
--   1. It requires rewriting four live cron entries. Re-registering the
--      production schedule is a real change to running machinery, to add
--      monitoring — the tail wagging the dog, with a window in which a job
--      could end up scheduled to nothing.
--
--   2. It does not even work for the case that matters. Inside plpgsql, an
--      exception handler rolls back to the start of its block; if the wrapper
--      catches the failure, records 'error' and then re-raises so pg_cron still
--      sees a failed run, the re-raise aborts the transaction and takes the
--      heartbeat write with it. You can have the record or the failed status,
--      not both. A monitor that loses precisely the failures is worse than
--      none, because it looks green.
--
-- pg_cron already records every run of these four — when it started, when it
-- ended, whether it succeeded, and the error text — in cron.job_run_details.
-- The information was never missing. Nothing was reading it.
--
-- So: sync_cron_heartbeats() projects cron.job_run_details onto job_heartbeats
-- for these four jobs, and watch_jobs() calls it before it looks. No wrappers,
-- no re-scheduling, nothing in the jobs' own path to break.
--
-- ⚠ ONLY these four. The map deliberately excludes abrobot-run-automations,
-- abrobot-system-health and abrobot-nurture, and the exclusion is the most
-- important line in this file. Those three cron entries do not do the work —
-- they call call_edge_function(), which queues an HTTP POST and returns. The
-- cron run "succeeds" the instant the request is queued, whether the edge
-- function then runs, 401s, or never executes at all. Syncing them would
-- overwrite the genuine heartbeat those functions report with a cheerful 'ok'
-- that means nothing. That is Layer 1 of the 14 September post-mortem verbatim:
-- 2,502 failures behind a call that reported success.
--
-- ════════════════════════════════════════════════════════════════════════════
-- Gap 2 — `having count(*) >= 2` in a 1-hour window
-- ════════════════════════════════════════════════════════════════════════════
-- Both of the watchdog's other detectors end the same way:
--
--   where r2.start_time > now() - interval '1 hour' ...
--   having count(*) >= 2
--
-- The reasoning was sound for the job it was written about: run-automations
-- fires every 15 minutes, so one failure is a blip and two in an hour is a
-- pattern. But the threshold is a constant and the schedules are not.
--
-- A job that runs once per hour or less can never produce two failures inside a
-- one-hour window. Not "rarely" — never, arithmetically. So:
--
--   purge-archived              daily   fails every single day → 1 per window → invisible
--   prune-webhook-deliveries    daily   same
--   mark-lapsed-subscriptions   daily   same
--   nurture (via http_error)    daily   same
--   system-health (http_error)  hourly  1 per window → invisible
--
-- Five of the eight scheduled jobs are structurally undetectable by these two
-- detectors. A daily job can fail every day for a year and neither one fires.
-- The threshold that was supposed to suppress noise suppressed the signal
-- instead, and it did so silently, which is the recurring shape in this
-- system's whole incident history.
--
-- The fix is to make the threshold a function of the schedule rather than a
-- constant, which is what it always meant:
--
--   ≥ 2 runs/hour   2 failures in 1 hour      unchanged: one blip is not an alert
--   ~1 run/hour     1 failure in 3 hours      one failure IS the pattern
--   < 1 run/hour    1 failure in 26 hours     ditto, and the window has to be
--                                             longer than the job's own period
--                                             or the incident resolves itself
--                                             an hour later and re-opens
--                                             tomorrow — daily alert flapping
--                                             instead of one standing incident
--
-- The window has to move with the threshold. Dropping to "1 failure in 1 hour"
-- alone would detect a daily failure for one hour out of every twenty-four and
-- then declare it resolved.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Read a cron schedule as a frequency
-- ════════════════════════════════════════════════════════════════════════════
-- Returns runs per hour. NULL means "this expression is more complicated than
-- I parse" and 0 means "at most one run per hour". Both callers treat NULL as
-- the old behaviour (2 failures in 1 hour), so an exotic schedule degrades to
-- exactly what is deployed today rather than to something new and untested.
--
-- Only the minute and hour fields are examined. Day-of-month / month /
-- day-of-week can only make a job rarer, never more frequent, so ignoring them
-- is safe in the direction that matters: it can make the threshold too strict
-- (alerting on one failure when two would have done), never too lax.

create or replace function public.cron_runs_per_hour(p_schedule text)
returns numeric
language plpgsql
immutable
as $$
declare
  s        text;
  f        text[];
  minute_f text;
  hour_f   text;
  n        numeric;
begin
  s := lower(btrim(coalesce(p_schedule, '')));
  if s = '' then
    return null;
  end if;

  -- pg_cron 1.5's interval syntax — '30 seconds', '10 minutes'. Not used by
  -- anything in this repo today, but cheap to handle and it would otherwise
  -- fall through to the five-field parse and return NULL.
  if s ~ '^[0-9]+ +(second|seconds|minute|minutes|hour|hours)$' then
    n := (regexp_replace(s, '[^0-9].*$', ''))::numeric;
    if n <= 0 then
      return null;
    end if;
    if s like '%second%' then return 3600.0 / n; end if;
    if s like '%minute%' then return   60.0 / n; end if;
    return 1.0 / n;
  end if;

  f := regexp_split_to_array(s, ' +');
  if coalesce(array_length(f, 1), 0) <> 5 then
    return null;
  end if;
  minute_f := f[1];
  hour_f   := f[2];

  -- Any restriction at all on the hour field means the job runs during some
  -- hours and not others, so it cannot average more than one run per hour of
  -- wall-clock time in the windows we care about. '0 */6 * * *' and '15 3 * * *'
  -- both land here, and both want the once-per-hour-or-rarer treatment.
  if hour_f <> '*' then
    return 0;
  end if;

  if minute_f = '*' then
    return 60;
  end if;

  if minute_f ~ '^\*/[0-9]+$' then
    n := substring(minute_f from 3)::numeric;
    if n <= 0 then
      return null;
    end if;
    return floor(60.0 / n);
  end if;

  -- An explicit list: '0,30 * * * *' is twice an hour.
  if minute_f ~ '^[0-9]+(,[0-9]+)*$' then
    return array_length(string_to_array(minute_f, ','), 1);
  end if;

  -- Ranges and step-over-range ('5-25/10'). Counting them properly is more
  -- parser than this is worth; one run per hour is the conservative answer
  -- (it produces the stricter threshold).
  return 1;
exception when others then
  -- A schedule we cannot read must not be able to break the watchdog. NULL
  -- means "use the old constants".
  return null;
end;
$$;

comment on function public.cron_runs_per_hour is
  'How many times per hour a pg_cron schedule fires, as a number. 0 means once an hour or less; NULL means unparsed. Exists because watch_jobs() used a flat "2 failures in an hour" threshold, which a job running once a day can never reach — so a daily job failing every day was invisible to it.';

-- ── Threshold and window, derived from that frequency ───────────────────────
-- DROP first. These return a composite built from OUT parameters, and adding or
-- renaming an OUT parameter later is a return-type change: `create or replace`
-- would raise 42P13 and roll the whole migration back. 20260922100000 learned
-- that the expensive way.
drop function if exists public.cron_failure_policy(text);

create function public.cron_failure_policy(
  p_schedule    text,
  out win       interval,
  out min_failures integer
)
language plpgsql
immutable
as $$
declare
  r numeric := public.cron_runs_per_hour(p_schedule);
begin
  if r is null then
    -- Unparsed: exactly the behaviour deployed since 14 September.
    win := interval '1 hour';  min_failures := 2;
  elsif r >= 2 then
    -- Several runs an hour. One failure is a blip; two is a pattern.
    win := interval '1 hour';  min_failures := 2;
  elsif r >= 1 then
    -- Hourly. Two failures cannot both fall in a one-hour window, so the
    -- window has to be wider than the period and one failure has to count.
    win := interval '3 hours'; min_failures := 1;
  else
    -- Daily or rarer. 26 hours, not 24: a job scheduled at 03:15 must still be
    -- inside the window when it fails again at 03:15 tomorrow, or the incident
    -- resolves overnight and re-opens every morning — a standing fault
    -- announced as a fresh alert every day is how people learn to ignore
    -- alerts.
    win := interval '26 hours'; min_failures := 1;
  end if;
end;
$$;

comment on function public.cron_failure_policy is
  'How many failures, within what window, count as a fault for a job on the given pg_cron schedule. Schedule-relative because a constant threshold silently exempts every job that runs less often than the window.';

-- ── The same, for an edge function named in a cron command ──────────────────
-- The http_error detector groups by edge_call_log.fn ('run-automations'), not
-- by a cron job name, so it has to find the schedule the other way round: the
-- cron entry whose command mentions that function. 20260914120000 already notes
-- that these two naming systems do not line up and declines to map them by
-- string surgery; this is string surgery, so it is worth being precise about
-- why it is acceptable here. It is not identifying a job — a wrong answer only
-- changes a threshold, and it falls back to today's constants. It is not used
-- to attribute a failure to anything.
drop function if exists public.edge_failure_policy(text);

create function public.edge_failure_policy(
  p_fn          text,
  out win       interval,
  out min_failures integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sched text;
begin
  -- Guarded: without pg_cron the reference to cron.job would raise, and this
  -- is called from inside the watchdog. plpgsql plans each statement on first
  -- execution, so a statement that is never reached is never planned.
  if to_regclass('cron.job') is not null and p_fn ~ '^[a-z0-9][a-z0-9-]{0,62}$' then
    select j.schedule into v_sched
      from cron.job j
     where j.command like '%''' || p_fn || '''%'
     order by j.jobid
     limit 1;
  end if;

  -- cron_failure_policy(NULL) is the defaulting path, so no schedule found
  -- means today's constants. An edge function invoked on demand rather than on
  -- a schedule — summarize-chats — lands here and is treated exactly as it is
  -- treated now.
  -- `select *`, with no aliases and no qualified column names: the OUT
  -- parameters of this function are called win and min_failures, and so are
  -- the columns coming back. Writing either name in the query text would make
  -- plpgsql choose between the variable and the column, and its default for
  -- that choice is to raise. `*` names neither.
  select * into win, min_failures from public.cron_failure_policy(v_sched);
end;
$$;

comment on function public.edge_failure_policy is
  'cron_failure_policy() for an edge function, found via the cron entry that calls it. Falls back to the pre-existing 2-in-1-hour constants when there is no such entry.';

revoke all on function public.cron_runs_per_hour(text)   from public, anon, authenticated;
revoke all on function public.cron_failure_policy(text)  from public, anon, authenticated;
revoke all on function public.edge_failure_policy(text)  from public, anon, authenticated;
grant execute on function public.cron_runs_per_hour(text)  to service_role;
grant execute on function public.cron_failure_policy(text) to service_role;
grant execute on function public.edge_failure_policy(text) to service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Which cron entries ARE their own work
-- ════════════════════════════════════════════════════════════════════════════
-- A table rather than a hard-coded list inside the sync function, because the
-- decision this encodes — "a successful cron run of this entry genuinely means
-- the work happened" — is one somebody will have to make again for the next
-- job, and it should be made by adding a row, visibly, rather than by editing a
-- function body.

create table if not exists public.cron_job_heartbeat_map (
  cron_jobname text primary key,
  job_name     text not null,
  note         text
);

comment on table public.cron_job_heartbeat_map is
  'pg_cron entries whose own success is proof the work was done, and the job_heartbeats row each one feeds. ONLY for entries that do the work inline in SQL. An entry that calls call_edge_function() must never appear here: its cron run succeeds when the HTTP request is queued, not when the function runs, so syncing it would report a job as healthy while it 401s — the exact failure that went unnoticed for eight days in September.';

alter table public.cron_job_heartbeat_map enable row level security;
revoke all on public.cron_job_heartbeat_map from anon, authenticated;

insert into public.cron_job_heartbeat_map (cron_jobname, job_name, note) values
  ('mark-lapsed-subscriptions', 'mark-lapsed-subscriptions',
   'plain SQL: select public.mark_lapsed_subscriptions()'),
  ('purge-archived',            'purge-archived',
   'plain SQL: select public.purge_archived()'),
  ('prune-webhook-deliveries',  'prune-webhook-deliveries',
   'plain SQL: select public.prune_webhook_deliveries()'),
  ('reconcile-webhooks',        'reconcile-webhooks',
   'plain SQL: select public.reconcile_webhook_deliveries()')
on conflict (cron_jobname) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Project cron.job_run_details onto job_heartbeats
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.sync_cron_heartbeats()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer := 0;
begin
  if to_regclass('cron.job') is null or to_regclass('cron.job_run_details') is null then
    raise notice 'sync_cron_heartbeats: pg_cron is not present, nothing to sync';
    return 0;
  end if;

  with latest as (
    select m.job_name,
           r.status,
           r.return_message,
           coalesce(r.end_time, r.start_time) as ran_at,
           row_number() over (partition by m.job_name
                                  order by coalesce(r.end_time, r.start_time) desc) as rn
      from public.cron_job_heartbeat_map m
      join cron.job j              on j.jobname = m.cron_jobname
      join cron.job_run_details r  on r.jobid   = j.jobid
      -- Terminal statuses only. pg_cron writes starting/running/sending rows
      -- before the outcome is known, and 20260914120000 already records what
      -- treating those as outcomes costs: a job that overruns its interval
      -- looks like a failure while working perfectly.
     where r.status in ('succeeded', 'failed')
  )
  insert into public.job_heartbeats (job_name, last_run_at, last_status, last_detail)
  select l.job_name,
         l.ran_at,
         case when l.status = 'succeeded' then 'ok' else 'error' end,
         case when l.status = 'succeeded'
              then 'pg_cron run succeeded ' || to_char(l.ran_at, 'DD Mon HH24:MI')
              else 'pg_cron run FAILED: ' || left(coalesce(l.return_message, 'no message'), 180)
         end
    from latest l
   where l.rn = 1
  on conflict (job_name) do update
     set last_run_at = excluded.last_run_at,
         last_status = excluded.last_status,
         last_detail = excluded.last_detail;
  -- Unconditional, not "only if newer". cron.job_run_details is the ONLY writer
  -- of these four rows — that is what the map means — so it is authoritative
  -- including when it moves a timestamp backwards, which happens exactly once:
  -- on the first sync, correcting the seeded placeholder to the real last run.

  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.sync_cron_heartbeats is
  'Writes a heartbeat for each job in cron_job_heartbeat_map from its most recent terminal run in cron.job_run_details. Four jobs — mark-lapsed-subscriptions, purge-archived, prune-webhook-deliveries, reconcile-webhooks — do their work inline in SQL and so had nowhere to call record_heartbeat() from, and were monitored by nothing until 24 September 2026.';

revoke all on function public.sync_cron_heartbeats() from public, anon, authenticated;
grant execute on function public.sync_cron_heartbeats() to service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Seed the four heartbeat rows
-- ════════════════════════════════════════════════════════════════════════════
-- stale_after has to cover the job's own period PLUS the lag before anyone
-- looks. sync_cron_heartbeats() runs inside watch_jobs(), which is scheduled
-- '*/15', so a run can sit unobserved for up to 15 minutes:
--
--   reconcile-webhooks  */5      5 min + 15 min observation → 20 minutes
--   the three dailies   daily   24 h  + 15 min              → 30 hours
--
-- and the watchdog alerts at stale_after × 2 on top of that (40 minutes, 60
-- hours), deliberately looser than stale_jobs(), per 20260914120000.
--
-- Seeded 'ok' with last_run_at defaulting to now(), NOT 'never reported'. The
-- 'never reported' literal is a trigger condition in watch_jobs' heartbeat
-- detector regardless of elapsed time, so seeding it would open four incidents
-- during this very transaction — and 20260914120000's header is explicit that a
-- board which is never green is a board nobody reads. The grace this buys is
-- bounded: if the sync never works, the seeded timestamp ages out and the
-- detector opens a real incident at 40 minutes / 60 hours. Absence still fails
-- loudly, just not on install day.
--
-- watch = true on all four: every one has a cron entry, so "has never reported"
-- is a fault rather than a steady state. That is the distinction the column was
-- added for.
insert into public.job_heartbeats (job_name, stale_after, last_status, last_detail, watch) values
  ('mark-lapsed-subscriptions', interval '30 hours',   'ok', 'seeded 24 Sep — awaiting first sync from cron.job_run_details', true),
  ('purge-archived',            interval '30 hours',   'ok', 'seeded 24 Sep — awaiting first sync from cron.job_run_details', true),
  ('prune-webhook-deliveries',  interval '30 hours',   'ok', 'seeded 24 Sep — awaiting first sync from cron.job_run_details', true),
  ('reconcile-webhooks',        interval '20 minutes', 'ok', 'seeded 24 Sep — awaiting first sync from cron.job_run_details', true)
on conflict (job_name) do update
   -- Only the threshold. Re-running this must fix a wrong stale_after, but it
   -- must NOT resurrect last_status/last_detail (the sync owns those) and must
   -- not flip `watch` back on for a job somebody deliberately turned off.
   set stale_after = excluded.stale_after;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. The watchdog, with schedule-relative thresholds
-- ════════════════════════════════════════════════════════════════════════════
-- `create or replace` with the return type unchanged —
-- (opened integer, resolved integer, still_open integer). Changing it would
-- raise 42P13 and roll back everything above.
--
-- Three changes from 20260914120000, and nothing else. The advisory lock, the
-- single 'heartbeat' kind, the ordered array_agg instead of max(), the
-- opened_at = updated_at test, the self-exclusion and the housekeeping are all
-- carried over verbatim; every one of them is load-bearing and documented in
-- that file.
--
--   (i)   sync_cron_heartbeats() runs first, inside a block that cannot
--         propagate a failure.
--   (ii)  detector (b) takes its window and threshold from the cron schedule.
--   (iii) detector (c) takes its window and threshold from the schedule of the
--         cron entry that calls the edge function.

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
  v_synced   integer;
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

  -- ── Bring the SQL-only jobs' heartbeats up to date ───────────────────────
  -- In its own block. If this raises — pg_cron upgraded and renamed a column,
  -- a permission changed — the watchdog must still run. A monitor that a
  -- housekeeping step can take offline is the entire subject of the file this
  -- one extends.
  begin
    v_synced := public.sync_cron_heartbeats();
  exception when others then
    raise warning 'watch_jobs: sync_cron_heartbeats failed, continuing without it: %', sqlerrm;
  end;

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
  -- job-watchdog excludes ITSELF. Including it makes the fixed point
  -- unreachable — see 20260914120000.
  --
  -- `watch` excludes jobs nothing schedules, e.g. summarize-chats.
  --
  -- stale_after * 2, deliberately looser than stale_jobs(). One missed tick is
  -- a blip; two is a pattern.
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
  -- test counts every in-flight run as a failure.
  --
  -- The window and the count now come from the job's own schedule
  -- (cron_failure_policy). The constant 26-hour pre-filter in the WHERE clause
  -- is not redundant with pol.win: it is a plain, index-usable bound on
  -- start_time that keeps this from scanning the whole of job_run_details
  -- before the lateral is evaluated. 26 hours is the widest window the policy
  -- can return, so it never excludes a row the policy would have wanted.
  --
  -- NOTE, unchanged: these are pg_cron job names (abrobot-run-automations),
  -- which are not the heartbeat names (run-automations). One broken job can
  -- appear as two incidents under two names.
  insert into _problems
  select j.jobname, 'cron_failing',
         count(*) || ' failed run(s) in the last ' || pol.win::text
         || ' (threshold ' || pol.min_failures || '), most recent: '
         || left(coalesce((array_agg(r2.return_message order by r2.start_time desc))[1],
                          'no message'), 160)
    from cron.job j
    join cron.job_run_details r2 on r2.jobid = j.jobid
    cross join lateral public.cron_failure_policy(j.schedule) pol
   where r2.status = 'failed'
     and r2.start_time > now() - interval '26 hours'
     and r2.start_time > now() - pol.win
   group by j.jobname, pol.win, pol.min_failures
  having count(*) >= pol.min_failures;

  -- ── (c) An edge function answering non-2xx, attributed by name ───────────
  -- array_agg ordered by time, not max(). max() returns the largest status
  -- code, so a run with a 500 and a later 401 would report the 500 as "most
  -- recent" — the precise species of misdiagnosis that file exists to stop.
  --
  -- Same schedule-relative treatment: system-health runs hourly and nurture
  -- daily, so under the old flat `>= 2` in one hour neither could ever be
  -- reported here no matter how badly it was failing.
  insert into _problems
  select l.fn, 'http_error',
         count(*) || ' non-2xx response(s) in the last ' || pol.win::text
         || ' (threshold ' || pol.min_failures || '), most recent: '
         || coalesce((array_agg(resp.status_code order by resp.created desc))[1]::text, '?')
         || ' - ' || left(coalesce((array_agg(coalesce(resp.error_msg, resp.content::text)
                                              order by resp.created desc))[1], ''), 140)
    from public.edge_call_log l
    join net._http_response resp on resp.id = l.request_id
    cross join lateral public.edge_failure_policy(l.fn) pol
   where l.called_at > now() - interval '26 hours'
     and l.called_at > now() - pol.win
     and (resp.status_code is null or resp.status_code < 200 or resp.status_code >= 300)
   group by l.fn, pol.win, pol.min_failures
  having count(*) >= pol.min_failures;

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
  if v_opened > 0 then
    select * into v_send from public.watch_jobs_notify(
      '🔴 AbroBot CRM — ' || v_opened || ' job incident(s) opened' || chr(10)
      || array_to_string(v_lines, chr(10)));

    -- now() is transaction_timestamp(), and opened_at defaults to now(), so
    -- this matches exactly the rows inserted by THIS transaction — and not, as
    -- an earlier draft did, every still-open incident from any previous run.
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
  -- Counts incidents OTHER than its own.
  select count(*)::integer into v_open
    from public.job_incidents
   where resolved_at is null and job_name <> 'job-watchdog';

  -- Housekeeping: edge_call_log only needs to outlive net._http_response,
  -- which self-purges in hours. A week is generous.
  delete from public.edge_call_log where called_at < now() - interval '7 days';

  perform public.record_heartbeat(
    'job-watchdog',
    case when v_open > 0 then 'warn' else 'ok' end,
    v_opened || ' opened, ' || v_resolved || ' resolved, ' || v_open || ' open'
      || ', ' || coalesce(v_synced, 0) || ' heartbeat(s) synced from cron');

  return query select v_opened, v_resolved, v_open;
end;
$$;

comment on function public.watch_jobs is
  'Detects stopped, stale, unhealthy or erroring scheduled jobs from database state alone and records each as an incident. Pure SQL on pg_cron with no edge function in the path. Since 24 September 2026 it also syncs heartbeats for the four SQL-only cron jobs that had none, and its failure thresholds scale with each job''s schedule — a flat "2 failures in an hour" exempted every job running once an hour or less, which was five of the eight.';

revoke all on function public.watch_jobs() from public, anon, authenticated;
grant execute on function public.watch_jobs() to service_role;

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- First sync, in a DO block that CANNOT raise
-- ════════════════════════════════════════════════════════════════════════════
-- Everything after `commit` shares one implicit transaction. An exception here
-- would roll back nothing that matters (the schema is committed) but it would
-- abort the verify block below, which is the part that reports what state the
-- database is actually in.
do $first$
declare n integer;
begin
  n := public.sync_cron_heartbeats();
  raise notice 'first sync: % heartbeat row(s) written from cron.job_run_details', n;
exception when others then
  raise warning 'first sync FAILED (schema is intact, the watchdog will retry in 15 minutes): %', sqlerrm;
end
$first$;

-- ════════════════════════════════════════════════════════════════════════════
-- Verify
-- ════════════════════════════════════════════════════════════════════════════
-- Rows 1–2 are PASS/FAIL and testable from the repo. Rows 3–6 report live
-- state — what pg_cron actually has scheduled and what the heartbeats actually
-- say — because none of that can be known from these files.

select * from (

  -- 1. The frequency parser, against the eight schedules this repo really
  --    uses plus the cases that break naive parsing. A case table rather than
  --    an assertion about one input: the reason the old threshold was wrong is
  --    that it was only ever checked against '*/15'.
  select 1 as ord, 'cron_runs_per_hour parses the real schedules' as check,
         case when (select count(*) from (values
                      ('*/15 * * * *', 4::numeric, 'run-automations, job-watchdog'),
                      ('*/5 * * * *',  12,         'reconcile-webhooks'),
                      ('0 * * * *',    1,          'system-health'),
                      ('30 9 * * *',   0,          'nurture'),
                      ('30 2 * * *',   0,          'mark-lapsed-subscriptions'),
                      ('15 3 * * *',   0,          'purge-archived'),
                      ('45 3 * * *',   0,          'prune-webhook-deliveries'),
                      ('* * * * *',    60,         'every minute'),
                      ('0,30 * * * *', 2,          'twice an hour'),
                      ('0 */6 * * *',  0,          'four times a day'),
                      ('30 seconds',   120,        'pg_cron interval syntax')
                    ) as c(sched, expected, why)
                    where public.cron_runs_per_hour(c.sched) is distinct from c.expected) = 0
              then 'PASS — all 11 schedules parse as specified'
              else 'FAIL — ' || (select string_agg(c.sched || ' gave '
                                   || coalesce(public.cron_runs_per_hour(c.sched)::text,'NULL')
                                   || ', expected ' || c.expected::text || ' (' || c.why || ')', '; ')
                                   from (values
                                     ('*/15 * * * *', 4::numeric, 'run-automations, job-watchdog'),
                                     ('*/5 * * * *',  12,         'reconcile-webhooks'),
                                     ('0 * * * *',    1,          'system-health'),
                                     ('30 9 * * *',   0,          'nurture'),
                                     ('30 2 * * *',   0,          'mark-lapsed-subscriptions'),
                                     ('15 3 * * *',   0,          'purge-archived'),
                                     ('45 3 * * *',   0,          'prune-webhook-deliveries'),
                                     ('* * * * *',    60,         'every minute'),
                                     ('0,30 * * * *', 2,          'twice an hour'),
                                     ('0 */6 * * *',  0,          'four times a day'),
                                     ('30 seconds',   120,        'pg_cron interval syntax')
                                   ) as c(sched, expected, why)
                                  where public.cron_runs_per_hour(c.sched) is distinct from c.expected)
         end as detail

  -- 2. The thing the old code got wrong, stated as a test: a daily job must
  --    now be detectable from a single failure, and a 15-minute job must still
  --    need two.
  union all
  select 2, 'a daily failure is now detectable',
         case when (select min_failures from public.cron_failure_policy('15 3 * * *')) = 1
               and (select win          from public.cron_failure_policy('15 3 * * *')) = interval '26 hours'
               and (select min_failures from public.cron_failure_policy('*/15 * * * *')) = 2
               and (select win          from public.cron_failure_policy('*/15 * * * *')) = interval '1 hour'
              then 'PASS — daily: 1 failure in 26h; */15: 2 failures in 1h (unchanged)'
              else 'FAIL — daily gives ' || (select min_failures::text from public.cron_failure_policy('15 3 * * *'))
                   || ' in ' || (select win::text from public.cron_failure_policy('15 3 * * *'))
         end

  -- 3. All four previously-unmonitored jobs now have a heartbeat row.
  union all
  select 3, 'the four unmonitored jobs have heartbeat rows',
         case when (select count(*) from public.job_heartbeats
                     where job_name in ('mark-lapsed-subscriptions','purge-archived',
                                        'prune-webhook-deliveries','reconcile-webhooks')
                       and watch) = 4
              then 'PASS — 4 of 4, watched'
              else 'FAIL — ' || (select count(*)::text from public.job_heartbeats
                                  where job_name in ('mark-lapsed-subscriptions','purge-archived',
                                                     'prune-webhook-deliveries','reconcile-webhooks')
                                    and watch) || ' of 4'
         end

  -- 4. ── LIVE STATE ─────────────────────────────────────────────────────────
  --    What the four now say. On a healthy system these should show a real run
  --    time within the last day; "awaiting first sync" means pg_cron has no
  --    terminal run recorded for that entry, which is worth understanding —
  --    either it has genuinely never run, or job_run_details has been pruned.
  union all
  select 4, 'what the four newly-watched jobs report',
         coalesce((select string_agg(job_name || ' → ' || last_status || ' @ '
                                     || to_char(last_run_at, 'DD Mon HH24:MI')
                                     || ' [' || left(coalesce(last_detail,''), 70) || ']',
                                     '  |  ' order by job_name)
                     from public.job_heartbeats
                    where job_name in ('mark-lapsed-subscriptions','purge-archived',
                                       'prune-webhook-deliveries','reconcile-webhooks')),
                  'none — the seed did not apply, which should be impossible')

  -- 5. Every scheduled entry with the threshold now in force for it. This is
  --    the row that shows whether the policy matches reality: a job here whose
  --    schedule is unparsed shows the old constants, and that is visible.
  union all
  select 5, 'threshold now in force per cron entry',
         coalesce((select string_agg(j.jobname || ' (' || j.schedule || ') → '
                                     || pol.min_failures || ' failure(s) in ' || pol.win::text
                                     || case when j.active then '' else ' [INACTIVE]' end,
                                     '  |  ' order by j.jobname)
                     from cron.job j
                     cross join lateral public.cron_failure_policy(j.schedule) pol),
                  'pg_cron is not present')

  -- 6. Everything being watched, and everything not.
  union all
  select 6, 'full heartbeat picture',
         coalesce((select string_agg(job_name || case when watch then '' else ' (NOT watched)' end
                                     || ' [' || last_status || ']',
                                     ', ' order by job_name)
                     from public.job_heartbeats), '(no rows)')

  union all
  select 7, 'open incidents',
         coalesce((select string_agg(job_name || ' [' || kind || '] ' || left(coalesce(detail,''),80),
                                     '  |  ' order by opened_at)
                     from public.job_incidents where resolved_at is null),
                  'none')

) t order by ord;

-- ── What to expect afterwards ───────────────────────────────────────────────
-- Row 4 is the one to re-read tomorrow. If any of the four still says
-- "awaiting first sync" after 24 hours, that job has not had a terminal run
-- recorded — either it is genuinely not running (which is the finding this
-- migration was written to surface) or cron.job_run_details is being pruned
-- faster than a day:
--
--   select j.jobname, r.status, r.start_time, r.return_message
--     from cron.job_run_details r join cron.job j on j.jobid = r.jobid
--    where j.jobname in ('mark-lapsed-subscriptions','purge-archived',
--                        'prune-webhook-deliveries','reconcile-webhooks')
--    order by r.start_time desc limit 40;
--
-- To stop watching one of them without removing anything:
--   update public.job_heartbeats set watch = false where job_name = '<name>';
--
-- To add a future SQL-only cron job to the sync:
--   insert into public.cron_job_heartbeat_map (cron_jobname, job_name, note)
--   values ('<cron entry>', '<heartbeat name>', 'plain SQL: …');
--   insert into public.job_heartbeats (job_name, stale_after, last_status, last_detail)
--   values ('<heartbeat name>', interval '<2× its period + 15 min>', 'ok', 'seeded');
-- Do NOT add an entry that calls call_edge_function() — see the table comment.
