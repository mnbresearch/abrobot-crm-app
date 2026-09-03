-- AbroBot CRM — security hardening.
-- NOT APPLIED. Read the diagnostics at the bottom before and after.
--
-- Findings from a full audit of the schema, the edge functions and the app.
-- Fixed here, worst first:
--
--   1. grant_plan_from_payment() was callable by anyone, and not idempotent.
--      Pay once, then loop the call to extend your subscription forever.
--   2. Self-serve signup is BROKEN RIGHT NOW — create_organisation() and
--      accept_invite() are blocked by the very trigger meant to protect them.
--   3. An org_admin could mint a platform super_admin through an invite.
--   4. Anyone could join any organisation by editing their own email.
--   5. The privilege guard did not run on INSERT.
--   6. call_edge_function() was a world-callable HTTP primitive.
--
-- Everything here is idempotent and safe to re-run.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. CRITICAL — free unlimited subscriptions
-- ════════════════════════════════════════════════════════════════════════════
-- grant_plan_from_payment(p_payment_id) is SECURITY DEFINER, writes
-- organizations.plan and subscriptions, takes a caller-controlled id, does no
-- authorisation check, and had no REVOKE — so Postgres's default grant to
-- PUBLIC exposed it at POST /rest/v1/rpc/grant_plan_from_payment to anon.
--
-- The payments_read policy lets any active member read their own org's
-- payment rows, so the id needed is not even secret. And the function is not
-- idempotent: it computes
--     greatest(now(), current_period_end) + period_months
-- so every call adds another month. Pay ₹999 once, call it 120 times, own the
-- plan for a decade. This defeats the entire expiry system.
--
-- The neighbouring migration caught exactly this class of bug for
-- consume_usage and mark_lapsed_subscriptions. These two were missed.

revoke all on function public.grant_plan_from_payment(uuid) from public, anon, authenticated;

-- Real idempotency, rather than the comment that claimed it.
-- The claim is now enforced by a unique write: whoever sets granted_at first
-- does the work, everyone else returns early. This also fixes an honest-path
-- bug — billing-webhook returns 500 on a failed grant so Cashfree retries, and
-- the retry used to double-extend the subscription.
alter table public.payments add column if not exists granted_at timestamptz;

