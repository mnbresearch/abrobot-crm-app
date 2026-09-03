-- AbroBot CRM — make every plan limit real, and make plans actually expire.
-- NOT APPLIED. Review first.
--
-- ── What the audit found ────────────────────────────────────────────────────
--
--   seats           enforced   (guard_profile_changes + accept_invite)
--   ai_messages     enforced   (consume_usage, called by chat-agent)
--   records         DISPLAYED ONLY
--   automations     DISPLAYED ONLY
--   whatsapp        DISPLAYED ONLY   ← sold on Growth, usable on Starter
--
--   subscriptions.current_period_end   WRITTEN, NEVER READ
--   organizations.trial_started_at     WRITTEN, NEVER READ
--
-- The last two are the real problem, and they are worse than the loose limits.
-- Nothing in the system ever expires. Pay ₹2,499 once and you hold Growth
-- forever; start a 7-day trial and it never ends. That is not a pricing
-- weakness, it is the absence of a subscription — we currently sell a
-- perpetual licence at a monthly price, by accident.
--
-- ── The fix, in one idea ────────────────────────────────────────────────────
-- One function, plan_of(org), decides what an organisation is entitled to,
-- and it accounts for expiry. Every limit check reads it. Expiry therefore
-- cannot be forgotten at a call site, because no call site computes it.
--
-- Note that organizations.plan is never overwritten. An expired org keeps its
-- record of what it bought; only the *effective* entitlement changes, so a
-- renewal restores full access the moment the webhook lands, with no repair
-- job and no lost history.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 0. The expired tier
-- ════════════════════════════════════════════════════════════════════════════
-- Read-only, not locked-out. They can sign in, see everything they have, and
-- export it. What they cannot do is add more or send anything.
--
-- Holding a customer's own data hostage to force a renewal is the wrong trade
-- even setting ethics aside: it converts a lapsed customer into a chargeback,
-- a support load and a review. Removing ongoing value is enough.

insert into public.plan_limits
  (plan, label, max_seats, max_leads, max_ai_messages, max_automations, whatsapp, price_inr, position)
values
  ('expired', 'Expired', 1, 0, 0, 0, false, 0, 5)
on conflict (plan) do update set
  label = excluded.label, max_seats = excluded.max_seats, max_leads = excluded.max_leads,
  max_ai_messages = excluded.max_ai_messages, max_automations = excluded.max_automations,
  whatsapp = excluded.whatsapp, price_inr = excluded.price_inr, position = excluded.position;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Effective entitlement  (the single source of truth)
-- ════════════════════════════════════════════════════════════════════════════

-- Days after the period ends before access is reduced. Cards fail, UPI mandates
-- lapse, finance teams are slow. Cutting a paying customer off at midnight on
-- day zero over a failed card loses accounts that wanted to stay.
create or replace function public.grace_days() returns integer
language sql immutable as $$ select 3 $$;

