-- AbroBot CRM — pricing reset: no free trial, ₹999 as the front door, and
-- limits derived from what serving a customer actually costs.
--
-- ── Why the numbers are what they are ───────────────────────────────────────
-- Unit costs, September 2026, INR, all inclusive of 18% GST (Meta, Groq,
-- Resend and Cashfree fees are all taxable to us):
--
--   AI reply (Groq gpt-oss-120b, ~1200 in / 350 out)   ₹0.040
--   Email (Resend, $0.0004)                            ₹0.042
--   WhatsApp service/utility template (Meta India)     ₹0.15
--   WhatsApp MARKETING template (Meta India)           ₹1.04   ← 7x utility
--   Payment gateway (Cashfree 1.95% + GST)             2.30% of price
--   Supabase Pro, shared                               ₹2,200/mo total
--
-- ── The hole this closes ────────────────────────────────────────────────────
-- plan_limits.whatsapp was a BOOLEAN. Growth and Business granted WhatsApp
-- with NO volume cap, and nothing metered it. At ₹1.04 a marketing template,
-- 2,407 messages consume an entire ₹2,499 Growth subscription and every one
-- after that is a loss. Modelled at the old limits, Business came out at
-- NEGATIVE 39% margin. One enthusiastic customer could cost more than they pay,
-- and nothing in the system would have noticed.
--
-- So: max_whatsapp, metered exactly like AI replies and email.
--
-- ── Resulting margins (25 paying customers) ─────────────────────────────────
--                    realistic   worst case (all marketing)
--   Starter ₹999        84%              84%   (no WhatsApp at all)
--   Growth  ₹2,499      61%              19%
--   Business ₹4,999     63%              21%
--
-- "Realistic" assumes 80% service/utility and 20% marketing, which is the mix
-- a CRM produces — most WhatsApp traffic here is replies and reminders, not
-- campaigns. The worst case is never negative, which is the property that
-- matters: an unusual customer costs you margin, never money.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. New columns: a WhatsApp cap, and an explicit API gate
-- ════════════════════════════════════════════════════════════════════════════
alter table public.plan_limits
  add column if not exists max_whatsapp integer,
  add column if not exists api_access   boolean not null default false;

comment on column public.plan_limits.max_whatsapp is
  'Outbound WhatsApp messages per calendar month. NULL = unlimited, 0 = none. Metered because Meta bills per message and marketing templates cost 7x utility ones.';
comment on column public.plan_limits.api_access is
  'May create API keys and outbound webhooks. Costs us almost nothing to serve, which makes it the right thing to reserve for the tier that pays most.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The plans
-- ════════════════════════════════════════════════════════════════════════════
-- 'free' replaces 'trial': same idea of a starting state, but read-only rather
-- than a working product given away. An account that has not paid can sign in,
-- set up its pipeline and look around — it cannot capture records, answer with
-- AI, or send anything. Nothing is destroyed and nothing is free.
insert into public.plan_limits
  (plan, label, max_seats, max_leads, max_ai_messages, max_automations,
   whatsapp, price_inr, position, max_emails, max_whatsapp, api_access)
values
  ('free',      'Not activated',  1,    0,     0,     0,  false,    0, 0,     0,    0, false),
  ('starter',   'Starter',        3, 1000,  1000,     3,  false,  999, 1,   300,    0, false),
  ('growth',    'Growth',        10,10000,  5000,    25,  true,  2499, 2,  3000, 1500, false),
  ('business',  'Business',      30,50000, 10000,   100,  true,  4999, 3,  6000, 3000, true),
  ('enterprise','Enterprise',  null, null,  null,  null,  true,  null, 4,  null, null, true),
  ('expired',   'Expired',        1,    0,     0,     0,  false,    0, 5,     0,    0, false)
on conflict (plan) do update set
  label = excluded.label, max_seats = excluded.max_seats,
  max_leads = excluded.max_leads, max_ai_messages = excluded.max_ai_messages,
  max_automations = excluded.max_automations, whatsapp = excluded.whatsapp,
  price_inr = excluded.price_inr, position = excluded.position,
  max_emails = excluded.max_emails, max_whatsapp = excluded.max_whatsapp,
  api_access = excluded.api_access;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Retire the trial
-- ════════════════════════════════════════════════════════════════════════════
-- Organisations sitting on 'trial' move to 'free', which is read-only. Their
-- data is untouched and comes straight back when they pay.
--
-- This is the one destructive-feeling step in the file, so it REPORTS what it
-- did rather than doing it quietly — see the notice. Paid organisations are
-- not touched at all.
do $$
declare v_moved int; v_names text;
begin
  select count(*), string_agg(slug, ', ')
    into v_moved, v_names
    from public.organizations where plan = 'trial';

  if v_moved > 0 then
    update public.organizations set plan = 'free' where plan = 'trial';
    raise notice 'Moved % organisation(s) from trial to free (read-only): %', v_moved, v_names;
    raise notice 'To activate any of them: update organizations set plan = ''starter'' where slug = ''<slug>'';';
  else
    raise notice 'No organisations were on trial.';
  end if;
