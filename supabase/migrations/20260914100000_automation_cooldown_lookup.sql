-- AbroBot CRM — make the automation sweep correct at volume.
--
-- Run 20260914090000_scale_and_assignment.sql first.
--
-- Four things, all consequences of the same root cause: the cron sweep was
-- written as if an organisation has a few hundred leads.
--
--   1. automation_last_runs()   — a cooldown check that cannot be truncated
--   2. automation_sweep_state   — a resume cursor, so a large org is not starved
--   3. automation_mark_run()    — an increment that cannot lose a concurrent one
--   4. drops a duplicate index that 20260914090000 created by accident
--
-- ════════════════════════════════════════════════════════════════════════════
-- 1. The cooldown check
-- ════════════════════════════════════════════════════════════════════════════
-- Before every firing, run-automations asked "has this rule already run for
-- this lead recently?" by pulling the whole cooldown window in one go:
--
--   supabase.from("automation_runs")
--     .select("lead_id, created_at")
--     .eq("automation_id", a.id)
--     .gte("created_at", since)          -- no .limit()
--
-- PostgREST's max-rows (1,000 on this project) silently capped that result.
--
-- Truncation here is not a degraded answer, it is an INVERTED one. A row that
-- is present means "already ran, skip". A row that is missing means "never
-- ran, go ahead". So the moment a rule had more than a thousand runs inside
-- its own cooldown window, it stopped being able to see its own history and
-- started firing again for leads it had already processed — a second Telegram
-- alert, a second stage move, a second note, on the same lead, the same day.
--
-- It needed volume to appear, and volume is exactly what the paid plans sell.
--
-- The fix is to ask per batch rather than per window, and to return at most one
-- row per lead. The caller walks leads in pages of 500, so the answer is
-- bounded by the page size and cannot reach max-rows however busy the rule is.

begin;

