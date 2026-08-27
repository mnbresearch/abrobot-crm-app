-- AbroBot CRM — self-serve signup and team invites.
-- NOT APPLIED. Review first.
--
-- Until now a customer could sign in but nothing created their organisation:
-- every account had to be hand-built in SQL. That is workable for three pilot
-- customers and impossible for thirty. This closes that gap.
--
-- Two flows:
--   1. A new person signs up  -> creates their own organisation, becomes its
--      org_admin, lands on a configured CRM.
--   2. An admin invites a teammate -> the teammate signs in and is attached to
--      the existing organisation with the role the admin chose.
--
-- Both run in Postgres as SECURITY DEFINER, because they must write columns no
-- browser session may touch (profiles.org_id, profiles.role). The guards below
-- are what make that safe.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. PROFILE BOOTSTRAP
-- ════════════════════════════════════════════════════════════════════════════
-- A brand-new auth user may have no profile row at all. Every entry point
-- calls this first so the rest of the system can assume a profile exists.

create or replace function public.ensure_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  em  text;
  nm  text;
  p   public.profiles%rowtype;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select * into p from public.profiles where id = uid;
  if found then return p; end if;

  -- Pull identity from the JWT rather than trusting anything client-supplied.
  select email,
         coalesce(raw_user_meta_data->>'full_name', split_part(email, '@', 1))
    into em, nm
    from auth.users where id = uid;

  insert into public.profiles (id, org_id, full_name, email, role, status)
  values (uid, null, coalesce(nm, 'New user'), coalesce(em, ''), 'counsellor', 'pending')
  returning * into p;

  return p;
end;
$$;

grant execute on function public.ensure_profile() to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. CREATE AN ORGANISATION  (self-serve signup)
-- ════════════════════════════════════════════════════════════════════════════

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

  -- One organisation per account. Without this, a single signup could create
  -- organisations in a loop — free trials, seats and AI credits each time.
  -- Joining an existing org happens through an invite, not through here.
  if prof.org_id is not null then
    raise exception 'This account already belongs to an organisation'
      using errcode = '42501';
  end if;

  if not exists (select 1 from public.industries where slug = p_industry and active) then
    raise exception 'Unknown industry: %', p_industry;
  end if;

  -- Slug: url-safe, collision-resistant. The loop matters — "acme" is going
  -- to be taken.
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
  values (trim(p_name), slug, true, 'trial', now(), 7, 0, 0, p_industry)
  returning * into new_org;

  -- The creator runs it.
  update public.profiles
     set org_id = new_org.id,
         role   = 'org_admin',
         status = 'active'
   where id = uid;

  -- agent_config must exist before apply_industry_pack can seed the persona.
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

grant execute on function public.create_organisation(text, text) to authenticated;

comment on function public.create_organisation is
  'Self-serve signup. Creates an org, makes the caller its org_admin, seeds the industry pack. One org per account.';

-- ════════════════════════════════════════════════════════════════════════════
-- 3. INVITES
-- ════════════════════════════════════════════════════════════════════════════
-- An admin cannot create another person's login — only Supabase Auth can. So
-- an invite records intent: when that email signs in, they are attached to the
-- org with the role chosen for them.

create table if not exists public.invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  email       text not null,
  role        public.user_role not null default 'counsellor',
  invited_by  uuid,
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (org_id, email)
);

create index if not exists invites_email_idx on public.invites (lower(email)) where accepted_at is null;

alter table public.invites enable row level security;

drop policy if exists invites_read on public.invites;
create policy invites_read on public.invites
  for select using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
  );

drop policy if exists invites_write on public.invites;
create policy invites_write on public.invites
  for all using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  ) with check (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  );

-- Claim an invite. Called by the app after sign-in when the user has no org.
create or replace function public.accept_invite()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid  uuid := auth.uid();
  prof public.profiles%rowtype;
  inv  public.invites%rowtype;
  seat_cap   integer;
  active_now integer;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  prof := public.ensure_profile();
  if prof.org_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'already in an organisation');
  end if;

  -- Match on the JWT's email, never on anything the client passes. Otherwise
  -- anyone could claim an invite addressed to someone else.
  select * into inv
    from public.invites
   where lower(email) = lower(prof.email)
     and accepted_at is null
   order by created_at
   limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no pending invite');
  end if;

  -- Seat limit applies to invites too, or the limit is trivially bypassed.
  select pl.max_seats into seat_cap
    from public.organizations o
    join public.plan_limits pl on pl.plan = o.plan
   where o.id = inv.org_id;

  if seat_cap is not null then
    select count(*) into active_now
      from public.profiles
     where org_id = inv.org_id and status = 'active';
    if active_now + 1 > seat_cap then
      return jsonb_build_object('ok', false, 'reason',
        format('That organisation has used all %s seats on its plan', seat_cap));
    end if;
  end if;

  update public.profiles
     set org_id = inv.org_id, role = inv.role, status = 'active'
   where id = uid;

  update public.invites set accepted_at = now() where id = inv.id;

  return jsonb_build_object('ok', true, 'org_id', inv.org_id, 'role', inv.role);
end;
$$;

grant execute on function public.accept_invite() to authenticated;

commit;
