-- AbroBot CRM — make "your org only" impossible to out-vote, the same way
-- "archived means hidden" was made impossible to out-vote on 22 September.
--
-- ════════════════════════════════════════════════════════════════════════════
-- The half-fix that 20260922100000 left behind
-- ════════════════════════════════════════════════════════════════════════════
-- That migration got the mechanism exactly right and the scope too narrow.
-- Its three restrictive policies pin one predicate:
--
--   leads_hide_archived         as restrictive for select using (deleted_at is null)
--   activities_hide_archived    as restrictive for select using (deleted_at is null)
--   conversations_hide_archived as restrictive for select using (deleted_at is null)
--
-- So archived rows are now genuinely hidden from everyone. But the other half
-- of every one of those policies —
--
--   public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
--
-- — still lives ONLY in permissive policies. And the whole reason that file was
-- written is that we now have proof, not suspicion, that undocumented
-- permissive policies exist on these exact tables:
--
--   conversations.conversations_org         created in the dashboard
--   conversations.super_read_conversations  created in the dashboard
--   leads.super_all_leads                   created in the dashboard
--
-- None of the three appears in any migration. We know what they do NOT contain
-- (deleted_at is null — check_soft_delete_rls() proved that). We do not know
-- what they DO contain, and the same catalog that hid them from us for weeks is
-- the one that decides what org_id a row has to have to be visible.
--
-- PostgreSQL combines permissive policies with OR. So the tenant boundary
-- currently holds only for as long as EVERY permissive policy on EVERY tenant
-- table happens to carry an org test — including the ones nobody has read, and
-- including the next one somebody creates in the dashboard at 2am. That is not
-- an isolation guarantee, it is a streak.
--
-- The generalised lesson from 09-22, stated once so it does not have to be
-- rediscovered a third time: TIGHTENING A PERMISSIVE POLICY IS NOT A SECURITY
-- FIX. A permissive policy can only ever hand out access. The only way to take
-- access away in a way that cannot be voted down is a RESTRICTIVE policy,
-- because restrictive policies are AND-ed on after the permissive ones have
-- been OR-ed together — so they also bind policies that do not exist yet.
--
-- ════════════════════════════════════════════════════════════════════════════
-- for all, not for select — and why the 09-22 reasoning does not carry over
-- ════════════════════════════════════════════════════════════════════════════
-- 20260922100000 chose SELECT only, for a good reason that is specific to it:
-- the archive/restore path legitimately has to UPDATE a row it is not allowed
-- to SELECT, so restricting UPDATE there would break the way back out of the
-- archive.
--
-- Tenant isolation has no such exception. There is no legitimate path in this
-- product where a member writes to another organisation's row, and cross-tenant
-- WRITE is strictly worse than cross-tenant read: one shows a customer data
-- that is not theirs, the other lets them change or delete it, silently, with
-- the record's own org still pointing elsewhere.
--
-- So: `for all`, with the predicate spelled out in both USING and WITH CHECK.
-- Spelled out rather than left to default, for the reason 20260903120000 gives
-- on leads_update: without an explicit WITH CHECK, nothing stops a member
-- setting org_id to another organisation on UPDATE and moving a record out of
-- their own tenant.
--
-- What makes this safe to apply to writes: the predicate is character-for-
-- character the one the existing permissive write policies already use
-- (leads_insert, leads_update, invites_write, api_keys_admin, …). A restrictive
-- policy can only remove access that some permissive policy is granting, so the
-- only writes this can break are writes that are being allowed by a predicate
-- DIFFERENT from the documented one — which is precisely the thing we are here
-- to stop, and precisely the thing we cannot enumerate from the repo. That is
-- why the verify block prints every permissive policy on these tables that does
-- not mention my_org, rather than asserting there are none.
--
-- ── Why is_active_member() and not is_org_admin() ──────────────────────────
-- Some of the permissive write policies are stricter than this: api_keys_admin,
-- webhook_endpoints_admin, invites_write, field_defs_write, pipeline_stages_write
-- and leads_delete all require is_org_admin(). A restrictive policy is AND-ed
-- with them, so the weaker predicate here cannot loosen any of those — an
-- org_admin is by definition an active member, so every access those policies
-- grant still satisfies this one. Using is_org_admin() here instead would
-- quietly extend admin-only to tables where ordinary members are supposed to
-- write, which is a product change smuggled in as a security fix.
--
-- ── One assumption this rests on, stated so it can be checked ───────────────
-- That no covered table stores shared rows with org_id IS NULL. `org_id = my_org()`
-- is NULL, not true, for such a row, so a restrictive policy would make it
-- invisible to everyone. pipeline_stages and field_defs both declare org_id NOT
-- NULL, which settles them; the legacy tables (leads, activities, conversations,
-- agent_config, message_templates, webhook_keys) declare nothing this repo can
-- read. The loop below checks each table for a NULL org_id row before creating
-- its policy and refuses to create one where it finds any, rather than
-- discovering it from a support ticket.
--
-- Two roles are unaffected, both deliberately:
--
--   service_role  has BYPASSRLS. Every edge function — lead-webhook,
--                 chat-agent, run-automations, nurture, the public API — goes
--                 through it and is untouched by this file. Verified the same
--                 way 09-22 verified it: BYPASSRLS is a role attribute, not a
--                 policy, so no policy can affect it.
--   table owners  SECURITY DEFINER functions (archive_lead, restore_lead,
--                 accept_invite, create_organisation, fire_webhooks, …) run as
--                 the owner, and owners are exempt from RLS unless FORCE ROW
--                 LEVEL SECURITY is set, which it is not. So the signup and
--                 invite-acceptance paths — where the caller legitimately has
--                 no org yet and my_org() is NULL — keep working.
--
-- ════════════════════════════════════════════════════════════════════════════
-- What this file does NOT do
-- ════════════════════════════════════════════════════════════════════════════
--   * It does not enable RLS anywhere. A restrictive policy on a table with RLS
--     switched off is decoration — it is never evaluated. Some of these tables
--     predate the migration history and I cannot read their relrowsecurity from
--     here, so the verify block REPORTS it per table and FAILS if any covered
--     table has RLS off. Turning it on is a one-line change with a real chance
--     of locking a screen out, so it is a decision, not a side effect.
--   * It does not touch conversations_org, super_read_conversations or
--     super_all_leads. They are permissive; after this they cannot grant
--     anything across a tenant boundary, so they are harmless where they are.
--     Dropping objects nobody has read is how you find out what depended on
--     them.
--   * It does not cover tables scoped through a parent row rather than an
--     org_id column — chat_messages via conversation_id is the likely one. A
--     column that is not there cannot be tested, and inventing a join into a
--     restrictive policy on a hot table is a performance decision that needs
--     measuring. The verify block names every table skipped and why, so the gap
--     is visible rather than assumed closed.
--   * It deletes nothing and adds no columns.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. One restrictive policy per tenant table
-- ════════════════════════════════════════════════════════════════════════════
-- Driven from a list in a loop rather than fifteen copies of the same four
-- lines, because the predicate MUST be identical on every table. Fifteen
-- hand-written copies is fifteen chances to leave one out, and the one left out
-- is the one that matters.
--
-- Each table is gated twice before it gets a policy:
--
--   to_regclass('public.<t>') is not null   the table exists here
--   information_schema.columns has org_id   and carries the column
--
-- Both are necessary because this list is written from the repo and the repo is
-- demonstrably not a complete description of the database — which is the
-- premise of the whole 24 September batch. A missing table must skip and say
-- so, not abort the migration.

