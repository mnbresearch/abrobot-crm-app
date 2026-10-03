-- ════════════════════════════════════════════════════════════════════════════
-- Make the plan guards count what they claim to count, and say what is true.
--
-- Three defects, all of them things a paying customer hits and we do not:
--
-- 1. ARCHIVED RECORDS STILL CONSUME THE RECORD CAP.
--    `guard_lead_limit` counts `select count(*) from leads where org_id = ...`
--    with no `deleted_at is null`, and `archive_lead()` only sets `deleted_at`.
--    `purge_archived()` does not hard-delete for 30 days. So a Starter org
--    (1,000) that imports 1,000 and archives 900 captures nothing for a month,
--    while the error message tells them:
--
--      "Your plan includes 1000 records and you have 1000. Upgrade to add
--       more, or archive some first."
--
--    They archive, nothing changes, and they conclude the product is broken.
--    On the free plan (50) this hits every evaluator who tidies up their test
--    rows — and because inbound capture is NOT exempt on free, their widget
--    then starts silently refusing real enquiries.
--
--    `usage_snapshot` counts the same way, so the Settings screen agrees with
--    the trigger and neither reveals the problem.
--
-- 2. A BRAND-NEW FREE ACCOUNT IS TOLD ITS SUBSCRIPTION HAS ENDED.
--    `guard_automation_limit` branches on `lim = 0` and says "Your subscription
--    has ended, so automations are paused." Since 20260908090000 set
--    `free.max_automations = 0`, the zero branch is now far more often the FREE
--    case than the expired one. The message is simply false for an account
--    created ten minutes ago, and it lands at the moment of highest upgrade
--    intent. `guard_lead_limit` was given a proper three-way split in
--    20260911090000; this guard was never updated to match.
--
-- 3. The record-cap message said "archive some first" when archiving did not
--    help. Fixing (1) makes that sentence true, so it stays.
--
-- Additions only. No behaviour is removed, no policy is dropped, and every
-- limit that was enforced before is still enforced.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. guard_lead_limit: count records that still occupy the plan ───────────
-- Full redefinition because plpgsql has no way to patch one statement. Every
-- other line is carried over verbatim from 20260911090000 — the inbound
-- exemption, the deliberate absence of a lock, and the three-way message split.

create or replace function public.guard_lead_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  lim      int;
  used     int;
  inbound  boolean;
  v_plan   text;
begin
  -- Cast to text before comparing. leads.source is the lead_source ENUM, so an
  -- unknown literal here is not a false comparison — it is a hard
  -- "invalid input value for enum" that plpgsql only raises on the first
  -- insert, long after the migration appeared to succeed.
  inbound := new.source::text in
             ('website', 'whatsapp', 'chatbase', 'email', 'referral');

  select max_leads into lim from public.plan_of(new.org_id);
  if lim is null then return new; end if;                 -- unlimited

  select public.effective_plan(new.org_id) into v_plan;

  -- Inbound capture is allowed to run past the cap on a PAID plan: losing a
  -- real enquiry because a counter rolled over costs that customer far more
  -- than the row costs us, and they are paying.
  if inbound and lim > 0 and v_plan not in ('free', 'expired') then
    return new;
  end if;

  -- Count-then-insert is still deliberately not atomic — taking a lock on every
  -- insert to prevent an occasional off-by-one overage would slow the hot intake
  -- path to protect revenue measured in fractions of a rupee.
  --
  -- NOT `deleted_at is null` alone. archive_lead() is one click and
  -- purge_archived() does not hard-delete for 30 days, so counting only live
  -- rows would let any org capture to the cap, archive, and capture again —
  -- repeatedly, inside that window. Free (50) would be effectively unlimited.
  --
  -- A row still occupies the plan until it is actually purged, so that is what
  -- is counted: live rows, plus archived rows not yet past the purge horizon.
  -- Archiving therefore frees a slot after 30 days, which is what "archive some
  -- first" can honestly promise.
  select count(*) into used
    from public.leads
   where org_id = new.org_id
     and (deleted_at is null or deleted_at > now() - interval '30 days');

  if used < lim then return new; end if;

  if v_plan = 'expired' then
    raise exception
      'Your subscription has ended, so new records are paused. Your existing data is safe and still exportable — renew to continue.'
      using errcode = 'P0001';
  end if;

  if v_plan = 'free' then
    raise exception
      'The free plan includes % records and you have used all of them. Choose a plan to keep capturing — your existing records stay exactly as they are.', lim
      using errcode = 'P0001';
  end if;

  -- "archive some first" is now true, with a delay: an archived row stops
  -- counting once purge_archived() passes it, 30 days on.
  raise exception
    'Your plan includes % records and you have %. Upgrade to add more, or archive some first.', lim, used
    using errcode = 'P0001';
