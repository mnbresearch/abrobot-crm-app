-- AbroBot CRM — automation rules + server-enforced plan limits
-- NOT APPLIED. Review first.
--
-- ── Why automations, specifically ───────────────────────────────────────────
-- Screens are copyable. A competitor can rebuild a leads table in a week.
-- What they cannot copy is the org's own encoded process: "if a hot lead goes
-- 48 hours without contact, reassign it and alert the manager." Once a team
-- has twenty of those running, moving CRM means rebuilding twenty rules they
-- have half-forgotten the reasons for. That is a switching cost, and switching
-- costs are what a moat actually is.
--
-- Design decisions:
--  * Rules are DATA, not code. An org edits them without a deploy.
--  * Conditions are a small, closed expression language — deliberately not
--    arbitrary JS. It stays safe to run server-side with the service role, and
--    it stays explainable in the UI.
--  * Every run is logged. An automation nobody can audit is one nobody trusts,
--    and an untrusted automation gets switched off.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. AUTOMATIONS
-- ════════════════════════════════════════════════════════════════════════════

do $$ begin
  create type public.automation_trigger as enum (
    'lead_created',        -- fires from lead-webhook / chat-agent
    'stage_changed',
    'no_contact_for',      -- time-based, evaluated by cron
    'follow_up_overdue',   -- time-based
    'score_above',
    'score_below'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.automation_action as enum (
    'set_stage',
    'assign_to',
    'assign_round_robin',
    'set_score',
    'add_tag',
    'set_follow_up',
    'notify_telegram',
    'send_email_template',
    'add_note'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.automations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null,
  enabled     boolean not null default true,
  trigger     public.automation_trigger not null,
  -- trigger parameter: hours for no_contact_for, score for score_above, etc.
  trigger_value numeric,
  -- optional narrowing, e.g. [{"field":"source","op":"eq","value":"whatsapp"}]
  conditions  jsonb not null default '[]'::jsonb,
  -- ordered list, e.g. [{"action":"set_stage","value":"contacted"}]
  actions     jsonb not null default '[]'::jsonb,
  -- guard rail: never act on the same lead twice within this window
  cooldown_hours integer not null default 24,
  run_count   integer not null default 0,
  last_run_at timestamptz,
  created_at  timestamptz not null default now(),
  created_by  uuid
);

create index if not exists automations_org_enabled_idx
  on public.automations (org_id, enabled) where enabled;

alter table public.automations enable row level security;

drop policy if exists automations_read on public.automations;
create policy automations_read on public.automations
  for select using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
  );

drop policy if exists automations_write on public.automations;
create policy automations_write on public.automations
  for all using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  ) with check (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  );

-- ── audit log ───────────────────────────────────────────────────────────────
-- Also the cooldown source of truth: "did this rule already fire for this
-- lead recently" is answered here rather than with a column on leads.
create table if not exists public.automation_runs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  automation_id uuid not null references public.automations(id) on delete cascade,
  lead_id       uuid references public.leads(id) on delete cascade,
  actions_taken jsonb not null default '[]'::jsonb,
  ok            boolean not null default true,
  detail        text,
  created_at    timestamptz not null default now()
);

create index if not exists automation_runs_lookup_idx
  on public.automation_runs (automation_id, lead_id, created_at desc);
create index if not exists automation_runs_org_idx
  on public.automation_runs (org_id, created_at desc);

alter table public.automation_runs enable row level security;

drop policy if exists automation_runs_read on public.automation_runs;
create policy automation_runs_read on public.automation_runs
  for select using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
  );
-- writes are service-role only (edge functions); no policy needed for that.

-- ════════════════════════════════════════════════════════════════════════════
-- 2. PLAN LIMITS  (enforced server-side)
-- ════════════════════════════════════════════════════════════════════════════
-- organizations already carries plan / credits_total / credits_used / trial.
-- Nothing ever checked them outside the browser, which means they were
-- advisory. A limit enforced only in the client is not a limit.

create table if not exists public.plan_limits (
  plan            text primary key,
  label           text not null,
  max_seats       integer,      -- null = unlimited
  max_leads       integer,
  max_ai_messages integer,      -- per calendar month
  max_automations integer,
  whatsapp        boolean not null default false,
  price_inr       integer,
  position        integer not null default 0
);