do $iso$
declare
  tenant_tables text[] := array[
    'leads', 'activities', 'conversations', 'chat_messages',
    'message_templates', 'webhook_keys', 'agent_config',
    'automations', 'automation_runs',
    'api_keys', 'webhook_endpoints', 'webhook_deliveries',
    'field_defs', 'pipeline_stages', 'invites'
  ];
  t          text;
  polname    text;
  v_has_null boolean;
  v_done     text[] := '{}';
  v_skipped  text[] := '{}';
begin
  foreach t in array tenant_tables loop
    if to_regclass('public.' || quote_ident(t)) is null then
      v_skipped := v_skipped || (t || ' [no such table]');
      continue;
    end if;

    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public'
                      and table_name   = t
                      and column_name  = 'org_id') then
      v_skipped := v_skipped || (t || ' [no org_id column — scoped through a parent row; NOT covered]');
      continue;
    end if;

    -- A row with org_id IS NULL would become invisible to every role, because
    -- `NULL = my_org()` is NULL and a restrictive policy needs true. EXISTS,
    -- not COUNT: it stops at the first match, so this stays cheap on leads.
    execute format('select exists (select 1 from public.%I where org_id is null)', t)
       into v_has_null;

    if v_has_null then
      v_skipped := v_skipped ||
        (t || ' [HAS ROWS WITH org_id IS NULL — a restrictive org policy would hide them from everyone; assign them an org first]');
      continue;
    end if;

    polname := t || '_tenant_isolation';

    -- There is no CREATE OR REPLACE POLICY in PostgreSQL, so re-runnability
    -- costs a drop. It drops a policy this same statement immediately
    -- recreates, inside one transaction — the pattern 20260922100000 and
    -- 20260922090000 both use. Nothing is ever left without it.
    execute format('drop policy if exists %I on public.%I', polname, t);

    execute format($pol$
      create policy %I on public.%I
        as restrictive
        for all
        using (
          public.is_super_admin()
          or (org_id = public.my_org() and public.is_active_member())
        )
        with check (
          public.is_super_admin()
          or (org_id = public.my_org() and public.is_active_member())
        )
    $pol$, polname, t);

    v_done := v_done || t;
  end loop;

  raise notice '[tenant isolation] covered % table(s): %',
    coalesce(array_length(v_done, 1), 0), array_to_string(v_done, ', ');

  if coalesce(array_length(v_skipped, 1), 0) > 0 then
    raise warning '[tenant isolation] SKIPPED: %', array_to_string(v_skipped, '; ');
  end if;

  if coalesce(array_length(v_done, 1), 0) = 0 then
    raise exception
      'no tenant table was covered — that cannot be right, and committing it would report success for a migration that did nothing';
  end if;
