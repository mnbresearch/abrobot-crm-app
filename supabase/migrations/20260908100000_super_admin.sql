-- AbroBot CRM — give the platform owner the reach the role implies.
--
-- ── What was actually true ──────────────────────────────────────────────────
-- Audited every policy rather than assuming. Most of the schema already covers
-- super_admin correctly — leads, activities, conversations, chat_messages,
-- automations, automation_runs, invites, usage_counters, payments,
-- subscriptions, pipeline_stages, field_defs, industries and agent_config all
-- begin `public.is_super_admin() or …`. The profile guard also handles the role
-- properly: only a super admin can move a member between organisations, change
-- an email, or grant super_admin.
--
-- Three real gaps:
--
-- 1. **organizations was invisible.** `org_member_read` is
--    `id = my_org() and is_active_member()` with NO super-admin clause — so the
--    platform owner could not list organisations, or read any row but their
--    own. I wrote that policy myself in 20260903120000 while fixing a different
--    bug, and did not carry the clause over.
--
-- 2. **Nothing could change a plan.** There is no INSERT/UPDATE policy on
--    organizations, plan_limits, subscriptions or payments anywhere. Every plan
--    change so far has been someone typing UPDATE in the SQL editor. That is
--    not an access-control design, it is the absence of one — and it means the
--    action leaves no trace of who did it or why.
--
-- 3. **No trail.** A role that can read and modify every tenant's data needs a
--    log, and not mainly for blame: when a customer asks "who changed our
--    plan on the 3rd", the honest answer has to come from somewhere.
--
-- ── Deliberately NOT granted ────────────────────────────────────────────────
-- Deleting an organisation. Deactivating one is reversible and does the same
-- job; a DELETE cascades through every record, activity and transcript that
-- tenant owns, with nothing to restore from. If it is ever genuinely needed it
-- should be a considered, written-down operation, not a button.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. A trail for anything done across tenants
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.admin_audit (
  id         bigserial primary key,
  actor_id   uuid references auth.users(id),
  actor_email text,
  action     text not null,
  org_id     uuid,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_audit enable row level security;

drop policy if exists admin_audit_read on public.admin_audit;
create policy admin_audit_read on public.admin_audit
  for select using (public.is_super_admin());

-- Written only through the functions below, never directly — so the log cannot
-- be forged by the role it exists to record.
revoke insert, update, delete on public.admin_audit from authenticated, anon;

create index if not exists admin_audit_org on public.admin_audit (org_id, created_at desc);

comment on table public.admin_audit is
  'Every cross-tenant action taken by a platform super admin. Append-only from the app''s point of view.';

create or replace function public.log_admin_action(
  p_action text, p_org_id uuid, p_detail jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.admin_audit (actor_id, actor_email, action, org_id, detail)
  values (
    auth.uid(),
    (select email from public.profiles where id = auth.uid()),
    p_action, p_org_id, coalesce(p_detail, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.log_admin_action(text, uuid, jsonb) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. organizations — visible and manageable by the platform owner
-- ════════════════════════════════════════════════════════════════════════════
drop policy if exists org_member_read on public.organizations;
create policy org_member_read on public.organizations
  for select using (
    -- The clause that was missing. A member still sees only their own org, and
    -- still only while active — a disabled member should not keep reading
    -- their old employer's plan and credit balance.
    public.is_super_admin() or (id = public.my_org() and public.is_active_member())
  );

drop policy if exists org_super_admin_write on public.organizations;
create policy org_super_admin_write on public.organizations
  for update using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists org_super_admin_insert on public.organizations;
create policy org_super_admin_insert on public.organizations
  for insert with check (public.is_super_admin());

-- No delete policy, on purpose. See the header.

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Pricing, subscriptions and payments
-- ════════════════════════════════════════════════════════════════════════════
-- plan_limits is world-readable (it IS the pricing table, and the app renders
-- the upgrade cards from it). Writing it is the platform owner's alone.
drop policy if exists plan_limits_write on public.plan_limits;
create policy plan_limits_write on public.plan_limits
  for all using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists subscriptions_super_admin_write on public.subscriptions;
create policy subscriptions_super_admin_write on public.subscriptions
  for all using (public.is_super_admin()) with check (public.is_super_admin());

-- Payments are a financial record. A super admin may correct one, but the
-- normal path is still the signed Cashfree webhook.
drop policy if exists payments_super_admin_write on public.payments;
create policy payments_super_admin_write on public.payments
  for all using (public.is_super_admin()) with check (public.is_super_admin());

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Anything else that forgot the clause
-- ════════════════════════════════════════════════════════════════════════════
-- Rather than list tables by hand — the list I would write is the list I
-- already got wrong once — find every org-scoped table whose SELECT policies
-- do not mention is_super_admin, and add a read policy for it.
--
-- Read only. Write access is deliberately left as each table already defines
-- it: a platform owner needing to modify an unusual table can do it through
-- the service role, and that is a decision worth making consciously.
do $$
declare
  t record;
  added text[] := '{}';
begin
  for t in
    select c.relname as tbl
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relrowsecurity
       -- org-scoped: it has an org_id column
       and exists (select 1 from information_schema.columns ic
                    where ic.table_schema = 'public' and ic.table_name = c.relname
                      and ic.column_name = 'org_id')
       -- and no existing SELECT policy lets a super admin through
       and not exists (
         select 1 from pg_policy p
          where p.polrelid = c.oid
            and p.polcmd in ('r', '*')
            and pg_get_expr(p.polqual, p.polrelid) like '%is_super_admin%')
  loop
    execute format(
      'create policy %I on public.%I for select using (public.is_super_admin())',
      t.tbl || '_super_admin_read', t.tbl);
    added := added || t.tbl;
  end loop;

  if array_length(added, 1) is null then
    raise notice 'Every org-scoped table already covered super_admin on SELECT.';
  else
    raise notice 'Added super-admin read to: %', array_to_string(added, ', ');
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. The operations a platform owner actually performs
-- ════════════════════════════════════════════════════════════════════════════
-- Functions rather than raw table writes, for three reasons: each one validates
-- its input, each one writes the audit row, and each returns something useful
-- so the caller can show a result instead of guessing.

-- Every organisation, with the numbers you would want before changing anything.
create or replace function public.admin_list_orgs()
returns table (
  org_id uuid, name text, slug text, plan text, effective_plan text,
  active boolean, industry text, members bigint, records bigint,
  ai_used integer, emails_used integer, whatsapp_used integer,
  period_end timestamptz, created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id, o.name, o.slug, o.plan, public.effective_plan(o.id), o.active, o.industry_slug,
    (select count(*) from public.profiles p where p.org_id = o.id and p.status = 'active'),
    (select count(*) from public.leads l where l.org_id = o.id),
    (select value from public.usage_counters u where u.org_id = o.id
      and u.period = to_char(now(), 'YYYY-MM') and u.metric = 'ai_messages'),
    (select value from public.usage_counters u where u.org_id = o.id
      and u.period = to_char(now(), 'YYYY-MM') and u.metric = 'emails'),
    (select value from public.usage_counters u where u.org_id = o.id
      and u.period = to_char(now(), 'YYYY-MM') and u.metric = 'whatsapp_messages'),
    (select s.current_period_end from public.subscriptions s where s.org_id = o.id),
    o.created_at
  from public.organizations o
  where public.is_super_admin()          -- the whole result set, or nothing
  order by o.created_at desc;
$$;

-- Set an organisation's plan, and extend its period. This is the function that
-- replaces typing UPDATE in the SQL editor.
create or replace function public.admin_set_plan(
  p_org_id uuid, p_plan text, p_months integer default 1, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_end timestamptz;
  v_old text;
begin
  if not public.is_super_admin() then
    raise exception 'super admin only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.plan_limits where plan = p_plan) then
    raise exception 'Unknown plan: %. Valid: %', p_plan,
      (select string_agg(plan, ', ' order by position) from public.plan_limits);
  end if;
  if p_months is null or p_months < 0 or p_months > 60 then
    raise exception 'months must be between 0 and 60';
  end if;

  select plan into v_old from public.organizations where id = p_org_id;
  if v_old is null then raise exception 'No such organisation'; end if;

  update public.organizations set plan = p_plan where id = p_org_id;

  if p_plan in ('free', 'expired') then
    -- Parking an account: clear the period rather than leaving a stale date
    -- that effective_plan would later read as "expired on…".
    delete from public.subscriptions where org_id = p_org_id;
    v_end := null;
  elsif p_months > 0 then
    -- Extend from whichever is later: now, or the end of what they already
    -- have. Extending from now would silently shorten a live subscription.
    select greatest(now(), coalesce(s.current_period_end, now()))
      into v_end from public.subscriptions s where s.org_id = p_org_id;
    v_end := coalesce(v_end, now()) + make_interval(months => p_months);

    insert into public.subscriptions (org_id, plan, status, current_period_end, updated_at)
    values (p_org_id, p_plan, 'active', v_end, now())
    on conflict (org_id) do update set
      plan = excluded.plan, status = 'active',
      current_period_end = excluded.current_period_end, updated_at = now();
  end if;

  perform public.log_admin_action('set_plan', p_org_id, jsonb_build_object(
    'from', v_old, 'to', p_plan, 'months', p_months,
    'period_end', v_end, 'note', p_note));

  return jsonb_build_object('ok', true, 'org_id', p_org_id,
    'from', v_old, 'to', p_plan, 'period_end', v_end);
end;
$$;

-- Suspend or restore an organisation. Reversible, unlike deletion.
create or replace function public.admin_set_org_active(
  p_org_id uuid, p_active boolean, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'super admin only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.organizations where id = p_org_id) then
    raise exception 'No such organisation';
  end if;

  update public.organizations set active = p_active where id = p_org_id;
  perform public.log_admin_action(
    case when p_active then 'reactivate_org' else 'suspend_org' end,
    p_org_id, jsonb_build_object('note', p_note));

  return jsonb_build_object('ok', true, 'org_id', p_org_id, 'active', p_active);
end;
$$;

-- Change a member's role or status in ANY organisation — the support action for
-- "the only admin left the company".
create or replace function public.admin_set_member(
  p_profile_id uuid, p_role text default null, p_status text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_org uuid; v_old_role text; v_old_status text;
begin
  if not public.is_super_admin() then
    raise exception 'super admin only' using errcode = '42501';
  end if;

  select org_id, role::text, status::text into v_org, v_old_role, v_old_status
    from public.profiles where id = p_profile_id;
  if not found then raise exception 'No such member'; end if;

  -- The guard trigger allows a super admin through, but it reads auth.uid() —
  -- and this function runs as its owner. Set the bootstrap flag so the
  -- sanctioned path is explicit rather than incidental.
  perform set_config('app.profile_bootstrap', 'on', true);

  update public.profiles
     set role   = coalesce(p_role::public.user_role, role),
         status = coalesce(p_status::public.member_status, status)
   where id = p_profile_id;

  perform public.log_admin_action('set_member', v_org, jsonb_build_object(
    'profile_id', p_profile_id,
    'role',   jsonb_build_object('from', v_old_role,   'to', coalesce(p_role, v_old_role)),
    'status', jsonb_build_object('from', v_old_status, 'to', coalesce(p_status, v_old_status)),
    'note', p_note));

  return jsonb_build_object('ok', true, 'profile_id', p_profile_id,
    'role', coalesce(p_role, v_old_role), 'status', coalesce(p_status, v_old_status));
end;
$$;

-- Update a plan's price or limits, with the audit row.
create or replace function public.admin_set_plan_limits(
  p_plan text, p_changes jsonb, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before jsonb;
  k text;
  allowed text[] := array['label','max_seats','max_leads','max_ai_messages',
                          'max_automations','max_emails','max_whatsapp',
                          'whatsapp','api_access','price_inr','position'];
begin
  if not public.is_super_admin() then
    raise exception 'super admin only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.plan_limits where plan = p_plan) then
    raise exception 'Unknown plan: %', p_plan;
  end if;

  -- An allowlist, so a typo'd key is an error rather than a silent no-op, and
  -- so `plan` itself can never be renamed out from under everything that
  -- references it.
  for k in select jsonb_object_keys(p_changes) loop
    if not (k = any(allowed)) then
      raise exception 'Cannot set "%". Allowed: %', k, array_to_string(allowed, ', ');
    end if;
  end loop;

  select to_jsonb(pl) into v_before from public.plan_limits pl where pl.plan = p_plan;

  update public.plan_limits pl
     set label           = coalesce((p_changes->>'label'), pl.label),
         max_seats       = coalesce((p_changes->>'max_seats')::int, pl.max_seats),
         max_leads       = coalesce((p_changes->>'max_leads')::int, pl.max_leads),
         max_ai_messages = coalesce((p_changes->>'max_ai_messages')::int, pl.max_ai_messages),
         max_automations = coalesce((p_changes->>'max_automations')::int, pl.max_automations),
         max_emails      = coalesce((p_changes->>'max_emails')::int, pl.max_emails),
         max_whatsapp    = coalesce((p_changes->>'max_whatsapp')::int, pl.max_whatsapp),
         whatsapp        = coalesce((p_changes->>'whatsapp')::boolean, pl.whatsapp),
         api_access      = coalesce((p_changes->>'api_access')::boolean, pl.api_access),
         price_inr       = coalesce((p_changes->>'price_inr')::int, pl.price_inr),
         position        = coalesce((p_changes->>'position')::int, pl.position)
   where pl.plan = p_plan;

  perform public.log_admin_action('set_plan_limits', null, jsonb_build_object(
    'plan', p_plan, 'before', v_before, 'changes', p_changes, 'note', p_note));

  return jsonb_build_object('ok', true, 'plan', p_plan,
    'after', (select to_jsonb(pl) from public.plan_limits pl where pl.plan = p_plan));
end;
$$;

-- The trail itself.
create or replace function public.admin_recent_actions(p_limit integer default 100)
returns table (
  created_at timestamptz, actor_email text, action text,
  org_slug text, detail jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select a.created_at, a.actor_email, a.action, o.slug, a.detail
    from public.admin_audit a
    left join public.organizations o on o.id = a.org_id
   where public.is_super_admin()
   order by a.created_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Revoke from PUBLIC first: `grant ... to authenticated` ADDS to the default
-- PUBLIC grant rather than replacing it, which is how anon kept execute on six
-- functions until yesterday. Each of these checks is_super_admin() in its own
-- body, so a non-admin calling one gets an exception rather than data — but
-- anon should not be able to reach them at all.
do $$
declare f text;
begin
  foreach f in array array[
    'public.admin_list_orgs()',
    'public.admin_set_plan(uuid, text, integer, text)',
    'public.admin_set_org_active(uuid, boolean, text)',
    'public.admin_set_member(uuid, text, text, text)',
    'public.admin_set_plan_limits(text, jsonb, text)',
    'public.admin_recent_actions(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select 'super admin can read every organisation' as check,
       case when (select pg_get_expr(polqual, polrelid) from pg_policy
                   where polrelid = 'public.organizations'::regclass
                     and polname = 'org_member_read') like '%is_super_admin%'
            then 'PASS' else 'FAIL' end as result
union all
select 'super admin can change an organisation',
       case when exists (select 1 from pg_policy
                          where polrelid = 'public.organizations'::regclass
                            and polname = 'org_super_admin_write')
            then 'PASS' else 'FAIL' end
union all
select 'super admin can edit pricing',
       case when exists (select 1 from pg_policy
                          where polrelid = 'public.plan_limits'::regclass
                            and polname = 'plan_limits_write')
            then 'PASS' else 'FAIL' end
union all
select 'organisations cannot be deleted through the app',
       case when not exists (select 1 from pg_policy
                              where polrelid = 'public.organizations'::regclass
                                and polcmd in ('d', '*'))
            then 'PASS — suspend instead' else 'CHECK — a delete path exists' end
union all
select 'every org-scoped table is readable by a super admin',
       coalesce((select string_agg(c.relname, ', ')
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
           and exists (select 1 from information_schema.columns ic
                        where ic.table_schema='public' and ic.table_name=c.relname
                          and ic.column_name='org_id')
           and not exists (select 1 from pg_policy p
                            where p.polrelid = c.oid and p.polcmd in ('r','*')
                              and pg_get_expr(p.polqual, p.polrelid) like '%is_super_admin%')),
        'PASS — none left uncovered')
union all
select 'admin actions are logged',
       case when to_regclass('public.admin_audit') is not null
             and to_regprocedure('public.log_admin_action(text,uuid,jsonb)') is not null
            then 'PASS' else 'FAIL' end
union all
select 'anon cannot reach the admin functions',
       case when has_function_privilege('anon', 'public.admin_list_orgs()', 'EXECUTE')
            then 'FAIL' else 'PASS' end
union all
select 'admin_list_orgs runs',
       case when (select count(*) from public.admin_list_orgs()) >= 0
            then 'PASS' else 'FAIL' end;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Housekeeping after the pricing reset
-- ════════════════════════════════════════════════════════════════════════════
-- my_entitlements still computed an access date from trial_started_at +
-- trial_days for `plan = 'trial'` — a plan that no longer exists. The view is
-- correctly scoped (`where o.id = my_org() or is_super_admin()`, so it leaks
-- nothing) and nothing in the app reads it, so this is tidying rather than a
-- fix. Left stale it would quietly mislead the next person who reaches for it.
-- DROP then CREATE, not CREATE OR REPLACE. Postgres can only APPEND columns to
-- an existing view; adding `not_activated` in the middle tries to rename
-- column 5 from `label` and fails with 42P16. Nothing reads this view (checked
-- app/src and supabase/functions: zero references), so dropping it is safe.
--
-- No CASCADE, deliberately: if something DOES depend on it, this should fail
-- loudly rather than quietly taking the dependent with it.
drop view if exists public.my_entitlements;

create view public.my_entitlements with (security_barrier = true) as
  select
    o.id                as org_id,
    o.plan              as purchased_plan,
    public.effective_plan(o.id) as effective_plan,
    (public.effective_plan(o.id) = 'expired') as is_expired,
    (public.effective_plan(o.id) = 'free')    as not_activated,
    pl.label, pl.max_seats, pl.max_leads, pl.max_ai_messages,
    pl.max_automations, pl.max_emails, pl.max_whatsapp,
    pl.whatsapp, pl.api_access,
    s.current_period_end,
    s.current_period_end as access_until
  from public.organizations o
  left join public.subscriptions s on s.org_id = o.id
  cross join lateral public.plan_of(o.id) pl
  where o.id = public.my_org() or public.is_super_admin();

grant select on public.my_entitlements to authenticated;
