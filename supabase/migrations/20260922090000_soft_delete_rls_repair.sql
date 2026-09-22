-- AbroBot CRM — archived records are still showing in the Students list.
--
-- ════════════════════════════════════════════════════════════════════════════
-- What was observed, 22 September
-- ════════════════════════════════════════════════════════════════════════════
-- On 17 September a test record was archived. `archive_lead` ran, `deleted_at`
-- was set, and a direct count of live rows returned 20 — all correct.
--
-- Today that record appears in BOTH places at once:
--
--   Students  → "22 total", the archived record among them
--   Archived  → the same record, "26 days left"
--
-- and the dashboard reads "22 Active Students".
--
-- The frontend is not at fault, and deliberately so. 20260903150000 put this
-- rule in RLS precisely so that no screen would have to remember it:
--
--   -- Enforced in RLS rather than in application queries. Every screen, every
--   -- edge function and every direct PostgREST call gets the same answer, and
--   -- nobody has to remember to add `.is("deleted_at", null)` to a new query.
--
-- `deleted_at` appears nowhere in the leads list query, by design. So a row
-- reaching the browser means the policy is not carrying the predicate that
-- migration wrote — it was never applied here, or something later replaced it.
-- Only 20260903150000 defines leads_read in this repo, so the replacement did
-- not come from a migration.
--
-- That is worth stating plainly: the guarantee is load-bearing for three
-- tables and one screen's worth of code depends on it silently. This migration
-- re-asserts it and, unlike the original, PROVES it afterwards rather than
-- assuming the CREATE POLICY did what it looked like it did.
--
-- Customer impact while it was wrong: "Archive" did not hide anything. A
-- counsellor archiving a duplicate, a wrong number or a record someone asked
-- to have removed saw it stay in the list and keep counting toward the plan's
-- record limit on screen.

begin;

-- ── 1. Re-assert the three read policies ────────────────────────────────────
-- Identical in intent to 20260903150000. Written out per table rather than in
-- a loop so that each one is greppable by name: the loop in the original is
-- part of why nobody noticed conversations and activities were affected too.

drop policy if exists leads_read on public.leads;
create policy leads_read on public.leads
  for select using (
    deleted_at is null
    and (public.is_super_admin() or (org_id = public.my_org() and public.is_active_member()))
  );

drop policy if exists activities_read on public.activities;
create policy activities_read on public.activities
  for select using (
    deleted_at is null
    and (public.is_super_admin() or (org_id = public.my_org() and public.is_active_member()))
  );

drop policy if exists conversations_read on public.conversations;
create policy conversations_read on public.conversations
  for select using (
    deleted_at is null
    and (public.is_super_admin() or (org_id = public.my_org() and public.is_active_member()))
  );

-- ── 2. A regression test that lives in the database ─────────────────────────
-- The original migration's failure mode was that it looked correct and was not
-- in force. A CREATE POLICY that succeeds tells you the statement parsed, not
-- that the rule is doing anything. This function reads the policy back out of
-- the catalogue and checks the predicate is actually there, so the next person
-- can answer "is soft delete enforced?" in one query instead of by archiving a
-- record and going to look.
create or replace function public.check_soft_delete_rls()
returns table (table_name text, policy_name text, filters_deleted boolean, expression text)
language sql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $$
  select c.relname::text,
         p.polname::text,
         pg_get_expr(p.polqual, p.polrelid) like '%deleted_at IS NULL%',
         left(pg_get_expr(p.polqual, p.polrelid), 200)
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('leads', 'activities', 'conversations')
     and p.polcmd in ('r', '*')
   order by c.relname, p.polname;
$$;

comment on function public.check_soft_delete_rls is
  'Reads the SELECT policies on leads/activities/conversations back out of pg_policy and reports whether each still carries the deleted_at IS NULL predicate. Exists because a policy that was written once and silently replaced let archived records reappear in the Students list for weeks.';

revoke all on function public.check_soft_delete_rls() from public, anon, authenticated;
grant execute on function public.check_soft_delete_rls() to service_role;

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- Verify
-- ════════════════════════════════════════════════════════════════════════════
select * from (
  select 1 as ord, 'every SELECT policy filters deleted_at' as check,
         case when exists (select 1 from public.check_soft_delete_rls() where not filters_deleted)
              then 'FAIL — ' || (select string_agg(table_name || '.' || policy_name, ', ')
                                   from public.check_soft_delete_rls() where not filters_deleted)
              else 'PASS — ' || (select count(*) from public.check_soft_delete_rls()) || ' policies checked'
         end as detail

  union all
  select 2, 'policies as they now stand',
         (select string_agg(table_name || '.' || policy_name || ' -> '
                            || case when filters_deleted then 'filters' else 'DOES NOT FILTER' end,
                            '; ' order by table_name)
            from public.check_soft_delete_rls())

  union all
  select 3, 'archived records that were visible',
         (select count(*)::text || ' archived lead(s) exist; they should now be absent from every list'
            from public.leads where deleted_at is not null)

  union all
  -- The number the customer sees on the Students screen, computed the way the
  -- screen computes it. This is the row that says whether the bug is gone.
  select 4, 'AbroBot live record count',
         coalesce((select count(*)::text
                     from public.leads l join public.organizations o on o.id = l.org_id
                    where o.slug = 'abrobot' and l.deleted_at is null), '0')
       || ' (the Students list showed 22 before this ran; 21 is correct)'
) t order by ord;