end
$iso$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. A checker, so this is auditable next month without reading this file
-- ════════════════════════════════════════════════════════════════════════════
-- Same shape and same lesson as check_soft_delete_rls() in 20260922100000:
-- report whether a RESTRICTIVE policy pins the rule, and report the permissive
-- ones as CONTEXT rather than as a verdict. Yesterday's version of that
-- function made three correct permissive policies look like the answer; this
-- one cannot, because it labels every row with its permissiveness.
--
-- DROP first even though nothing of this name exists yet: if a later migration
-- ever adds a column to the OUT record, `create or replace` raises 42P13 and
-- takes the whole transaction with it. Cheaper to establish the habit now than
-- to rediscover it. (20260922100000 rediscovered it.)
drop function if exists public.check_tenant_isolation();

create function public.check_tenant_isolation()
returns table (
  table_name    text,
  rls_enabled   boolean,
  policy_name   text,
  kind          text,
  cmd           text,
  filters_org   boolean,
  expression    text
)
language sql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $$
  select c.relname::text,
         c.relrowsecurity,
         p.polname::text,
         case when p.polpermissive then 'permissive' else 'RESTRICTIVE' end,
         case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                       when 'w' then 'UPDATE' when 'd' then 'DELETE'
                       else 'ALL' end,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '')
         || ' ' ||
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%my_org()%',
         left(coalesce(pg_get_expr(p.polqual, p.polrelid), '(no using)'), 200)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_policy p on p.polrelid = c.oid
   where n.nspname = 'public'
     -- 'r' only. pg_class holds indexes and sequences too, and an index named
     -- after its table would otherwise show up as a table with no policies.
     and c.relkind = 'r'
     and c.relname in ('leads','activities','conversations','chat_messages',
                       'message_templates','webhook_keys','agent_config',
                       'automations','automation_runs','api_keys',
                       'webhook_endpoints','webhook_deliveries',
                       'field_defs','pipeline_stages','invites')
   order by c.relname, p.polpermissive, p.polname;