create or replace function public.effective_plan(p_org_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  o record;
  period_end timestamptz;
begin
  select id, plan, trial_started_at, trial_days
    into o
    from public.organizations
   where id = p_org_id;

  if not found then return 'expired'; end if;

  -- Enterprise is invoiced and managed by hand; it is never auto-expired.
  if o.plan = 'enterprise' then return o.plan; end if;

  if o.plan = 'trial' then
    if o.trial_started_at is null then return 'trial'; end if;
    if now() > o.trial_started_at
              + make_interval(days => coalesce(o.trial_days, 7) + public.grace_days())
    then
      return 'expired';
    end if;
    return 'trial';
  end if;

  -- Paid plan: it is only live while the paid-for period is.
  select s.current_period_end into period_end
    from public.subscriptions s where s.org_id = p_org_id;

  -- A paid plan with no subscription row is an org an admin set by hand.
  -- Leave it alone rather than expiring something we have no record of selling.
  if period_end is null then return o.plan; end if;

  if now() > period_end + make_interval(days => public.grace_days()) then
    return 'expired';
  end if;

  return o.plan;
end;
$$;

comment on function public.effective_plan(uuid) is
  'What this organisation is entitled to RIGHT NOW, accounting for trial and subscription expiry. organizations.plan records what was bought; this decides what currently applies.';

-- Fails CLOSED. organizations.plan has no foreign key to plan_limits, so a
-- typo or a legacy value would otherwise return a NULL composite — and every
-- numeric guard reads NULL as "unlimited". One bad string would have granted
-- an org infinite everything. If the plan is unrecognised, fall back to trial.
create or replace function public.plan_of(p_org_id uuid)
returns public.plan_limits
language sql
stable
security definer
set search_path = public
as $$
  select pl.* from public.plan_limits pl
   where pl.plan = coalesce(
     (select p.plan from public.plan_limits p where p.plan = public.effective_plan(p_org_id)),
     'trial'
   );
$$;

grant execute on function public.effective_plan(uuid) to authenticated;
grant execute on function public.plan_of(uuid)        to authenticated;

-- What the UI reads, so the banner and the enforcement can never disagree:
-- they are computed from the same row.
-- security_barrier: the view is owned by postgres and so bypasses RLS on the
-- tables underneath, relying entirely on its own WHERE clause. Without the
-- barrier the planner may push a user-supplied predicate below that filter and
-- evaluate it against rows the caller should never see. Cheap insurance.
create or replace view public.my_entitlements with (security_barrier = true) as
  select
    o.id                as org_id,
    o.plan              as purchased_plan,
    public.effective_plan(o.id) as effective_plan,
    (public.effective_plan(o.id) = 'expired') as is_expired,
    pl.label, pl.max_seats, pl.max_leads, pl.max_ai_messages,
    pl.max_automations, pl.whatsapp,
    s.current_period_end,
    case when o.plan = 'trial'
      then o.trial_started_at + make_interval(days => coalesce(o.trial_days, 7))
      else s.current_period_end
    end as access_until
  from public.organizations o
  left join public.subscriptions s on s.org_id = o.id
  cross join lateral public.plan_of(o.id) pl
  where o.id = public.my_org() or public.is_super_admin();

grant select on public.my_entitlements to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. RECORDS  (deliberately asymmetric)
-- ════════════════════════════════════════════════════════════════════════════
-- What should happen when a customer hits the record limit?
--
-- The obvious answer — reject the record — is wrong for inbound. An inbound
-- record is a real person who just messaged our customer. Dropping it means
-- our customer loses business and blames the CRM. That loses the account; it
-- does not upsell it.
--
--   INBOUND    (widget, webhook)      accepted over the limit, always.
--   DELIBERATE (manual add, import)   blocked, with a message they can act on.
--
-- Upgrade pressure comes from the blocked bulk paths and a visible meter, not
-- from silently binning enquiries.

create or replace function public.guard_lead_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  lim  integer;
  used integer;
  inbound boolean;
begin
  -- Cast to text before comparing. leads.source is the lead_source ENUM, so an
  -- unknown literal here is not a false comparison — it is a hard
  -- "invalid input value for enum" that plpgsql only raises on the first
  -- insert, long after the migration appeared to succeed. That failure would
  -- have blocked exactly the inbound capture this branch exists to protect.
  -- Valid labels: whatsapp, chatbase, email, website, csv_import, pdf_import,
  --               manual, referral, other
  inbound := new.source::text in
             ('website', 'whatsapp', 'chatbase', 'email', 'referral');

  select max_leads into lim from public.plan_of(new.org_id);
  if lim is null then return new; end if;                 -- unlimited

  -- Expired orgs are the one case where even inbound stops: there is no live
  -- subscription, so we are not obliged to keep ingesting on their behalf.
  if inbound and lim > 0 then return new; end if;

  -- Count-then-insert is not atomic: two concurrent inserts can both read
  -- used = lim - 1 and both proceed. Deliberately not locked. Taking a lock on
  -- every insert to prevent an occasional off-by-one overage would slow the
  -- hot intake path to protect revenue measured in fractions of a rupee.
  -- consume_usage is atomic because AI messages have real per-call cost;
  -- records do not.
  select count(*) into used from public.leads where org_id = new.org_id;
  if used < lim then return new; end if;

  if lim = 0 then
    raise exception
      'Your subscription has ended, so new records are paused. Your existing data is safe and still exportable — renew to continue.'
      using errcode = 'P0001';
  end if;

  raise exception
    'Your plan includes % records and you have %. Upgrade to add more, or archive some first.', lim, used
    using errcode = 'P0001';
end;
$$;

drop trigger if exists trg_guard_lead_limit on public.leads;
create trigger trg_guard_lead_limit
  before insert on public.leads
  for each row execute function public.guard_lead_limit();

-- ════════════════════════════════════════════════════════════════════════════
-- 3. AUTOMATIONS
-- ════════════════════════════════════════════════════════════════════════════
-- Counts ENABLED rules only. A paused rule costs nothing to run, so there is
-- no reason to stop someone drafting one — and it gives a customer at the
-- limit something to do other than churn.

create or replace function public.guard_automation_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  lim  integer;
  used integer;
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
    if lim = 0 then
      raise exception
        'Your subscription has ended, so automations are paused. Renew to switch them back on.'
        using errcode = 'P0001';
    end if;
    raise exception
      'Your plan includes % active automations and you have %. Pause one, or upgrade.', lim, used
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_automation_limit on public.automations;
create trigger trg_guard_automation_limit
  before insert or update on public.automations
  for each row execute function public.guard_automation_limit();

-- ════════════════════════════════════════════════════════════════════════════
-- 4. WHATSAPP  (the paid differentiator)
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.plan_allows_whatsapp(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select whatsapp from public.plan_of(p_org_id)), false);
$$;