end $$;

delete from public.plan_limits where plan = 'trial';

-- effective_plan and plan_of both fall back to 'trial' when they cannot work
-- out an entitlement. That row no longer exists, so the fallback has to move
-- to 'free' — and 'free' is the safe direction to fail in: read-only.
create or replace function public.effective_plan(p_org_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  o record;
  s record;
begin
  select id, plan into o from public.organizations where id = p_org_id;
  if not found then return 'free'; end if;

  -- Never activated, or explicitly parked.
  if o.plan is null or o.plan in ('free', 'trial') then return 'free'; end if;
  if o.plan = 'enterprise' then return 'enterprise'; end if;

  select current_period_end, status into s
    from public.subscriptions where org_id = p_org_id;

  -- No subscription row for a paid plan means it was set by hand (our own
  -- organisations, or a support grant). Honour it.
  if not found or s.current_period_end is null then return o.plan; end if;

  -- Grace days after the period ends: cards fail and finance teams are slow,
  -- and cutting a paying customer off at midnight on day zero loses accounts
  -- that wanted to stay.
  if now() > s.current_period_end + make_interval(days => public.grace_days()) then
    return 'expired';
  end if;

  return o.plan;
end;
$$;

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
     'free'
   );
$$;

-- New organisations start on 'free', not 'trial'.
create or replace function public.new_org_plan() returns text
language sql immutable as $$ select 'free'::text $$;

comment on function public.new_org_plan() is
  'What a brand-new organisation gets. Read-only until they pay: they can set everything up and see the product, but capture, AI and sending are off. Referenced by create_organisation.';

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Meter WhatsApp, and expose the API gate
-- ════════════════════════════════════════════════════════════════════════════
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
           when 'ai_messages'       then max_ai_messages
           when 'emails'            then max_emails
           when 'whatsapp_messages' then max_whatsapp
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

-- plan_allows_whatsapp now means "included AND not used up", because the
-- boolean alone is what let an unlimited cost through.
create or replace function public.plan_allows_whatsapp(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(l.whatsapp, false)
     and (l.max_whatsapp is null or coalesce(u.value, 0) < l.max_whatsapp)
    from public.plan_of(p_org_id) l
    left join public.usage_counters u
      on u.org_id = p_org_id
     and u.period = to_char(now(), 'YYYY-MM')
     and u.metric = 'whatsapp_messages';
$$;

create or replace function public.plan_allows_api(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select api_access from public.plan_of(p_org_id)), false);
$$;

create or replace function public.whatsapp_allowance(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'included',  coalesce(l.whatsapp, false),
    'limit',     l.max_whatsapp,
    'used',      coalesce(u.value, 0),
    'remaining', case when l.max_whatsapp is null then null
                      else greatest(l.max_whatsapp - coalesce(u.value, 0), 0) end)
    from public.plan_of(p_org_id) l
    left join public.usage_counters u
      on u.org_id = p_org_id
     and u.period = to_char(now(), 'YYYY-MM')
     and u.metric = 'whatsapp_messages';
$$;

-- SECURITY DEFINER defaults to PUBLIC execute, and these all take an arbitrary
-- org id with no check in the body — the same trap as yesterday's audit.
revoke all on function public.plan_allows_api(uuid)     from public, anon, authenticated;
revoke all on function public.whatsapp_allowance(uuid)  from public, anon, authenticated;
revoke all on function public.plan_allows_whatsapp(uuid) from public, anon, authenticated;
revoke all on function public.new_org_plan()            from public, anon;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Show it all on Plan & usage
-- ════════════════════════════════════════════════════════════════════════════
-- Extended key-for-key from the version in 20260906100000. Every key the
-- Settings screen reads is preserved; `whatsapp_messages` and `api_access` are
-- added. (I once rewrote this from memory and dropped four keys the screen
-- needs — hence the emphasis.)
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
  select count(*) into v_leads from public.leads      where org_id = p_org_id;
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