$$;

comment on function public.check_tenant_isolation() is
  'Every policy on every tenant table, labelled permissive or RESTRICTIVE, with whether it mentions my_org(). A permissive policy carrying the org test proves nothing — permissive policies are OR-ed, so one without it is enough to cross the tenant boundary. Only the RESTRICTIVE rows are load-bearing. Also reports relrowsecurity, because a restrictive policy on a table with RLS off is never evaluated.';

revoke all on function public.check_tenant_isolation() from public, anon, authenticated;
grant execute on function public.check_tenant_isolation() to service_role;

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- Verify
-- ════════════════════════════════════════════════════════════════════════════
-- Rows 1–2 are PASS/FAIL. Rows 3–6 report live state that the repo cannot
-- know, and row 4 is the one to actually read: it lists the permissive policies
-- whose grant has just been narrowed. If a screen breaks after this migration,
-- the cause is in row 4.

select * from (

  -- 1. Every tenant table that exists and has org_id now has a restrictive
  --    policy carrying the org test.
  select 1 as ord,
         'a RESTRICTIVE policy pins org_id on every eligible table' as check,
         case when (
                select count(*) from (
                  select distinct table_name from public.check_tenant_isolation()
                   where kind = 'RESTRICTIVE' and filters_org
                ) x
              ) = (
                select count(*) from information_schema.columns
                 where table_schema = 'public' and column_name = 'org_id'
                   and table_name in ('leads','activities','conversations','chat_messages',
                                      'message_templates','webhook_keys','agent_config',
                                      'automations','automation_runs','api_keys',
                                      'webhook_endpoints','webhook_deliveries',
                                      'field_defs','pipeline_stages','invites')
              )
              then 'PASS — ' || (select count(*)::text from (
                     select distinct table_name from public.check_tenant_isolation()
                      where kind = 'RESTRICTIVE' and filters_org) x)
                   || ' of ' || (select count(*)::text from information_schema.columns
                                  where table_schema = 'public' and column_name = 'org_id'
                                    and table_name in ('leads','activities','conversations','chat_messages',
                                                       'message_templates','webhook_keys','agent_config',
                                                       'automations','automation_runs','api_keys',
                                                       'webhook_endpoints','webhook_deliveries',
                                                       'field_defs','pipeline_stages','invites'))
                   || ' eligible tables pinned'
              else 'FAIL — ' || (select count(*)::text from (
                     select distinct table_name from public.check_tenant_isolation()
                      where kind = 'RESTRICTIVE' and filters_org) x)
                   || ' pinned of ' || (select count(*)::text from information_schema.columns
                                         where table_schema = 'public' and column_name = 'org_id'
                                           and table_name in ('leads','activities','conversations','chat_messages',
                                                              'message_templates','webhook_keys','agent_config',
                                                              'automations','automation_runs','api_keys',
                                                              'webhook_endpoints','webhook_deliveries',
                                                              'field_defs','pipeline_stages','invites'))
                   || ' eligible — row 5 says which and why'
         end as detail

  -- 2. RLS is actually on where we just put a policy. If it is off, the policy
  --    is never evaluated and this migration achieved nothing on that table —
  --    which is exactly the sort of silent nothing 20260922090000 produced.
  union all
  select 2, 'RLS is enabled on every covered table',
         coalesce((
           select 'FAIL — RLS is OFF on: ' || string_agg(distinct table_name, ', ')
                  || '. The restrictive policy there is never evaluated. Fix with: '
                  || 'alter table public.<t> enable row level security; '
                  || '— check that table''s screens first, because enabling RLS on a table with no permissive policy denies everything.'
             from public.check_tenant_isolation()
            where kind = 'RESTRICTIVE' and filters_org and not rls_enabled),
           'PASS — RLS on for every table that got a policy')

  -- 3. ── LIVE STATE ─────────────────────────────────────────────────────────
  --    The three dashboard policies 09-22 identified. Reported, not assumed:
  --    if this says "absent", someone removed them since 22 September.
  union all
  select 3, 'the dashboard policies from the 09-22 incident',
         coalesce((
           select string_agg(table_name || '.' || policy_name || ' [' || kind || ' ' || cmd || ']',
                             ', ' order by table_name, policy_name)
             from public.check_tenant_isolation()
            where policy_name in ('conversations_org','super_read_conversations','super_all_leads')),
           'none of the three are present any more — worth knowing, they were there on 22 September')

  -- 4. THE ROW TO READ. Every permissive policy that grants rows without an
  --    org test. Before this migration each one was a hole; after it each one
  --    is narrowed, and if something that used to work stops working, it is
  --    because it was relying on one of these.
  union all
  select 4, 'permissive policies with NO org test (narrowed by this migration)',
         coalesce((
           select string_agg(table_name || '.' || policy_name || ' [' || cmd || '] ' || expression,
                             '  |  ' order by table_name, policy_name)
             from public.check_tenant_isolation()
            where kind = 'permissive' and not filters_org),
           'none — every permissive policy already carried the org test, so this migration is pure insurance')

  -- 5. Tables named in this file that could not be covered, and why. This is
  --    where a table skipped for holding org_id IS NULL rows shows up — the
  --    gap is real and it is not closed by pretending the list was shorter.
  union all
  select 5, 'tables NOT covered (the remaining gap)',
         coalesce((
           select string_agg(u.t || ' [' || r.reason || ']', ',  ' order by u.t)
             from unnest(array['leads','activities','conversations','chat_messages',
                               'message_templates','webhook_keys','agent_config',
                               'automations','automation_runs','api_keys',
                               'webhook_endpoints','webhook_deliveries',
                               'field_defs','pipeline_stages','invites']) as u(t)
             cross join lateral (
               select case
                        when to_regclass('public.' || quote_ident(u.t)) is null
                          then 'table does not exist here'
                        when not exists (select 1 from information_schema.columns
                                          where table_schema = 'public' and table_name = u.t
                                            and column_name = 'org_id')
                          then 'no org_id column — scoped through a parent row'
                        when not exists (select 1 from public.check_tenant_isolation() ci
                                          where ci.table_name = u.t
                                            and ci.kind = 'RESTRICTIVE' and ci.filters_org)
                          then 'has org_id but NO restrictive policy — it holds rows with org_id IS NULL, which a restrictive org test would hide from everyone. Give those rows an org, then re-run this migration.'
                        else null
                      end as reason
             ) r
            where r.reason is not null),
           'none — every table in the list is covered')

  -- 6. The full picture, for the next person.
  union all
  select 6, 'full policy inventory',
         coalesce((
           select string_agg(table_name || '.' || coalesce(policy_name, '(NO POLICIES AT ALL)')
                             || ' [' || coalesce(kind, '-') || ']',
                             '; ' order by table_name, kind desc nulls last, policy_name)
             from public.check_tenant_isolation()), '(nothing)')

) t order by ord;

-- ── After running this ──────────────────────────────────────────────────────
-- Smoke-test as a real signed-in counsellor, not as service_role (which
-- bypasses all of this and will tell you everything is fine):
--
--   * the Students list still loads and still shows the same count
--   * creating a lead still works
--   * editing a lead still works
--   * Settings → Integrations still lists webhook endpoints
--   * a super admin can still see across organisations
--
-- And the thing this was written for, which needs two accounts in two orgs:
--
--   select count(*) from public.leads where org_id = '<the other org>';
--   -- expect 0 for a counsellor, whatever it really is for a super admin
--
-- To undo one table without undoing the rest:
--   drop policy if exists leads_tenant_isolation on public.leads;