create or replace function public.grant_plan_from_payment(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pay      public.payments%rowtype;
  new_end  timestamptz;
begin
  -- Claim the grant. `and granted_at is null` makes this a compare-and-swap:
  -- concurrent webhook deliveries race here, exactly one wins, and the loser
  -- gets no row back. Replay is now a no-op instead of a free month.
  update public.payments
     set granted_at = now()
   where id = p_payment_id
     and status = 'paid'
     and granted_at is null
  returning * into pay;

  if not found then
    return jsonb_build_object('ok', true, 'already_granted', true);
  end if;

  select greatest(now(), coalesce(s.current_period_end, now())) into new_end
    from (select current_period_end from public.subscriptions where org_id = pay.org_id) s;
  new_end := coalesce(new_end, now()) + (pay.period_months || ' months')::interval;

  insert into public.subscriptions (org_id, plan, status, current_period_end, last_payment_id, updated_at)
  values (pay.org_id, pay.plan, 'active', new_end, pay.id, now())
  on conflict (org_id) do update set
    plan = excluded.plan, status = 'active',
    current_period_end = excluded.current_period_end,
    last_payment_id = excluded.last_payment_id, updated_at = now();

  update public.organizations set plan = pay.plan where id = pay.org_id;

  return jsonb_build_object('ok', true, 'org_id', pay.org_id,
                            'plan', pay.plan, 'until', new_end);
end;
$$;

revoke all on function public.grant_plan_from_payment(uuid) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. A world-callable HTTP primitive
-- ════════════════════════════════════════════════════════════════════════════
-- call_edge_function(name, body) is SECURITY DEFINER with no REVOKE, so anon
-- could POST arbitrary JSON to any edge function by name. The functions it can
-- reach are already --no-verify-jwt, so this grants little NEW reach — but the
-- name is unvalidated and it is free amplification for anything that sends
-- email or calls a paid API. pg_cron runs as the owner and is unaffected.

do $$ begin
  execute 'revoke all on function public.call_edge_function(text, jsonb) from public, anon, authenticated';
exception when undefined_function then
  raise notice 'call_edge_function(text, jsonb) not present — skipped';
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. CRITICAL — self-serve signup is broken right now
-- ════════════════════════════════════════════════════════════════════════════
-- guard_profile_changes() blocks any org_id change unless the caller is a
-- super_admin. create_organisation() and accept_invite() both have to move a
-- profile into an org, and SECURITY DEFINER does NOT change auth.uid() — so
-- the trigger sees an ordinary counsellor moving themselves and raises
-- "Only a super admin can move a member to another organisation".
--
-- Both functions therefore fail 100% of the time. Anyone who signs up today
-- cannot create an organisation, and no invited teammate can join.
--
-- The tempting fix under pressure is to loosen the guard. That is exactly what
-- would make items 4 and 5 below exploitable. Instead the two legitimate
-- bootstrap paths announce themselves with a transaction-local flag that only
-- SECURITY DEFINER code can set. set_config(..., true) is scoped to the
-- transaction, so it cannot leak into a later client statement.

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
  is_insert   boolean := (tg_op = 'INSERT');
begin
  -- Service role / migrations / edge functions: no JWT, already fully trusted.
  if caller_id is null then
    return new;
  end if;

  -- The sanctioned bootstrap paths (create_organisation, accept_invite).
  if current_setting('app.profile_bootstrap', true) = 'on' then
    return new;
  end if;

  select role into caller_role from public.profiles where id = caller_id;

  -- ── INSERT ───────────────────────────────────────────────────────────────
  -- The guard used to be UPDATE-only, so every check below could be skipped by
  -- inserting a profile row instead of updating one. If a permissive
  -- self-insert policy exists, that was a one-request path to platform
  -- super_admin. A new profile may only ever be your own, unprivileged, and
  -- unattached to an org.
  if is_insert then
    if new.id <> caller_id and coalesce(caller_role, 'counsellor') <> 'super_admin' then
      raise exception 'You can only create your own profile' using errcode = '42501';
    end if;
    if coalesce(caller_role, 'counsellor') <> 'super_admin' then
      if new.role is distinct from 'counsellor'::public.user_role then
        raise exception 'A new profile cannot be created with an elevated role'
          using errcode = '42501';
      end if;
      if new.org_id is not null then
        raise exception 'Join an organisation through an invite, not by creating a profile'
          using errcode = '42501';
      end if;
      if new.status = 'active'::public.member_status then
        raise exception 'A new profile cannot activate itself' using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  -- ── UPDATE ───────────────────────────────────────────────────────────────
  if new.org_id is distinct from old.org_id
     and coalesce(caller_role, 'counsellor'::public.user_role) <> 'super_admin' then
    raise exception 'Only a super admin can move a member to another organisation'
      using errcode = '42501';
  end if;

  -- Email is the identity accept_invite() matches on, so letting a user edit
  -- it freely is a way into someone else's organisation. Only a super admin
  -- may change it; users change their email through Supabase Auth.
  if new.email is distinct from old.email
     and coalesce(caller_role, 'counsellor'::public.user_role) <> 'super_admin' then
    raise exception 'Email is managed by your login and cannot be edited here'
      using errcode = '42501';
  end if;

  if new.role is distinct from old.role then
    if caller_role = 'super_admin' then
      null;
    elsif caller_role = 'org_admin' then
      if new.role = 'super_admin' then
        raise exception 'Only a super admin can grant super admin' using errcode = '42501';
      end if;
      if new.id = caller_id then
        raise exception 'You cannot change your own role. Ask a super admin.' using errcode = '42501';
      end if;
    else
      raise exception 'Only an admin can change roles' using errcode = '42501';
    end if;
  end if;

  if new.status is distinct from old.status then
    if coalesce(caller_role, 'counsellor'::public.user_role)
       not in ('org_admin'::public.user_role, 'super_admin'::public.user_role) then
      raise exception 'Only an admin can change access' using errcode = '42501';
    end if;
  end if;

  if new.status = 'active'::public.member_status
     and old.status is distinct from 'active'::public.member_status then
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

drop trigger if exists trg_guard_profile_changes on public.profiles;
create trigger trg_guard_profile_changes
  before insert or update on public.profiles
  for each row execute function public.guard_profile_changes();

-- ════════════════════════════════════════════════════════════════════════════
-- 4. An org_admin could mint a platform super_admin
-- ════════════════════════════════════════════════════════════════════════════
-- invites_write only checks the org. It says nothing about `role`, and
-- accept_invite() copies inv.role onto the profile verbatim. The UI dropdown
-- offers only counsellor and org_admin — irrelevant, PostgREST accepts
-- whatever is POSTed. An org_admin invites a second address they own as
-- 'super_admin', accepts it, and holds read/write on every tenant.

do $$ begin
  alter table public.invites
    add constraint invites_role_not_super check (role <> 'super_admin'::public.user_role);
exception
  when duplicate_object then null;
  when undefined_table  then raise notice 'invites table not present — skipped';
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Anyone could join any organisation by editing their own email
-- ════════════════════════════════════════════════════════════════════════════
-- accept_invite() matched on prof.email — the profiles COLUMN, not the JWT,
-- despite the comment claiming otherwise. profiles.email was user-writable, so
-- the attack was two requests: PATCH your email to the target admin's address,
-- then call accept_invite(). Item 3 now blocks the edit; this reads identity
-- from auth.users so the function is correct on its own terms too.

create or replace function public.accept_invite()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid        uuid := auth.uid();
  prof       public.profiles%rowtype;
  inv        public.invites%rowtype;
  jwt_email  text;
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

  -- Identity from the auth system, never from a table the user can write.
  select email into jwt_email from auth.users where id = uid;
  if jwt_email is null then
    return jsonb_build_object('ok', false, 'reason', 'no email on this account');
  end if;

  select * into inv
    from public.invites
   where lower(email) = lower(jwt_email)
     and accepted_at is null
   order by created_at
   limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no pending invite');
  end if;

  -- Defence in depth behind the CHECK constraint: an ops script or a future
  -- migration could bypass the constraint, and this path grants real power.
  if inv.role = 'super_admin'::public.user_role then
    return jsonb_build_object('ok', false, 'reason', 'invalid invite');
  end if;

  seat_cap := public.plan_seat_cap(inv.org_id);
  if seat_cap is not null then
    select count(*) into active_now
      from public.profiles
     where org_id = inv.org_id and status = 'active';
    if active_now + 1 > seat_cap then
      return jsonb_build_object('ok', false, 'reason',
        format('That organisation has used all %s seats on its plan', seat_cap));
    end if;
  end if;

  perform set_config('app.profile_bootstrap', 'on', true);

  update public.profiles
     set org_id = inv.org_id, role = inv.role, status = 'active'
   where id = uid;

  update public.invites set accepted_at = now() where id = inv.id;

  return jsonb_build_object('ok', true, 'org_id', inv.org_id, 'role', inv.role);
end;
$$;

revoke all on function public.accept_invite() from public, anon;
grant execute on function public.accept_invite() to authenticated;

-- ── create_organisation: same bootstrap flag ────────────────────────────────
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
  values (trim(p_name), slug, true, 'trial', now(), 7, 0, 0, p_industry)
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

revoke all on function public.create_organisation(text, text) from public, anon;
grant execute on function public.create_organisation(text, text) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Cross-tenant plan disclosure
-- ════════════════════════════════════════════════════════════════════════════
-- These take a caller-controlled org_id and did no authorisation check, so any
-- signed-in user holding another org's UUID could read its plan and expiry.
-- Low severity (UUIDs are not enumerable through RLS, no PII) but free to fix.

create or replace function public.plan_seat_cap(p_org_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.is_super_admin() or p_org_id = public.my_org() or auth.uid() is null) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return (select max_seats from public.plan_of(p_org_id));
end;
$$;

grant execute on function public.plan_seat_cap(uuid) to authenticated;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- DIAGNOSTICS — run this separately. Three answers the audit could not get
-- from source, because these tables' policies live only in the database.
-- ════════════════════════════════════════════════════════════════════════════
--
-- select c.relname as table_name, pol.polname,
--        case pol.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
--             when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as cmd,
--        pg_get_expr(pol.polqual, pol.polrelid)      as using_expr,
--        pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check_expr
--   from pg_policy pol join pg_class c on c.oid = pol.polrelid
--  where c.relname in ('organizations','profiles','webhook_keys','agent_config','leads')
--  order by c.relname, pol.polname;
--
-- What to look for:
--
-- organizations — if any policy lets a plain member UPDATE it, then
--     PATCH /rest/v1/organizations?id=eq.<own>  {"plan":"enterprise"}
--   gives unlimited everything and every limit in the system evaporates.
--   plan, trial_started_at, trial_days, credits_* and active must be
--   service-role / super-admin only.
--
-- profiles — a permissive INSERT policy was the second half of finding 5.
--   The trigger now covers it either way, but confirm what exists.
--
-- webhook_keys — these are bearer credentials for lead intake. A counsellor
--   who can read one keeps an unauthenticated write channel into the CRM after
--   being disabled; RLS revocation does not revoke a copied token. Restrict to
--   org_admin and add rotation.