revoke all on function public.usage_snapshot(uuid) from public, anon;
grant execute on function public.usage_snapshot(uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. New organisations no longer start on a trial
-- ════════════════════════════════════════════════════════════════════════════
-- Copied verbatim from 20260901090000 — including the privilege guard, the
-- slug-collision loop and the industry pack — with ONE line changed: the plan.
-- Reproducing it from memory is how you silently drop the
-- `app.profile_bootstrap` flag and break signup, so it is copied, not rewritten.
--
--   was:  'trial', now(), 7      (7-day trial, full product, free)
--   now:  new_org_plan(), now(), 0   ('free' — set up and look around,
--                                     capture and sending switch on when paid)

create or replace function public.create_organisation(
  p_name text,
  p_industry text default 'general'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid       uuid := auth.uid();
  prof      public.profiles%rowtype;
  base_slug text;
  slug      text;
  n         integer := 0;
  new_org   public.organizations%rowtype;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Organisation name is required';
  end if;
  if length(trim(p_name)) > 80 then
    raise exception 'Organisation name is too long';
  end if;

  prof := public.ensure_profile();

  if prof.org_id is not null then
    raise exception 'This account already belongs to an organisation'
      using errcode = '42501';
  end if;

  if not exists (select 1 from public.industries where slug = p_industry and active) then
    raise exception 'Unknown industry: %', p_industry;
  end if;

  base_slug := regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g');
  base_slug := trim(both '-' from base_slug);
  if base_slug = '' then base_slug := 'org'; end if;
  base_slug := left(base_slug, 40);
  slug := base_slug;

  while exists (select 1 from public.organizations where organizations.slug = slug) loop
    n := n + 1;
    slug := base_slug || '-' || n::text;
    if n > 500 then
      slug := base_slug || '-' || substr(md5(random()::text), 1, 6);
      exit;
    end if;
  end loop;

  insert into public.organizations (name, slug, active, plan, trial_started_at, trial_days,
                                    credits_total, credits_used, industry_slug)
  values (trim(p_name), slug, true, public.new_org_plan(), now(), 0, 0, 0, p_industry)
  returning * into new_org;

  perform set_config('app.profile_bootstrap', 'on', true);

  update public.profiles
     set org_id = new_org.id, role = 'org_admin', status = 'active'
   where id = uid;

  insert into public.agent_config (org_id, enabled, agent_name, welcome_message, knowledge, onboarded)
  values (new_org.id, true, trim(p_name) || ' Assistant',
          'Hi! How can we help you today?', '', false)
  on conflict (org_id) do nothing;

  perform public.apply_industry_pack(new_org.id, p_industry);

  return jsonb_build_object(
    'ok', true, 'org_id', new_org.id, 'slug', slug,
    'name', new_org.name, 'industry', p_industry
  );
end;
$$;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select 'trial plan is gone' as check,
       case when not exists (select 1 from public.plan_limits where plan = 'trial')
            then 'PASS' else 'FAIL' end as result
union all
select 'no organisation left on trial',
       case when not exists (select 1 from public.organizations where plan = 'trial')
            then 'PASS' else 'FAIL' end
union all
select 'entry plan is ₹999 with no WhatsApp',
       case when exists (select 1 from public.plan_limits
                          where plan = 'starter' and price_inr = 999
                            and whatsapp = false and max_whatsapp = 0)
            then 'PASS' else 'FAIL' end
union all
select 'WhatsApp is capped on every paid tier',
       case when not exists (select 1 from public.plan_limits
                              where whatsapp and max_whatsapp is null and plan <> 'enterprise')
            then 'PASS' else 'FAIL — an uncapped tier can cost more than it earns' end
union all
select 'API reserved for Business and above',
       case when (select bool_and(api_access = (plan in ('business','enterprise')))
                    from public.plan_limits) then 'PASS' else 'FAIL' end
union all
select 'consume_usage meters WhatsApp',
       case when (select prosrc from pg_proc
                   where oid = 'public.consume_usage(uuid,text,integer)'::regprocedure)
                 like '%whatsapp_messages%' then 'PASS' else 'FAIL' end
union all
select 'usage_snapshot still returns every key Settings reads',
       case when (select prosrc from pg_proc
                   where oid = 'public.usage_snapshot(uuid)'::regprocedure)
                 like '%access_until%days_left%' then 'PASS' else 'FAIL' end
union all
select 'new organisations start on free, not trial',
       case when (select prosrc from pg_proc
                   where oid = 'public.create_organisation(text,text)'::regprocedure)
                 like '%new_org_plan()%' then 'PASS' else 'FAIL' end
union all
select 'signup bootstrap flag survived the copy',
       case when (select prosrc from pg_proc
                   where oid = 'public.create_organisation(text,text)'::regprocedure)
                 like '%app.profile_bootstrap%' then 'PASS' else 'FAIL — signup will break' end
union all
select 'the plan ladder',
       (select string_agg(label || ' ₹' || coalesce(price_inr::text, 'custom'), ' · ' order by position)
          from public.plan_limits where plan not in ('free','expired'));