alter table public.plan_limits enable row level security;
drop policy if exists plan_limits_read on public.plan_limits;
create policy plan_limits_read on public.plan_limits for select using (true);

insert into public.plan_limits (plan, label, max_seats, max_leads, max_ai_messages, max_automations, whatsapp, price_inr, position)
values
  ('trial',      'Free trial',   2,    100,    200,   2,    false, 0,    0),
  ('starter',    'Starter',      3,    1000,   1000,  5,    false, 999,  1),
  ('growth',     'Growth',       10,   10000,  5000,  25,   true,  2499, 2),
  ('business',   'Business',     30,   50000,  20000, 100,  true,  4999, 3),
  ('enterprise', 'Enterprise',   null, null,   null,  null, true,  null, 4)
on conflict (plan) do update set
  label = excluded.label, max_seats = excluded.max_seats, max_leads = excluded.max_leads,
  max_ai_messages = excluded.max_ai_messages, max_automations = excluded.max_automations,
  whatsapp = excluded.whatsapp, price_inr = excluded.price_inr, position = excluded.position;

-- ── usage counter ───────────────────────────────────────────────────────────
-- Monthly AI message usage, incremented by chat-agent. Kept separate from
-- organizations.credits_* so the existing trial/credit logic is untouched.
create table if not exists public.usage_counters (
  org_id  uuid not null references public.organizations(id) on delete cascade,
  period  text not null,              -- 'YYYY-MM'
  metric  text not null,              -- 'ai_messages' | 'whatsapp_sent'
  value   integer not null default 0,
  primary key (org_id, period, metric)
);

alter table public.usage_counters enable row level security;
drop policy if exists usage_counters_read on public.usage_counters;
create policy usage_counters_read on public.usage_counters
  for select using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
  );

-- Atomic increment + limit check in one call, so two concurrent chats cannot
-- both slip past the last credit.
create or replace function public.consume_usage(
  p_org_id uuid, p_metric text, p_limit integer, p_amount integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period text := to_char(now(), 'YYYY-MM');
  v_new    integer;
begin
  insert into public.usage_counters (org_id, period, metric, value)
  values (p_org_id, v_period, p_metric, p_amount)
  on conflict (org_id, period, metric)
  do update set value = public.usage_counters.value + p_amount
  returning value into v_new;

  -- null limit means unlimited
  if p_limit is not null and v_new > p_limit then
    return jsonb_build_object('allowed', false, 'used', v_new, 'limit', p_limit);
  end if;
  return jsonb_build_object('allowed', true, 'used', v_new, 'limit', p_limit);
end;
$$;

-- Read-only snapshot for the UI.
create or replace function public.usage_snapshot(p_org_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period text := to_char(now(), 'YYYY-MM');
  v_plan   text;
  v_limits public.plan_limits%rowtype;
  v_ai     integer;
  v_leads  integer;
  v_seats  integer;
  v_autos  integer;
begin
  if not (public.is_super_admin() or (p_org_id = public.my_org() and public.is_active_member())) then
    raise exception 'not authorised';
  end if;

  select plan into v_plan from public.organizations where id = p_org_id;
  select * into v_limits from public.plan_limits where plan = coalesce(v_plan, 'trial');

  select coalesce(value, 0) into v_ai from public.usage_counters
   where org_id = p_org_id and period = v_period and metric = 'ai_messages';
  select count(*) into v_leads from public.leads where org_id = p_org_id;
  select count(*) into v_seats from public.profiles where org_id = p_org_id and status = 'active';
  select count(*) into v_autos from public.automations where org_id = p_org_id and enabled;

  return jsonb_build_object(
    'plan', coalesce(v_plan, 'trial'),
    'label', coalesce(v_limits.label, 'Free trial'),
    'period', v_period,
    'ai_messages', jsonb_build_object('used', coalesce(v_ai, 0), 'limit', v_limits.max_ai_messages),
    'leads',       jsonb_build_object('used', v_leads,           'limit', v_limits.max_leads),
    'seats',       jsonb_build_object('used', v_seats,           'limit', v_limits.max_seats),
    'automations', jsonb_build_object('used', v_autos,           'limit', v_limits.max_automations),
    'whatsapp', coalesce(v_limits.whatsapp, false)
  );
end;
$$;

grant execute on function public.usage_snapshot(uuid) to authenticated;

commit;
