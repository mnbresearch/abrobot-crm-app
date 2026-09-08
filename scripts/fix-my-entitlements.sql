-- The one statement that failed in 20260908100000. Everything before it
-- committed — the `commit;` sits above the verify block, and this addendum
-- comes after it.
--
-- WHY IT FAILED: `create or replace view` can only APPEND columns. I inserted
-- `not_activated` between `is_expired` and `label`, which asks Postgres to
-- rename column 5 — hence 42P16.
--
-- This view is scoped correctly (`where o.id = my_org() or is_super_admin()`)
-- and nothing in the app or the edge functions reads it. The rewrite is
-- housekeeping: it still computed a trial expiry date for a plan that no
-- longer exists.

drop view if exists public.my_entitlements;   -- no CASCADE: fail loudly if depended on

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

-- ── Verify: the whole of 20260908100000, re-checked ─────────────────────────
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
            then 'PASS' else 'FAIL' end
union all
select 'my_entitlements rebuilt',
       case when to_regclass('public.my_entitlements') is not null
            then 'PASS' else 'FAIL' end;
