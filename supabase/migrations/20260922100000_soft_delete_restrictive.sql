-- AbroBot CRM — make "archived means hidden" impossible to out-vote.
--
-- ════════════════════════════════════════════════════════════════════════════
-- Correcting yesterday's diagnosis
-- ════════════════════════════════════════════════════════════════════════════
-- 20260922090000 assumed leads_read had been replaced by something without the
-- deleted_at predicate. It had not. check_soft_delete_rls() proved it:
--
--   activities.activities_read              -> filters
--   conversations.conversations_read        -> filters
--   leads.leads_read                        -> filters
--   conversations.conversations_org         -> DOES NOT FILTER
--   conversations.super_read_conversations  -> DOES NOT FILTER
--   leads.super_all_leads                   -> DOES NOT FILTER
--
-- leads_read was correct the whole time. The rule was not overwritten — it was
-- OUT-VOTED.
--
-- PostgreSQL combines PERMISSIVE policies with OR. A row is visible if ANY of
-- them allows it. So leads_read saying "deleted_at is null AND you're a member"
-- does nothing while super_all_leads sits beside it saying "you're a super
-- admin" with no such condition. Every super admin has been seeing archived
-- records in the Students list; that is why I saw the test record there and an
-- ordinary counsellor would not have.
--
-- The three offenders are defined in NO migration in this repo. They are
-- legacy policies created in the dashboard before the migration history began,
-- which is exactly why reading the migrations made everything look right.
--
-- The lesson worth keeping: tightening one permissive policy is not a security
-- fix. It can only ever remove a grant that some other policy may still be
-- making. Yesterday's migration re-asserted three policies that were already
-- correct and changed nothing observable.
--
-- ════════════════════════════════════════════════════════════════════════════
-- The fix
-- ════════════════════════════════════════════════════════════════════════════
-- A RESTRICTIVE policy. Restrictive policies are combined with AND, after the
-- permissive ones are OR-ed together, so this cannot be out-voted by any
-- policy that exists today or is added tomorrow — including one someone
-- creates in the dashboard, which is how this happened in the first place.
--
-- One line per table, expressing the invariant directly: an archived row is
-- never selectable. It does not matter who you are.
--
-- SELECT only, deliberately:
--   * archive_lead / restore_lead / archived_leads are all SECURITY DEFINER,
--     so the Archived screen and the way back both keep working — verified,
--     not assumed, in 20260903150000.
--   * service_role has BYPASSRLS, so edge functions are untouched.
--   * Restricting UPDATE would break restore for anything that ever stops
--     going through the SECURITY DEFINER path.

begin;

drop policy if exists leads_hide_archived on public.leads;
create policy leads_hide_archived on public.leads
  as restrictive
  for select
  using (deleted_at is null);

drop policy if exists activities_hide_archived on public.activities;
create policy activities_hide_archived on public.activities
  as restrictive
  for select
  using (deleted_at is null);

drop policy if exists conversations_hide_archived on public.conversations;
create policy conversations_hide_archived on public.conversations
  as restrictive
  for select
  using (deleted_at is null);

-- ── Teach the checker about permissiveness ──────────────────────────────────
-- Yesterday's version reported per-policy whether the predicate was present,
-- which made three correct policies look like the answer and buried the three
-- that mattered in the same list. What actually determines visibility is
-- whether a RESTRICTIVE policy pins it down — so report that, and report the
-- permissive ones as context rather than as a verdict.
--
-- DROP first. `create or replace` cannot change a function's return type, and
-- this adds a `kind` column to the OUT record:
--
--   ERROR: 42P13: cannot change return type of existing function
--
-- Worth spelling out because of where it left things: every statement here is
-- inside one transaction, so that error rolled the whole migration back. The
-- three restrictive policies below were never created and nothing changed —
-- which is the right outcome for a failed migration, but only obvious if you
-- know the BEGIN is there.
drop function if exists public.check_soft_delete_rls();

create function public.check_soft_delete_rls()
returns table (
  table_name   text,
  policy_name  text,
  kind         text,
  filters_deleted boolean,
  expression   text
)
language sql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $$
  select c.relname::text,
         p.polname::text,
         case when p.polpermissive then 'permissive' else 'RESTRICTIVE' end,
         pg_get_expr(p.polqual, p.polrelid) like '%deleted_at IS NULL%',
         left(pg_get_expr(p.polqual, p.polrelid), 160)
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('leads', 'activities', 'conversations')
     and p.polcmd in ('r', '*')
   order by c.relname, p.polpermissive, p.polname;
$$;

comment on function public.check_soft_delete_rls is
  'Reports the SELECT policies on leads/activities/conversations and whether a RESTRICTIVE one pins deleted_at IS NULL. A permissive policy carrying the predicate proves nothing: permissive policies are OR-ed, so any one of them without it makes archived rows visible. That is what happened — leads_read was correct and super_all_leads out-voted it.';

revoke all on function public.check_soft_delete_rls() from public, anon, authenticated;
grant execute on function public.check_soft_delete_rls() to service_role;

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- Verify
-- ════════════════════════════════════════════════════════════════════════════
select * from (
  select 1 as ord, 'a RESTRICTIVE policy guards each table' as check,
         case when (select count(*) from public.check_soft_delete_rls()
                     where kind = 'RESTRICTIVE' and filters_deleted) = 3
              then 'PASS — leads, activities and conversations are all pinned'
              else 'FAIL — only ' || (select count(*) from public.check_soft_delete_rls()
                                       where kind = 'RESTRICTIVE' and filters_deleted)
                   || ' of 3 tables have one'
         end as detail

  union all
  select 2, 'the three that were out-voting the rule',
         coalesce((select string_agg(table_name || '.' || policy_name, ', ' order by policy_name)
                     from public.check_soft_delete_rls()
                    where kind = 'permissive' and not filters_deleted),
                  'none')
         || ' — still permissive and still without the predicate, which is now harmless'

  union all
  select 3, 'full policy picture',
         (select string_agg(table_name || '.' || policy_name || ' [' || kind || ']', '; '
                            order by table_name, kind desc, policy_name)
            from public.check_soft_delete_rls())

  union all
  -- The number that actually answers the question. This counts the way the
  -- Students screen counts: through RLS, as the signed-in user.
  select 4, 'archived rows still reachable by SELECT',
         (select count(*)::text from public.leads where deleted_at is not null)
         || ' archived lead(s) exist in the table. Reload Students: it showed 22, '
         || 'it should now show 21.'
) t order by ord;

-- ── After running this ──────────────────────────────────────────────────────
-- Hard-reload crm.mnbresearch.com/leads. "22 total" should become "21", and
-- the ZZ TEST record should be gone from Students while remaining in Archived.
--
-- If it still shows 22, that is a stale client cache, not this policy — the
-- count comes from a `head: true` request the store caches.