grant execute on function public.plan_allows_whatsapp(uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. AI messages — stop trusting the caller's idea of the limit
-- ════════════════════════════════════════════════════════════════════════════
-- consume_usage(org, metric, LIMIT, amount) took the limit as an argument, so
-- every edge function had to remember to look it up and pass the right one.
-- Only chat-agent did. The overload below takes no limit and reads it from
-- plan_of, which also makes it expiry-aware for free.
--
-- The old 4-arg signature stays so nothing breaks between applying this
-- migration and deploying the function, but it now IGNORES the limit it is
-- passed and delegates here. That matters: with both signatures live,
-- whichever one PostgREST resolves to gives the same, expiry-aware answer.

-- The existing 4-arg function is dropped rather than replaced. Its p_amount
-- has `default 1`, and CREATE OR REPLACE cannot remove a parameter default
-- (42P13) — Postgres requires DROP first. It is recreated below, unchanged in
-- signature apart from that default, so callers passing all four arguments
-- (which is every current caller) are unaffected.
--
-- Safe inside this transaction: the drop and the recreate commit together, so
-- there is no window where the function is missing.
drop function if exists public.consume_usage(uuid, text, integer, integer);

create or replace function public.consume_usage(
  p_org_id uuid, p_metric text, p_amount integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period text := to_char(now(), 'YYYY-MM');
  v_limit  integer;
  v_new    integer;
begin
  select case p_metric
           when 'ai_messages' then max_ai_messages
           else null
         end
    into v_limit
    from public.plan_of(p_org_id);

  insert into public.usage_counters (org_id, period, metric, value)
  values (p_org_id, v_period, p_metric, p_amount)
  on conflict (org_id, period, metric)
  do update set value = public.usage_counters.value + p_amount
  returning value into v_new;

  if v_limit is not null and v_new > v_limit then
    return jsonb_build_object('allowed', false, 'used', v_new, 'limit', v_limit);
  end if;
  return jsonb_build_object('allowed', true, 'used', v_new, 'limit', v_limit);
end;
$$;

-- Backward-compatible shim. p_limit is accepted and discarded: the caller's
-- idea of the limit is exactly the thing that was wrong.
--
-- p_amount deliberately has NO default. If it did, a 3-argument positional
-- call would match both signatures — this one with p_amount defaulted, and the
-- one above exactly — and Postgres cannot rank those, so it raises
-- "function is not unique" (42725). Worse, that call IS this function's body,
-- so with check_function_bodies on (the Supabase default) the CREATE below
-- would fail and roll back the entire migration.
create or replace function public.consume_usage(
  p_org_id uuid, p_metric text, p_limit integer, p_amount integer
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.consume_usage(p_org_id, p_metric, p_amount);
$$;

-- ── Who may call the privileged functions ───────────────────────────────────
-- These are SECURITY DEFINER and take an org_id, so left PUBLIC any anonymous
-- caller could POST /rpc/consume_usage with someone else's org_id and burn
-- their monthly AI allowance to zero. That is a denial-of-service against a
-- paying customer, executable by a stranger with a browser. The edge functions
-- use the service role, which is not affected by these grants.
revoke all on function public.consume_usage(uuid, text, integer)          from public, anon, authenticated;
revoke all on function public.consume_usage(uuid, text, integer, integer) from public, anon, authenticated;
-- mark_lapsed_subscriptions is revoked at its definition in section 6; REVOKE
-- errors on a function that does not exist yet, so it cannot be done here.

-- ════════════════════════════════════════════════════════════════════════════
-- 5b. usage_snapshot — same bug, same fix
-- ════════════════════════════════════════════════════════════════════════════
-- It read organizations.plan, so a lapsed org's Settings page would cheerfully
-- report "5,000 AI messages" while the server refused at 0. It now reads
-- plan_of, and also returns when access ends so the UI can warn ahead of time
-- instead of surprising someone.

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
begin
  if not (public.is_super_admin() or (p_org_id = public.my_org() and public.is_active_member())) then
    raise exception 'not authorised';
  end if;

  select plan, trial_started_at, trial_days into v_org
    from public.organizations where id = p_org_id;

  v_eff := public.effective_plan(p_org_id);
  select * into v_limits from public.plan_limits where plan = v_eff;

  if v_org.plan = 'trial' then
    v_until := v_org.trial_started_at + make_interval(days => coalesce(v_org.trial_days, 7));
  else
    select current_period_end into v_until from public.subscriptions where org_id = p_org_id;
  end if;

  select coalesce(value, 0) into v_ai from public.usage_counters
   where org_id = p_org_id and period = v_period and metric = 'ai_messages';
  select count(*) into v_leads from public.leads      where org_id = p_org_id;
  select count(*) into v_seats from public.profiles   where org_id = p_org_id and status = 'active';
  select count(*) into v_autos from public.automations where org_id = p_org_id and enabled;

  return jsonb_build_object(
    'plan',           v_eff,
    'purchased_plan', coalesce(v_org.plan, 'trial'),
    'label',          coalesce(v_limits.label, 'Free trial'),
    'period',         v_period,
    'is_expired',     v_eff = 'expired',
    'access_until',   v_until,
    'days_left',      case when v_until is null then null
                           else greatest(0, ceil(extract(epoch from (v_until - now())) / 86400)::int) end,
    'ai_messages', jsonb_build_object('used', coalesce(v_ai, 0), 'limit', v_limits.max_ai_messages),
    'leads',       jsonb_build_object('used', v_leads,           'limit', v_limits.max_leads),
    'seats',       jsonb_build_object('used', v_seats,           'limit', v_limits.max_seats),
    'automations', jsonb_build_object('used', v_autos,           'limit', v_limits.max_automations),
    'whatsapp',    coalesce(v_limits.whatsapp, false)
  );
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 5c. Seats — the one limit that was already enforced, but not expiry-aware
-- ════════════════════════════════════════════════════════════════════════════
-- guard_profile_changes and accept_invite both do
--     join plan_limits pl on pl.plan = o.plan
-- which reads the PURCHASED plan. So a lapsed Growth org kept all ten seats
-- and could still add people, which would have made the max_seats = 1 on the
-- expired row above dead code.
--
-- One helper both call, so there is a single definition of "seats available"
-- and it goes through plan_of like every other limit.
--
-- Named plan_seat_cap, not seat_cap: guard_profile_changes already declares a
-- local variable called seat_cap, and a plpgsql variable shadowing a function
-- name is a confusing thing to leave lying around even when it resolves.

create or replace function public.plan_seat_cap(p_org_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$ select max_seats from public.plan_of(p_org_id); $$;

grant execute on function public.plan_seat_cap(uuid) to authenticated;

-- Redefined verbatim from 20260819140000 except for the seat lookup below.
-- That migration is already applied, so the change has to live here.
create or replace function public.guard_profile_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id   uuid := auth.uid();
  caller_role public.user_role;
  seat_cap    integer;
  active_now  integer;
begin
  -- No JWT means the service role (edge functions, migrations, admin tooling).
  if caller_id is null then
    return new;
  end if;

  select role into caller_role from public.profiles where id = caller_id;

  -- The tenant escape. Only a super admin may move an account between orgs.
  if new.org_id is distinct from old.org_id
     and coalesce(caller_role, 'counsellor'::public.user_role) <> 'super_admin' then
    raise exception 'Only a super admin can move a member to another organisation'
      using errcode = '42501';
  end if;

  if new.role is distinct from old.role then
    if caller_role = 'super_admin' then
      null;
    elsif caller_role = 'org_admin' then
      if new.role = 'super_admin' then
        raise exception 'Only a super admin can grant super admin'
          using errcode = '42501';
      end if;
      if new.id = caller_id then
        raise exception 'You cannot change your own role. Ask a super admin.'
          using errcode = '42501';
      end if;
    else
      raise exception 'Only an admin can change roles'
        using errcode = '42501';
    end if;
  end if;

  if new.status is distinct from old.status then
    if coalesce(caller_role, 'counsellor'::public.user_role)
       not in ('org_admin'::public.user_role, 'super_admin'::public.user_role) then
      raise exception 'Only an admin can change access'
        using errcode = '42501';
    end if;
  end if;

  if new.status = 'active'::public.member_status
     and old.status is distinct from 'active'::public.member_status then

    -- CHANGED: was `join plan_limits pl on pl.plan = o.plan`, which read the
    -- purchased plan and so ignored expiry.
    seat_cap := public.plan_seat_cap(new.org_id);

    if seat_cap is not null then
      select count(*) into active_now
        from public.profiles
       where org_id = new.org_id
         and status = 'active'::public.member_status
         and id <> new.id;

      if active_now + 1 > seat_cap then
        if seat_cap = 0 then
          raise exception
            'Your subscription has ended, so new members cannot be activated. Renew to add people again.'
            using errcode = 'P0001';
        end if;
        raise exception
          'Seat limit reached: this plan allows % active member(s). Upgrade to add more.',
          seat_cap using errcode = 'P0001';
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Mark lapsed subscriptions past_due (reporting only)
-- ════════════════════════════════════════════════════════════════════════════
-- Entitlement is already correct without this — effective_plan computes expiry
-- live, so there is no window where a lapsed org keeps access because a job
-- failed to run. This exists purely so churn is visible in a query.

create or replace function public.mark_lapsed_subscriptions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.subscriptions s
     set status = 'past_due', updated_at = now()
   where s.status = 'active'
     and s.current_period_end is not null
     and now() > s.current_period_end + make_interval(days => public.grace_days());
  get diagnostics n = row_count;
  return n;
end;
$$;

-- SECURITY DEFINER and it writes to subscriptions, so it must not be reachable
-- from the browser or from an anonymous request. Only the cron job (which runs
-- as the table owner) and the service role need it.
revoke all on function public.mark_lapsed_subscriptions() from public, anon, authenticated;

-- Matches the pattern in 20260819160000. `exception when others then null`
-- would also swallow permission errors and timeouts, which is how a scheduled
-- job quietly stops existing.
select cron.unschedule('mark-lapsed-subscriptions')
 where exists (select 1 from cron.job where jobname = 'mark-lapsed-subscriptions');

select cron.schedule(
  'mark-lapsed-subscriptions',
  '30 2 * * *',
  $$ select public.mark_lapsed_subscriptions(); $$
);

commit;


-- ── Verify ──────────────────────────────────────────────────────────────────
-- Who is live, who has lapsed:
--   select o.name, o.plan as purchased, effective_plan(o.id) as effective,
--          s.current_period_end
--     from organizations o left join subscriptions s on s.org_id = o.id
--    order by 3, 1;
--
-- Expiry works (rolls back, safe to run):
--   begin;
--     update subscriptions set current_period_end = now() - interval '30 days'
--      where org_id = '<org>';
--     select effective_plan('<org>');            -- expect: expired
--     select plan_allows_whatsapp('<org>');      -- expect: false
--   rollback;
--
-- Inbound is never blocked on a live plan, deliberate creation is:
--   insert into leads (org_id, name, source, stage_key)
--     values ('<org>','Inbound','website','new');   -- succeeds even at the cap
--   insert into leads (org_id, name, source, stage_key)
--     values ('<org>','Manual','manual','new');     -- fails at the cap
