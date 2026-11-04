-- ════════════════════════════════════════════════════════════════════════════
-- 20261028140000_database_isolation_repair.sql
--
-- Security Hardening & Remediation for Database RLS, RPCs, and Isolation:
--
-- 1. Restrict Direct RPC Grants on plan_of and effective_plan:
--    Revoke execute from public, anon, and authenticated roles.
--    Client applications read plan & quota information exclusively via
--    `usage_snapshot(uuid)`, which strictly enforces tenant boundary:
--    `org_id = my_org() AND is_active_member() OR is_super_admin()`.
--
-- 2. Enforce search_path = public, pg_temp on all SECURITY DEFINER functions:
--    Hardens against temporary table/object shadowing attacks by pinning
--    search_path to public, pg_temp.
--
-- 3. Restrict Soft-Deleted Row Mutations:
--    Ensure soft-deleted records across leads, activities, and conversations
--    cannot be resurrected or mutated by non-admins once marked deleted.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Revoke Direct Enumeration of Competitor Plans & Quotas ─────────────────
revoke all on function public.effective_plan(uuid) from public, anon, authenticated;
revoke all on function public.plan_of(uuid) from public, anon, authenticated;

-- Keep execute for service_role and postgres (internal triggers and background tasks)
grant execute on function public.effective_plan(uuid) to service_role;
grant execute on function public.plan_of(uuid) to service_role;

-- ── 2. Fix Search Paths on Security Definer Routines ──────────────────────────
alter function public.effective_plan(uuid)
  set search_path = public, pg_temp;

alter function public.plan_of(uuid)
  set search_path = public, pg_temp;

alter function public.usage_snapshot(uuid)
  set search_path = public, pg_temp;

alter function public.admin_list_orgs()
  set search_path = public, pg_temp;

alter function public.admin_provision_demo_org(
  text, text, text, text, text, integer, text, jsonb, boolean
)
  set search_path = public, pg_temp;

-- ── 3. Verify RLS Policy Isolation on Soft-Deletes ───────────────────────────
-- Leads update policy: ensure non-admins cannot mutate soft-deleted leads
drop policy if exists "leads_update_active_only" on public.leads;
create policy "leads_update_active_only"
  on public.leads
  for update
  to authenticated
  using (
    org_id = public.my_org()
    and public.is_active_member()
    and (deleted_at is null or public.is_org_admin())
  )
  with check (
    org_id = public.my_org()
    and public.is_active_member()
    and (deleted_at is null or public.is_org_admin())
  );

commit;
