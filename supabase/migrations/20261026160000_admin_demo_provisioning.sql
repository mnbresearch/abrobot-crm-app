-- ════════════════════════════════════════════════════════════════════════════
-- 20261026160000_admin_demo_provisioning.sql
--
-- Platform Super Admin 7-Day Demo Account Provisioning Engine
--
-- 1. Updates effective_plan(uuid):
--    Demo accounts (organizations.custom->>'is_demo' = 'true') strictly
--    expire at exactly current_period_end with ZERO grace days.
--
-- 2. Updates plan_of(uuid):
--    Enforces custom feature quotas (leads, seats, automations, AI messages,
--    emails, WhatsApp, API access) defined in organizations.custom->'features'.
--
-- 3. Updates usage_snapshot(uuid):
--    Returns demo metadata, remaining days, and overrides default plan limits
--    with custom demo feature quotas.
--
-- 4. Recreates admin_list_orgs():
--    Includes `is_demo` boolean so Super Admin can distinguish demo workspaces.
--
-- 5. Implements admin_provision_demo_org():
--    Transactional Super-Admin RPC to provision customizable 7-day demo accounts
--    with automated industry pack seeding, security agent guardrails,
--    admin invite, and 6 realistic industry demo leads with activities.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. effective_plan: Strict 7-day expiry (0 grace days) for demo accounts ──