create or replace function public.automation_last_runs(
  p_automation_id uuid,
  p_lead_ids      uuid[],
  p_since         timestamptz
)
returns table (lead_id uuid, last_run_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  -- DISTINCT ON (lead_id) ... ORDER BY lead_id, created_at DESC is an
  -- index-only walk given automation_runs_lookup_idx.
  select distinct on (r.lead_id) r.lead_id, r.created_at
    from public.automation_runs r
   where r.automation_id = p_automation_id
     and r.lead_id = any(p_lead_ids)
     and r.created_at >= p_since
   order by r.lead_id, r.created_at desc;
$$;

comment on function public.automation_last_runs is
  'Most recent automation_run per lead for one rule inside a time window, for a bounded batch of lead ids. Replaces fetching the entire cooldown window, which PostgREST silently truncated at max-rows — and because a missing row reads as "never ran", truncation made rules re-fire for leads they had already processed.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. A resume cursor for the sweep
-- ════════════════════════════════════════════════════════════════════════════
-- The sweep now stops itself before the platform's wall clock kills it. On its
-- own that is a trap rather than a fix: without somewhere to record how far it
-- got, every invocation restarts at the beginning and walks the same prefix, so
-- an org too large to finish in one tick has its tail processed NEVER — not
-- occasionally, never. That is strictly worse than the truncation it replaced,
-- because at least an arbitrary thousand rows varied between runs.
--
-- One row per org. Deliberately not a column on organizations: this is
-- scheduler bookkeeping with a different write pattern and no business meaning,
-- and it should not make every read of organizations touch a hotter page.

create table if not exists public.automation_sweep_state (
  org_id     uuid primary key references public.organizations(id) on delete cascade,
  cursor     uuid,           -- last lead id processed; null = start from the top
  updated_at timestamptz not null default now()
);

comment on table public.automation_sweep_state is
  'Where the cron automation sweep stopped for each org, so a tenant too large to process in one invocation is walked across several ticks instead of having everything after the cut-off permanently skipped.';

alter table public.automation_sweep_state enable row level security;

-- No policies, by design. Nothing in the product surfaces this, and only the
-- service role writes it. RLS enabled with zero policies denies everything to
-- anon and authenticated, which is the intended posture; leaving RLS off would
-- have exposed the whole table to any signed-in user via PostgREST.

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Stamping a rule as run, without losing a concurrent increment
-- ════════════════════════════════════════════════════════════════════════════
-- run_count was maintained as `(a.run_count ?? 0) + 1` from a copy the edge
-- function had fetched earlier in the same invocation. Any increment that
-- happened in between — from the event path firing the same rule at intake —
-- was overwritten. Incrementing in the database removes the window.

create or replace function public.automation_mark_run(p_automation_id uuid)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.automations
     set run_count = coalesce(run_count, 0) + 1,
         last_run_at = now()
   where id = p_automation_id;
$$;

comment on function public.automation_mark_run is
  'Increments run_count and sets last_run_at atomically. The read-modify-write it replaces lost increments when cron and the event path fired the same rule concurrently.';

-- ════════════════════════════════════════════════════════════════════════════
-- Grants
-- ════════════════════════════════════════════════════════════════════════════
-- Same posture as every other SECURITY DEFINER helper here: not reachable from
-- a browser session.
--
-- The explicit `from public` matters. A bare `grant ... to authenticated` would
-- ADD to the default PUBLIC EXECUTE grant rather than replace it, which is how
-- a definer function ends up callable by anon without anyone intending it.
--
-- And the grant to service_role is explicit rather than assumed. service_role
-- has BYPASSRLS, which is often mistaken for "bypasses everything" — it does
-- not bypass function EXECUTE privileges. These functions work for the edge
-- runtime only because Supabase's default privileges grant EXECUTE to
-- service_role at creation time; saying so here means a later hardening pass
-- that tightens those defaults breaks loudly at migration time instead of
-- silently at 3am.
revoke all on function public.automation_last_runs(uuid, uuid[], timestamptz)
  from public, anon, authenticated;
revoke all on function public.automation_mark_run(uuid)
  from public, anon, authenticated;
grant execute on function public.automation_last_runs(uuid, uuid[], timestamptz) to service_role;
grant execute on function public.automation_mark_run(uuid) to service_role;
grant select, insert, update on public.automation_sweep_state to service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Drop the duplicate index
-- ════════════════════════════════════════════════════════════════════════════
-- 20260914090000 created automation_runs_cooldown_idx on
-- (automation_id, lead_id, created_at desc). 20260819090000:104 had already
-- created automation_runs_lookup_idx on exactly those columns in exactly that
-- order. `if not exists` matches on the NAME, so both were built: two identical
-- btrees maintained on every insert into the most append-heavy table here.
--
-- 20260914090000 no longer creates it. This drop is for anyone who ran the
-- earlier version. Guarded so it can only ever remove the redundant one.
do $$
begin
  if exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'automation_runs_lookup_idx')
     and exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'automation_runs_cooldown_idx')
  then
    execute 'drop index public.automation_runs_cooldown_idx';
    raise notice 'dropped duplicate index automation_runs_cooldown_idx';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Deleted leads must not count towards anyone's assignment load
-- ════════════════════════════════════════════════════════════════════════════
-- 20260903150000 made deletion soft and enforced it in RLS ONLY, on the stated
-- reasoning that then "nobody has to remember to add the filter". That holds
-- for the app, which reads as the signed-in user. It does not hold for anything
-- running as the service role — which bypasses RLS by design, and which is what
-- every edge function uses.
--
-- org_assignment_load() shipped yesterday with the same blind spot: its
-- `left join public.leads` counts deleted records, so a rep who has had fifty
-- leads deleted still looks like the busiest person on the team and round-robin
-- routes away from them indefinitely.
--
-- Redefined here rather than edited in place because 20260914090000 may already
-- have been applied.
create or replace function public.org_assignment_load(p_org_id uuid)
returns table (user_id uuid, open_leads bigint)
language sql
stable
security definer
set search_path = public
as $$
  select p.id,
         count(l.id) filter (
           where l.id is not null
             and l.deleted_at is null
             and coalesce(ps.is_won, false) = false
             and coalesce(ps.is_lost, false) = false
         ) as open_leads
    from public.profiles p
    left join public.leads l
      on l.org_id = p.org_id and l.assigned_to = p.id and l.deleted_at is null
    left join public.pipeline_stages ps
      on ps.org_id = l.org_id and ps.key = l.stage_key
   where p.org_id = p_org_id
     and p.status = 'active'
   group by p.id
   order by open_leads asc, p.id asc;
