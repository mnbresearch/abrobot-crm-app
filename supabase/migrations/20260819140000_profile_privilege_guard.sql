-- AbroBot CRM — close privilege escalation and tenant escape on profiles,
-- and enforce the plan's seat limit.
--
-- ── The problem ─────────────────────────────────────────────────────────────
-- Observed policies on public.profiles:
--
--   prof_own_update       UPDATE  using (id = auth.uid())            with_check NULL
--   prof_org_admin_update UPDATE  using (org_id = my_org()
--                                        and my_role() = 'org_admin'
--                                        and is_active_member())      with_check NULL
--
-- In Postgres, an UPDATE policy with no WITH CHECK reuses its USING expression
-- as the check. So the only thing prof_own_update guarantees about the NEW row
-- is that it still belongs to the same user. Nothing constrains role, status
-- or org_id. That yields two live holes:
--
--   1. PRIVILEGE ESCALATION
--      update profiles set role = 'super_admin' where id = auth.uid();
--      A counsellor grants themselves platform-wide access.
--
--   2. TENANT ESCAPE  (the more serious of the two)
--      update profiles set org_id = '<other org uuid>' where id = auth.uid();
--      my_org() reads that column, so every org-scoped policy in the database
--      now resolves to the victim organisation. One UPDATE and the tenant
--      boundary is gone — leads, conversations, chat messages, all of it.
--
--   prof_org_admin_update has the same shape: my_role() evaluates the CALLER,
--   never the row, so an org_admin can set another member's role to
--   'super_admin' and escalate beyond their own organisation.
--
-- ── Why a trigger and not better policies ───────────────────────────────────
-- WITH CHECK cannot reference OLD. "role may not change unless the caller is
-- an admin" is a statement about a transition, not about a row, so it cannot
-- be expressed as a row predicate. A BEFORE UPDATE trigger is the correct
-- tool. RLS still decides WHICH rows are visible and updatable; this decides
-- WHICH TRANSITIONS are legal.
--
-- Existing policies are left in place — this is additive and reversible.

begin;

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
  -- Those already hold full trust; guarding them would break lead intake.
  if caller_id is null then
    return new;
  end if;

  select role into caller_role from public.profiles where id = caller_id;

  -- ── organisation membership ──────────────────────────────────────────────
  -- The tenant escape. Only a super admin may move an account between orgs.
  if new.org_id is distinct from old.org_id
     and coalesce(caller_role, 'counsellor'::public.user_role) <> 'super_admin' then
    raise exception 'Only a super admin can move a member to another organisation'
      using errcode = '42501';
  end if;

  -- ── role ─────────────────────────────────────────────────────────────────
  if new.role is distinct from old.role then
    if caller_role = 'super_admin' then
      null;  -- super admins may set any role

    elsif caller_role = 'org_admin' then
      -- An org admin runs one organisation. Granting super_admin would hand
      -- out access to every other organisation on the platform.
      if new.role = 'super_admin' then
        raise exception 'Only a super admin can grant super admin'
          using errcode = '42501';
      end if;
      -- Self-promotion is the escalation path even when the target role looks
      -- harmless, so an admin cannot edit their own role at all.
      if new.id = caller_id then
        raise exception 'You cannot change your own role. Ask a super admin.'
          using errcode = '42501';
      end if;

    else
      raise exception 'Only an admin can change roles'
        using errcode = '42501';
    end if;
  end if;

  -- ── access status ────────────────────────────────────────────────────────
  if new.status is distinct from old.status then
    if coalesce(caller_role, 'counsellor'::public.user_role)
       not in ('org_admin'::public.user_role, 'super_admin'::public.user_role) then
      raise exception 'Only an admin can change access'
        using errcode = '42501';
    end if;
  end if;

  -- ── seat limit ───────────────────────────────────────────────────────────
  -- Enforced here rather than in the browser, for the same reason as AI
  -- credits: a limit the client applies is not a limit.
  if new.status = 'active'::public.member_status
     and old.status is distinct from 'active'::public.member_status then

    select pl.max_seats into seat_cap
      from public.organizations o
      join public.plan_limits pl on pl.plan = o.plan
     where o.id = new.org_id;

    if seat_cap is not null then
      select count(*) into active_now
        from public.profiles
       where org_id = new.org_id
         and status = 'active'::public.member_status
         and id <> new.id;

      if active_now + 1 > seat_cap then
        raise exception
          'Seat limit reached: this plan allows % active member(s). Upgrade to add more.',
          seat_cap using errcode = 'P0001';
      end if;
    end if;
  end if;

  return new;
end;
$$;

comment on function public.guard_profile_changes() is
  'Blocks privilege escalation and cross-org moves on profiles, and enforces plan seat limits. RLS decides which rows are updatable; this decides which transitions are legal.';

drop trigger if exists trg_guard_profile_changes on public.profiles;
create trigger trg_guard_profile_changes
  before update on public.profiles
  for each row execute function public.guard_profile_changes();

commit;


-- ── Verify ──────────────────────────────────────────────────────────────────
-- Run these as a NON-super-admin (e.g. from the app while signed in as a
-- counsellor). Each should fail with "permission denied"-style errors:
--
--   update profiles set role   = 'super_admin' where id = auth.uid();
--   update profiles set org_id = '00000000-0000-0000-0000-000000000000'
--    where id = auth.uid();
--   update profiles set status = 'active' where id = auth.uid();
--
-- And this should still work (a counsellor editing their own name):
--
--   update profiles set full_name = 'New Name' where id = auth.uid();