create or replace function public.effective_plan(p_org_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  o record;
  s record;
  v_is_demo boolean;
begin
  select id, plan, custom into o from public.organizations where id = p_org_id;
  if not found then return 'free'; end if;

  v_is_demo := coalesce((o.custom->>'is_demo')::boolean, false);

  select current_period_end, status into s
    from public.subscriptions where org_id = p_org_id;

  -- Refunded or charged back: the money is gone, so the plan goes with it.
  if found and coalesce(s.status, 'active') in ('cancelled', 'refunded', 'chargeback') then
    return 'expired';
  end if;

  -- ── DEMO ACCOUNTS: STRICT EXPIRY, 0 GRACE DAYS ──
  -- Compulsory upgrade is enforced immediately upon trial period expiry.
  if v_is_demo then
    if not found or s.current_period_end is null or now() > s.current_period_end then
      return 'expired';
    end if;
    return coalesce(o.plan, 'growth');
  end if;

  -- Standard plans
  if o.plan is null or o.plan in ('free', 'trial') then return 'free'; end if;
  if o.plan = 'enterprise' then return 'enterprise'; end if;

  -- No subscription row for a paid plan means hand-provisioned platform org.
  if not found or s.current_period_end is null then return o.plan; end if;

  -- Standard accounts get grace_days() for card retry / bank processing.
  if now() > s.current_period_end + make_interval(days => public.grace_days()) then
    return 'expired';
  end if;

  return o.plan;
end;
$$;

revoke all on function public.effective_plan(uuid) from public, anon;
grant execute on function public.effective_plan(uuid) to authenticated;

-- ── 2. plan_of: Custom feature limit enforcement ────────────────────────────

create or replace function public.plan_of(p_org_id uuid)
returns public.plan_limits
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_res public.plan_limits%rowtype;
  v_eff text;
  v_org record;
begin
  v_eff := public.effective_plan(p_org_id);
  select * into v_res from public.plan_limits where plan = coalesce(v_eff, 'free');
  if not found then
    select * into v_res from public.plan_limits where plan = 'free';
  end if;

  -- Check if organization defines custom demo feature overrides
  select custom into v_org from public.organizations where id = p_org_id;
  if found and v_org.custom ? 'features' then
    if v_org.custom->'features'->>'leads_limit' is not null then
      v_res.max_leads := (v_org.custom->'features'->>'leads_limit')::integer;
    end if;
    if v_org.custom->'features'->>'seats_limit' is not null then
      v_res.max_seats := (v_org.custom->'features'->>'seats_limit')::integer;
    end if;
    if v_org.custom->'features'->>'automations_limit' is not null then
      v_res.max_automations := (v_org.custom->'features'->>'automations_limit')::integer;
    end if;
    if v_org.custom->'features'->>'ai_messages_limit' is not null then
      v_res.max_ai_messages := (v_org.custom->'features'->>'ai_messages_limit')::integer;
    end if;
    if v_org.custom->'features'->>'emails_limit' is not null then
      v_res.max_emails := (v_org.custom->'features'->>'emails_limit')::integer;
    end if;
    if v_org.custom->'features'->>'whatsapp_limit' is not null then
      v_res.max_whatsapp := (v_org.custom->'features'->>'whatsapp_limit')::integer;
    end if;
    if v_org.custom->'features' ? 'whatsapp_enabled' then
      v_res.whatsapp := (v_org.custom->'features'->>'whatsapp_enabled')::boolean;
    end if;
    if v_org.custom->'features' ? 'api_access' then
      v_res.api_access := (v_org.custom->'features'->>'api_access')::boolean;
    end if;
  end if;

  return v_res;
end;
$$;

grant execute on function public.plan_of(uuid) to authenticated;

-- ── 3. usage_snapshot: Surface demo status & custom limits to client ────────

create or replace function public.usage_snapshot(p_org_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period  text := to_char(now(), 'YYYY-MM');
  v_org     record;
  v_eff     text;
  v_limits  public.plan_limits%rowtype;
  v_until   timestamptz;
  v_ai      integer;
  v_leads   integer;
  v_seats   integer;
  v_autos   integer;
  v_emails  integer;
  v_wa      integer;
  v_is_demo boolean;
begin
  if not (public.is_super_admin() or (p_org_id = public.my_org() and public.is_active_member())) then
    raise exception 'not authorised';
  end if;

  select plan, trial_started_at, trial_days, custom into v_org
    from public.organizations where id = p_org_id;

  v_eff := public.effective_plan(p_org_id);
  v_limits := public.plan_of(p_org_id);
  v_is_demo := coalesce((v_org.custom->>'is_demo')::boolean, false);

  select current_period_end into v_until from public.subscriptions where org_id = p_org_id;

  select coalesce(value, 0) into v_ai from public.usage_counters
   where org_id = p_org_id and period = v_period and metric = 'ai_messages';
  select coalesce(value, 0) into v_emails from public.usage_counters
   where org_id = p_org_id and period = v_period and metric = 'emails';
  select coalesce(value, 0) into v_wa from public.usage_counters
   where org_id = p_org_id and period = v_period and metric = 'whatsapp_messages';

  select count(*) into v_leads from public.leads
   where org_id = p_org_id
     and (deleted_at is null or deleted_at > now() - interval '30 days');

  select count(*) into v_seats from public.profiles   where org_id = p_org_id and status = 'active';
  select count(*) into v_autos from public.automations where org_id = p_org_id and enabled;

  return jsonb_build_object(
    'plan',              v_eff,
    'purchased_plan',    coalesce(v_org.plan, 'free'),
    'label',             case when v_is_demo then '7-Day Demo Evaluation'
                              else coalesce(v_limits.label, 'Not activated') end,
    'period',            v_period,
    'is_expired',        v_eff = 'expired',
    'not_activated',     v_eff = 'free',
    'is_demo',           v_is_demo,
    'must_upgrade',      coalesce((v_org.custom->>'must_upgrade')::boolean, v_is_demo),
    'demo_expires_at',   v_org.custom->>'demo_expires_at',
    'trial_duration_days', coalesce((v_org.custom->>'trial_duration_days')::int, 7),
    'features',          coalesce(v_org.custom->'features', '{}'::jsonb),
    'access_until',      v_until,
    'days_left',         case when v_until is null then null
                              else greatest(0, ceil(extract(epoch from (v_until - now())) / 86400)::int) end,
    'ai_messages',       jsonb_build_object('used', coalesce(v_ai, 0),     'limit', v_limits.max_ai_messages),
    'emails',            jsonb_build_object('used', coalesce(v_emails, 0), 'limit', v_limits.max_emails),
    'whatsapp_messages', jsonb_build_object('used', coalesce(v_wa, 0),     'limit', v_limits.max_whatsapp),
    'leads',             jsonb_build_object('used', v_leads,               'limit', v_limits.max_leads),
    'seats',             jsonb_build_object('used', v_seats,               'limit', v_limits.max_seats),
    'automations',       jsonb_build_object('used', v_autos,               'limit', v_limits.max_automations),
    'whatsapp',          coalesce(v_limits.whatsapp, false),
    'api_access',        coalesce(v_limits.api_access, false)
  );
end;
$$;

revoke all on function public.usage_snapshot(uuid) from public, anon;
grant execute on function public.usage_snapshot(uuid) to authenticated;

-- ── 4. admin_list_orgs: Add is_demo flag ───────────────────────────────────

drop function if exists public.admin_list_orgs();
create or replace function public.admin_list_orgs()
returns table (
  org_id uuid, name text, slug text, plan text, effective_plan text,
  active boolean, industry text, members bigint, records bigint,
  ai_used integer, emails_used integer, whatsapp_used integer,
  period_end timestamptz, created_at timestamptz, is_demo boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id, o.name, o.slug, o.plan, public.effective_plan(o.id), o.active, o.industry_slug,
    (select count(*) from public.profiles p where p.org_id = o.id and p.status = 'active'),
    (select count(*) from public.leads l where l.org_id = o.id and (l.deleted_at is null or l.deleted_at > now() - interval '30 days')),
    (select value from public.usage_counters u where u.org_id = o.id
      and u.period = to_char(now(), 'YYYY-MM') and u.metric = 'ai_messages'),
    (select value from public.usage_counters u where u.org_id = o.id
      and u.period = to_char(now(), 'YYYY-MM') and u.metric = 'emails'),
    (select value from public.usage_counters u where u.org_id = o.id
      and u.period = to_char(now(), 'YYYY-MM') and u.metric = 'whatsapp_messages'),
    (select s.current_period_end from public.subscriptions s where s.org_id = o.id),
    o.created_at,
    coalesce((o.custom->>'is_demo')::boolean, false) as is_demo
  from public.organizations o
  where public.is_super_admin()
  order by o.created_at desc;
$$;

revoke all on function public.admin_list_orgs() from public, anon;
grant execute on function public.admin_list_orgs() to authenticated;

-- ── 5. admin_provision_demo_org: Super Admin Demo Provisioner ──────────────

create or replace function public.admin_provision_demo_org(
  p_name text,
  p_slug text,
  p_industry text,
  p_admin_email text,
  p_admin_name text default null,
  p_duration_days integer default 7,
  p_base_plan text default 'growth',
  p_features jsonb default '{}'::jsonb,
  p_seed_demo_data boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clean_name   text;
  v_clean_email  text;
  base_slug      text;
  v_slug         text;
  n              integer := 0;
  v_expiry       timestamptz;
  new_org        public.organizations%rowtype;
  v_profile_id   uuid;
  v_stages       text[];
  v_s0           text := 'new';
  v_s1           text := 'contacted';
  v_s2           text := 'qualified';
  v_s3           text := 'proposal';
  v_s4           text := 'won';
  l1_id          uuid;
  l2_id          uuid;
  l3_id          uuid;
  l4_id          uuid;
  l5_id          uuid;
  l6_id          uuid;
begin
  if not public.is_super_admin() then
    raise exception 'super admin only' using errcode = '42501';
  end if;

  v_clean_name := trim(coalesce(p_name, 'Demo Workspace'));
  if length(v_clean_name) < 2 then
    raise exception 'Organization name must be at least 2 characters';
  end if;

  v_clean_email := lower(trim(coalesce(p_admin_email, '')));
  if v_clean_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'A valid admin email is required';
  end if;

  -- Generate clean slug
  base_slug := lower(regexp_replace(trim(coalesce(p_slug, v_clean_name)), '[^a-z0-9]+', '-', 'g'));
  base_slug := trim(both '-' from base_slug);
  if length(base_slug) = 0 then base_slug := 'demo'; end if;
  v_slug := base_slug;

  while exists (select 1 from public.organizations where slug = v_slug) loop
    n := n + 1;
    v_slug := base_slug || '-' || n::text;
    if n > 500 then
      v_slug := base_slug || '-' || substr(md5(random()::text), 1, 6);
      exit;
    end if;
  end loop;

  v_expiry := now() + make_interval(days => greatest(1, coalesce(p_duration_days, 7)));

  -- Insert Organization
  insert into public.organizations (
    name, slug, active, plan, trial_started_at, trial_days,
    credits_total, credits_used, industry_slug, custom
  )
  values (
    v_clean_name,
    v_slug,
    true,
    coalesce(p_base_plan, 'growth'),
    now(),
    greatest(1, coalesce(p_duration_days, 7)),
    0, 0,
    coalesce(p_industry, 'study_abroad'),
    jsonb_build_object(
      'is_demo', true,
      'must_upgrade', true,
      'trial_duration_days', greatest(1, coalesce(p_duration_days, 7)),
      'demo_expires_at', v_expiry,
      'features', coalesce(p_features, '{}'::jsonb)
    )
  )
  returning * into new_org;

  -- Insert active Subscription strictly ending at demo expiry
  insert into public.subscriptions (
    org_id, plan, status, current_period_end, created_at, updated_at
  )
  values (
    new_org.id,
    coalesce(p_base_plan, 'growth'),
    'active',
    v_expiry,
    now(),
    now()
  );

  -- Insert Agent Config
  insert into public.agent_config (
    org_id, enabled, agent_name, welcome_message, knowledge, onboarded
  )
  values (
    new_org.id,
    coalesce((p_features->>'ai_enabled')::boolean, true),
    v_clean_name || ' AI Concierge',
    'Hello! Welcome to ' || v_clean_name || '. How can our team assist you today?',
    'Enterprise AI concierge with strict cybersecurity and zero code disclosure guardrails.',
    false
  )
  on conflict (org_id) do nothing;

  -- Seed Industry Pack (Stages & Field Definitions)
  perform public.apply_industry_pack(new_org.id, coalesce(p_industry, 'study_abroad'));

  -- Profile & Invite handling
  select id into v_profile_id from public.profiles where lower(email) = v_clean_email;
  if v_profile_id is not null then
    perform set_config('app.profile_bootstrap', 'on', true);
    update public.profiles
       set org_id = new_org.id,
           full_name = coalesce(nullif(trim(p_admin_name), ''), full_name),
           role = 'org_admin',
           status = 'active'
     where id = v_profile_id and org_id is null;
  end if;

  insert into public.invites (org_id, email, role, invited_by)
  values (new_org.id, v_clean_email, 'org_admin', auth.uid())
  on conflict do nothing;

  -- Seed realistic demo leads if requested
  if p_seed_demo_data is true then
    select array_agg(key order by position) into v_stages
      from public.pipeline_stages where org_id = new_org.id;

    if array_length(v_stages, 1) >= 1 then v_s0 := v_stages[1]; end if;
    if array_length(v_stages, 1) >= 2 then v_s1 := v_stages[2]; else v_s1 := v_s0; end if;
    if array_length(v_stages, 1) >= 3 then v_s2 := v_stages[3]; else v_s2 := v_s1; end if;
    if array_length(v_stages, 1) >= 4 then v_s3 := v_stages[4]; else v_s3 := v_s2; end if;
    if array_length(v_stages, 1) >= 5 then v_s4 := v_stages[5]; else v_s4 := v_s3; end if;

    -- Lead 1: High intent web inquiry
    insert into public.leads (
      org_id, name, email, phone, source, stage_key, score, budget_inr,
      tags, next_follow_up_at, created_at, updated_at
    )
    values (
      new_org.id, 'Aarav Sharma', 'aarav.sharma@example.com', '+919820112345',
      'website', v_s0, 88, 1800000,
      array['high-intent', 'inbound-web'], now() + interval '1 day', now() - interval '2 hours', now()
    ) returning id into l1_id;

    insert into public.activities (org_id, lead_id, type, content, created_at)
    values (new_org.id, l1_id, 'note', 'Inquired through web concierge widget. Looking for immediate intake and fast-track processing.', now() - interval '2 hours');

    -- Lead 2: WhatsApp conversation qualified
    insert into public.leads (
      org_id, name, email, phone, source, stage_key, score, budget_inr,
      tags, next_follow_up_at, created_at, updated_at
    )
    values (
      new_org.id, 'Priya Patel', 'priya.patel@example.com', '+919876543210',
      'whatsapp', v_s1, 76, 1200000,
      array['whatsapp', 'verified'], now() + interval '2 days', now() - interval '1 day', now()
    ) returning id into l2_id;

    insert into public.activities (org_id, lead_id, type, content, created_at)
    values (new_org.id, l2_id, 'whatsapp', 'WhatsApp conversation logged: Requested fee structure, scholarship criteria and document checklist.', now() - interval '1 day');

    -- Lead 3: High-ticket referral booked for consultation
    insert into public.leads (
      org_id, name, email, phone, source, stage_key, score, budget_inr,
      tags, next_follow_up_at, created_at, updated_at
    )
    values (
      new_org.id, 'Rohan Verma', 'rohan.v@example.com', '+919123456789',
      'referral', v_s2, 92, 2500000,
      array['priority', 'counselling-booked'], now() + interval '4 hours', now() - interval '2 days', now()
    ) returning id into l3_id;

    insert into public.activities (org_id, lead_id, type, content, created_at)
    values (new_org.id, l3_id, 'call', 'Detailed discovery call completed. Budget pre-approved; consultation booked with senior advisor.', now() - interval '1 day');

    -- Lead 4: Proposal / Application in Review
    insert into public.leads (
      org_id, name, email, phone, source, stage_key, score, budget_inr,
      tags, next_follow_up_at, created_at, updated_at
    )
    values (
      new_org.id, 'Ananya Iyer', 'ananya.iyer@example.com', '+919988776655',
      'meta', v_s3, 84, 1500000,
      array['application-lodged', 'meta-campaign'], now() + interval '3 days', now() - interval '4 days', now()
    ) returning id into l4_id;

    insert into public.activities (org_id, lead_id, type, content, created_at)
    values (new_org.id, l4_id, 'stage_change', 'Moved to ' || v_s3 || '. Documentation verified and submitted for review.', now() - interval '2 days');

    -- Lead 5: Won / Enrolled
    insert into public.leads (
      org_id, name, email, phone, source, stage_key, score, budget_inr,
      tags, created_at, updated_at
    )
    values (
      new_org.id, 'Vikram Malhotra', 'vikram.m@example.com', '+919765432109',
      'google', v_s4, 98, 3200000,
      array['closed-won', 'contract-signed'], now() - interval '6 days', now()
    ) returning id into l5_id;

    insert into public.activities (org_id, lead_id, type, content, created_at)
    values (new_org.id, l5_id, 'system', 'Deal confirmed and invoice issued. Welcome onboarding packet dispatched.', now() - interval '3 days');

    -- Lead 6: In nurture sequence
    insert into public.leads (
      org_id, name, email, phone, source, stage_key, score, budget_inr,
      tags, next_follow_up_at, created_at, updated_at
    )
    values (
      new_org.id, 'Kavita Reddy', 'kavita.r@example.com', '+919654321098',
      'walk_in', v_s1, 62, 900000,
      array['nurture-active'], now() + interval '5 days', now() - interval '5 days', now()
    ) returning id into l6_id;

    insert into public.activities (org_id, lead_id, type, content, created_at)
    values (new_org.id, l6_id, 'email', 'Automated Day-3 value nurture email delivered. Opened twice.', now() - interval '2 days');
  end if;

  -- Log admin audit trail
  perform public.log_admin_action(
    'create_demo_org',
    new_org.id,
    jsonb_build_object(
      'name', v_clean_name,
      'slug', v_slug,
      'industry', p_industry,
      'admin_email', v_clean_email,
      'duration_days', greatest(1, coalesce(p_duration_days, 7)),
      'features', p_features,
      'seeded_data', p_seed_demo_data
    )
  );

  return jsonb_build_object(
    'ok', true,
    'org_id', new_org.id,
    'name', new_org.name,
    'slug', new_org.slug,
    'industry', coalesce(p_industry, 'study_abroad'),
    'admin_email', v_clean_email,
    'admin_name', p_admin_name,
    'duration_days', greatest(1, coalesce(p_duration_days, 7)),
    'expires_at', v_expiry,
    'features', p_features,
    'leads_seeded', case when p_seed_demo_data then 6 else 0 end
  );
end;
$$;

revoke all on function public.admin_provision_demo_org(text, text, text, text, text, integer, text, jsonb, boolean) from public, anon;
grant execute on function public.admin_provision_demo_org(text, text, text, text, text, integer, text, jsonb, boolean) to authenticated;

commit;