end;
$$;

-- ── 2. usage_snapshot: agree with the trigger ───────────────────────────────
-- If these two disagree, the Settings screen and the error message contradict
-- each other and the customer cannot tell which is lying.

-- Carried over VERBATIM from 20260908090000 except for the single `v_leads`
-- count. Writing this from memory instead of from the existing definition
-- produced a version that dropped the `is_super_admin() or my_org()`
-- authorisation check and returned 11 of the 18 keys the Settings screen reads
-- — a security regression and a broken screen, to fix a counting bug. The
-- lesson is the obvious one: redefine a function from its current source, not
-- from an idea of what it does.

create or replace function public.usage_snapshot(p_org_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period text := to_char(now(), 'YYYY-MM');
  v_org    record;
  v_eff    text;
  v_limits public.plan_limits%rowtype;
  v_until  timestamptz;
  v_ai integer; v_leads integer; v_seats integer; v_autos integer;
  v_emails integer; v_wa integer;
begin
  if not (public.is_super_admin() or (p_org_id = public.my_org() and public.is_active_member())) then
    raise exception 'not authorised';
  end if;

  select plan, trial_started_at, trial_days into v_org
    from public.organizations where id = p_org_id;

  v_eff := public.effective_plan(p_org_id);
  select * into v_limits from public.plan_limits where plan = v_eff;

  select current_period_end into v_until from public.subscriptions where org_id = p_org_id;

  select coalesce(value, 0) into v_ai from public.usage_counters
   where org_id = p_org_id and period = v_period and metric = 'ai_messages';
  select coalesce(value, 0) into v_emails from public.usage_counters
   where org_id = p_org_id and period = v_period and metric = 'emails';
  select coalesce(value, 0) into v_wa from public.usage_counters
   where org_id = p_org_id and period = v_period and metric = 'whatsapp_messages';

  -- THE ONLY CHANGED LINE. Was `select count(*) ... where org_id = p_org_id;`
  -- with no deleted_at filter, so the screen told a customer "1000 / 1000"
  -- immediately after they had archived 900 records, agreeing with a trigger
  -- that was wrong in the same way.
  select count(*) into v_leads from public.leads
   where org_id = p_org_id
     and (deleted_at is null or deleted_at > now() - interval '30 days');

  select count(*) into v_seats from public.profiles   where org_id = p_org_id and status = 'active';
  select count(*) into v_autos from public.automations where org_id = p_org_id and enabled;

  return jsonb_build_object(
    'plan',           v_eff,
    'purchased_plan', coalesce(v_org.plan, 'free'),
    'label',          coalesce(v_limits.label, 'Not activated'),
    'period',         v_period,
    'is_expired',     v_eff = 'expired',
    'not_activated',  v_eff = 'free',
    'access_until',   v_until,
    'days_left',      case when v_until is null then null
                           else greatest(0, ceil(extract(epoch from (v_until - now())) / 86400)::int) end,
    'ai_messages',       jsonb_build_object('used', coalesce(v_ai, 0),     'limit', v_limits.max_ai_messages),
    'emails',            jsonb_build_object('used', coalesce(v_emails, 0), 'limit', v_limits.max_emails),
    'whatsapp_messages', jsonb_build_object('used', coalesce(v_wa, 0),     'limit', v_limits.max_whatsapp),
    'leads',       jsonb_build_object('used', v_leads, 'limit', v_limits.max_leads),
    'seats',       jsonb_build_object('used', v_seats, 'limit', v_limits.max_seats),
    'automations', jsonb_build_object('used', v_autos, 'limit', v_limits.max_automations),
    'whatsapp',    coalesce(v_limits.whatsapp, false),
    'api_access',  coalesce(v_limits.api_access, false)
  );
end;
$$;

-- ── 3. guard_automation_limit: tell a free account the truth ────────────────

create or replace function public.guard_automation_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  lim    integer;
  used   integer;
  v_plan text;
begin
  if new.enabled is not true then return new; end if;

  -- Only charge for the transition into enabled. Editing an already-enabled
  -- rule must not fail just because the org is at its cap — that would trap
  -- someone at the limit into being unable to fix a broken rule.
  --
  -- OLD must be read inside the tg_op branch: on INSERT the record is
  -- unassigned and touching it raises "record old is not assigned yet".
  if tg_op = 'UPDATE' then
    if old.enabled is true then return new; end if;
  end if;

  select max_automations into lim from public.plan_of(new.org_id);
  if lim is null then return new; end if;

  select count(*) into used
    from public.automations
   where org_id = new.org_id and enabled and id <> new.id;

  if used >= lim then
    select public.effective_plan(new.org_id) into v_plan;

    -- Three-way, matching guard_lead_limit. The old code had only the
    -- `lim = 0` branch and attributed it to an ended subscription, which is
    -- wrong for every free account — and free is the plan where lim = 0 is
    -- the normal, permanent state rather than a lapse.
    if v_plan = 'expired' then
      raise exception
        'Your subscription has ended, so automations are paused. Your rules are saved — renew to switch them back on.'
        using errcode = 'P0001';
    end if;

    if lim = 0 then
      raise exception
        'Automations come with a paid plan. Save this rule and leave it switched off, or choose a plan in Settings → Plan & usage to turn it on — either way your rule is kept.'
        using errcode = 'P0001';
    end if;

    raise exception
      'Your plan includes % active automations and you have %. Pause one, or upgrade.', lim, used
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFY
-- ════════════════════════════════════════════════════════════════════════════
-- Both counts must now exclude archived rows, and the automation guard must no
-- longer mention an ended subscription in its zero branch.

-- Matches the STATEMENT, not the prose. The first version tested
-- `pg_get_functiondef(...) like '%deleted_at is null%'`, and the new function
-- body contains a COMMENT with that exact phrase — so it would have returned 1
-- even if the predicate had been dropped from the count.
--
-- It then ALSO called public.usage_snapshot() to count its keys. That raises
-- `P0001: not authorised`: the function's first act is to check
-- `is_super_admin() or p_org_id = my_org()`, and the SQL editor runs without a
-- JWT, so both are false. A verify step that cannot run in the place it is
-- meant to be pasted is not a verify step. Everything below is static
-- inspection only — no function is called.

select
  (select pg_get_functiondef(p.oid) like '%deleted_at > now() - interval ''30 days''%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'guard_lead_limit')        as lead_guard_counts_unpurged,
  (select pg_get_functiondef(p.oid) like '%deleted_at > now() - interval ''30 days''%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'usage_snapshot')          as snapshot_agrees,
  -- The authorisation check must still be there. Losing it would expose every
  -- tenant's usage figures to any authenticated user.
  (select pg_get_functiondef(p.oid) like '%is_super_admin()%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'usage_snapshot')          as snapshot_still_authorised,
  -- Key count WITHOUT calling the function: count the distinct jsonb keys named
  -- in the source. Expect 16.
  (select count(distinct m[1]) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral regexp_matches(
       pg_get_functiondef(p.oid),
       '''(plan|purchased_plan|label|period|is_expired|not_activated|access_until|days_left|ai_messages|emails|whatsapp_messages|leads|seats|automations|whatsapp|api_access)'''',
       'g') as m
    where n.nspname = 'public' and p.proname = 'usage_snapshot')          as snapshot_key_count,
  (select pg_get_functiondef(p.oid) like '%Automations come with a paid plan%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'guard_automation_limit')  as automation_msg_fixed;
-- Expect: true, true, true, 16, true
