-- AbroBot CRM — make destroying a tenant a deliberate act, and stop financial
-- records going with it.
--
-- ── What the audit found ────────────────────────────────────────────────────
-- `org_super_all` — `FOR ALL using (is_super_admin())` — predates every
-- migration and appears in no file. It is the reason the verify block reported
-- "a delete path exists".
--
-- The reassuring half: only a SUPER ADMIN is covered by it. A customer's own
-- org_admin cannot delete their organisation, which was the outcome worth
-- being afraid of.
--
-- The half still worth fixing: it is FOR ALL, so DELETE is available to the
-- platform owner through PostgREST — from the browser, from a script, from a
-- mistyped `curl`. And a single DELETE on one row cascades through NINETEEN
-- tables: leads, activities, conversations, chat_messages, api_keys,
-- webhook_deliveries, templates, automations — and payments and subscriptions.
--
-- Two changes, each small:
--
--   1. Drop org_super_all. The three verb-specific policies from
--      20260908100000 already give a super admin SELECT, INSERT and UPDATE, so
--      dropping this removes exactly one thing: the ability to DELETE an
--      organisation over the API. Deletion then requires the service role or a
--      psql session as owner — still possible, but no longer one stray request
--      away.
--
--   2. payments and subscriptions stop cascading. Under Indian GST and income
--      tax rules these have to be retained for years regardless of whether the
--      customer still exists, so "the customer left, delete their invoices" is
--      not a choice we get to make. RESTRICT also gives a useful property: an
--      organisation that has ever paid cannot be deleted at all until someone
--      deals with the money deliberately.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Remove the API-level delete path
-- ════════════════════════════════════════════════════════════════════════════
-- Checked before dropping: org_super_all grants a super admin SELECT, INSERT,
-- UPDATE and DELETE. The first three are already covered by org_member_read,
-- org_super_admin_insert and org_super_admin_write. So this drop is not a loss
-- of reach — it is the removal of DELETE alone.
drop policy if exists org_super_all on public.organizations;

comment on table public.organizations is
  'Deleting a row here cascades through 19 tables with no restore. There is deliberately no DELETE policy: suspend with admin_set_org_active() instead, which is reversible. Genuine deletion requires the service role and should be a written-down operation.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Financial records survive their organisation
-- ════════════════════════════════════════════════════════════════════════════
-- Dropping and re-adding the constraint is the only way to change ON DELETE.
-- Both are cheap: the tables are small and the index behind the FK is reused.
alter table public.payments
  drop constraint if exists payments_org_id_fkey;
alter table public.payments
  add constraint payments_org_id_fkey
  foreign key (org_id) references public.organizations(id) on delete restrict;

alter table public.subscriptions
  drop constraint if exists subscriptions_org_id_fkey;
alter table public.subscriptions
  add constraint subscriptions_org_id_fkey
  foreign key (org_id) references public.organizations(id) on delete restrict;

comment on constraint payments_org_id_fkey on public.payments is
  'RESTRICT, not CASCADE: invoices and payment records must be retained for tax purposes whether or not the customer still exists. This also means an organisation that has ever paid cannot be deleted without dealing with its payments first — which is the right order.';

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select 'no DELETE path on organizations via the API' as check,
       case when not exists (select 1 from pg_policy
                              where polrelid = 'public.organizations'::regclass
                                and polcmd in ('d', '*'))
            then 'PASS' else 'FAIL — a policy still covers DELETE' end as result
union all
select 'super admin kept read / insert / update',
       case when (select count(*) from pg_policy
                   where polrelid = 'public.organizations'::regclass
                     and pg_get_expr(polqual, polrelid) like '%is_super_admin%'
                      or pg_get_expr(polwithcheck, polrelid) like '%is_super_admin%') >= 3
            then 'PASS' else 'FAIL — dropping org_super_all took something with it' end
union all
select 'financial records no longer cascade',
       case when (select count(*) from information_schema.referential_constraints rc
                    join information_schema.table_constraints tc
                      on tc.constraint_name = rc.constraint_name
                   where tc.table_name in ('payments','subscriptions')
                     and rc.delete_rule = 'RESTRICT') = 2
            then 'PASS' else 'FAIL' end
union all
select 'what still cascades from an organisation',
       (select count(*)::text || ' tables'
          from information_schema.referential_constraints rc
          join information_schema.constraint_column_usage ccu
            on ccu.constraint_name = rc.constraint_name
         where ccu.table_name = 'organizations' and rc.delete_rule = 'CASCADE');