$$;

-- The grant 20260914090000 left implicit. Its comment there asserted that
-- service_role "is not subject to these grants" — which is the misconception
-- section 3 above exists to correct. BYPASSRLS does not bypass EXECUTE.
revoke all on function public.org_assignment_load(uuid) from public, anon, authenticated;
grant execute on function public.org_assignment_load(uuid) to service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Make a degraded job visible
-- ════════════════════════════════════════════════════════════════════════════
-- run-automations now reports "warn" when it finished on time but could not do
-- its work — a failed cooldown lookup, a lead page that errored, an org skipped
-- because its stages would not load.
--
-- That signal had nowhere to land. stale_jobs() filtered on last_run_at alone,
-- so a job that runs perfectly on schedule and accomplishes nothing was
-- indistinguishable from a healthy one, and last_status was written by three
-- edge functions and read by none.
create or replace function public.stale_jobs()
returns table (job_name text, last_run_at timestamptz, minutes_late numeric, last_status text)
language sql
stable
security definer
set search_path = public
as $$
  -- minutes_late keeps its original meaning: minutes PAST the staleness
  -- threshold, so a job that is merely unhealthy rather than late shows a
  -- negative figure. Changing the formula would silently reinterpret whatever
  -- already reads this column.
  select h.job_name,
         h.last_run_at,
         round(extract(epoch from (now() - h.last_run_at - h.stale_after)) / 60.0, 1),
         h.last_status
    from public.job_heartbeats h
   where now() - h.last_run_at > h.stale_after      -- late
      or coalesce(h.last_status, 'ok') <> 'ok'      -- or on time and unhealthy
   order by 3 desc;
$$;

-- Grants are RESTATED, not widened.
--
-- 20260906100000:116 deliberately revoked this from `authenticated` — it
-- reports platform-wide job status across every tenant, and it had been
-- readable by every logged-in customer. `create or replace` preserves existing
-- privileges, so nothing here needs to re-grant them; saying so explicitly is
-- what stops the next person "helpfully" adding `to authenticated` back. The
-- verify block in that migration asserts this, and would catch it.
revoke all on function public.stale_jobs() from public, anon, authenticated;
grant execute on function public.stale_jobs() to service_role;

comment on function public.stale_jobs is
  'Jobs that are late OR whose last run reported a status other than ok. The status half is the point: a sweep that fires on schedule and silently does nothing used to look identical to a healthy one.';

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Deleted records must not consume plan quota
-- ════════════════════════════════════════════════════════════════════════════
-- Same root cause as section 5, different victim. Both of these count leads
-- with no deleted_at filter:
--
--   guard_lead_limit()  — the trigger that refuses an insert past the cap
--   usage_snapshot()    — what the Plan & usage screen displays
--
-- That was survivable while deleted rows were invisible everywhere. It is not
-- survivable now that the API and the app agree on excluding them, because the
-- two numbers visibly disagree: `GET /api/v1/leads` reports 480 of 500 while
-- the meter says 500/500 and the insert is refused with "Upgrade to add more,
-- or archive some first" — advice that does nothing, since archiving is
-- precisely what set deleted_at.
--
-- It is also the strict direction, not the generous one: customers were being
-- charged headroom for records they had deleted, for the thirty days until the
-- retention job purges them.
--
-- Patched in place rather than re-declared. Both bodies are long and one of
-- them (guard_lead_limit) carries the free-plan inbound exemption that was
-- itself a bug fix; copying either one out and back is how a subtle clause
-- gets dropped. This rewrites the single counting statement and verifies that
-- it actually changed.
do $$
declare
  f     text;
  src   text;
  patched text;
begin
  foreach f in array array[
    'public.guard_lead_limit()',
    'public.usage_snapshot(uuid)'
  ] loop
    if to_regprocedure(f) is null then
      raise notice 'skipping % (does not exist)', f;
      continue;
    end if;

    src := pg_get_functiondef(to_regprocedure(f));

    -- Idempotent: a second run finds nothing left to change and says so.
    if src ~ 'from public\.leads\s+where org_id = (new\.org_id|p_org_id)\s+and deleted_at is null' then
      raise notice '% already excludes deleted records', f;
      continue;
    end if;

    patched := regexp_replace(
      src,
      'from public\.leads\s+where org_id = (new\.org_id|p_org_id);',
      'from public.leads where org_id = \1 and deleted_at is null;',
      'g'
    );

    if patched = src then
      raise exception
        'could not find the lead count in % — it has been rewritten since 20260914100000 was authored. Patch it by hand rather than guessing.', f
        using errcode = 'P0001';
    end if;

    execute patched;
    raise notice 'patched %', f;
  end loop;
end $$;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select 'the cooldown lookup exists' as check,
       case when exists (
              select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'automation_last_runs')
            then 'PASS' else 'FAIL' end as result
union all
select 'the run stamp exists',
       case when exists (
              select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'automation_mark_run')
            then 'PASS' else 'FAIL' end
union all
select 'neither is callable from the browser',
       case when has_function_privilege('authenticated',
                    'public.automation_last_runs(uuid, uuid[], timestamptz)', 'execute')
              or has_function_privilege('authenticated',
                    'public.automation_mark_run(uuid)', 'execute')
            then 'FAIL — authenticated can execute one of them'
            else 'PASS' end
union all
select 'the edge runtime can call them',
       case when has_function_privilege('service_role',
                    'public.automation_last_runs(uuid, uuid[], timestamptz)', 'execute')
            then 'PASS' else 'FAIL — service_role cannot execute' end
union all
select 'the resume cursor table exists and is locked down',
       case when not exists (select 1 from pg_tables
                              where schemaname = 'public' and tablename = 'automation_sweep_state')
            then 'FAIL — table missing'
            when not (select relrowsecurity from pg_class where oid = 'public.automation_sweep_state'::regclass)
            then 'FAIL — RLS is off, every signed-in user can read it'
            else 'PASS' end
union all
select 'the cooldown index is present exactly once',
       (select count(*)::text || ' index(es) on automation_runs (automation_id, lead_id, created_at desc)'
          from pg_indexes
         where schemaname = 'public'
           and indexname in ('automation_runs_lookup_idx','automation_runs_cooldown_idx'))
union all
select 'pagination has an index to use',
       case when exists (select 1 from pg_indexes
                          where schemaname = 'public' and indexname = 'leads_org_id_idx')
            then 'PASS'
            else 'FAIL — re-run 20260914090000_scale_and_assignment.sql' end
union all
select 'plan limits ignore deleted records',
       case when (select count(*) from pg_proc p
                    join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname in ('guard_lead_limit','usage_snapshot')
                     and pg_get_functiondef(p.oid) ~ 'deleted_at is null') = 2
            then 'PASS — both'
            else 'CHECK — one of guard_lead_limit / usage_snapshot still counts deleted rows' end
union all
-- How much quota deleted records were silently consuming, per org. Anything
-- non-zero here is headroom a customer was being denied until this migration.
select 'quota that deleted records were holding',
       coalesce((select string_agg(x.slug || ': ' || x.n, ', ')
                   from (select o.slug, count(l.id) as n
                           from public.organizations o
                           join public.leads l
                             on l.org_id = o.id and l.deleted_at is not null
                          group by o.slug
                          order by count(l.id) desc
                          limit 10) x),
                'none — no deleted records anywhere')
union all
-- Rules that fired more than once for the same lead inside the SAME cooldown
-- window — the duplicate-firing bug leaving evidence behind.
--
-- cooldown_hours = 0 is excluded: that is a legitimate setting meaning "no
-- cooldown", and inCooldown() correctly lets those rules fire every sweep, so
-- counting them here would be a false positive on a working configuration.
select 'leads that received a repeat firing inside a cooldown window',
       coalesce((
         select count(*)::text || ' (rule, lead) pair(s) — check for duplicate alerts'
           from (
             select r1.automation_id, r1.lead_id
               from public.automation_runs r1
               join public.automation_runs r2
                 on r2.automation_id = r1.automation_id
                and r2.lead_id = r1.lead_id
                and r2.created_at > r1.created_at
               join public.automations a on a.id = r1.automation_id
              where a.cooldown_hours > 0
                and r2.created_at < r1.created_at + (a.cooldown_hours || ' hours')::interval
              group by r1.automation_id, r1.lead_id
           ) d
          having count(*) > 0),
        'none');
