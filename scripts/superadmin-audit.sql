-- What can the platform super admin actually reach?
--
-- Run this AFTER 20260908100000_super_admin.sql. It reads the live policies
-- rather than the migration files, because several tables predate the
-- migrations and the files are not the whole truth.
--
-- Reads only — this changes nothing.

with rls as (
  select c.oid, c.relname as tbl,
         exists (select 1 from information_schema.columns ic
                  where ic.table_schema = 'public' and ic.table_name = c.relname
                    and ic.column_name = 'org_id') as org_scoped
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
),
-- A policy lets a super admin through if its predicate mentions
-- is_super_admin(). polcmd: r=select w=update a=insert d=delete *=all
cov as (
  select r.tbl, r.org_scoped,
         bool_or(p.polcmd in ('r','*') and pg_get_expr(p.polqual, p.polrelid) like '%is_super_admin%') as can_read,
         bool_or(p.polcmd in ('a','*') and coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%is_super_admin%') as can_insert,
         bool_or(p.polcmd in ('w','*') and pg_get_expr(p.polqual, p.polrelid) like '%is_super_admin%') as can_update,
         bool_or(p.polcmd in ('d','*') and pg_get_expr(p.polqual, p.polrelid) like '%is_super_admin%') as can_delete,
         count(p.oid) as policies
    from rls r
    left join pg_policy p on p.polrelid = r.oid
   group by r.tbl, r.org_scoped
)
select
  tbl                                  as "table",
  case when org_scoped then 'tenant' else 'platform' end as scope,
  policies,
  case when can_read   then '✓' else '—' end as "read",
  case when can_insert then '✓' else '—' end as "insert",
  case when can_update then '✓' else '—' end as "update",
  case when can_delete then '✓' else '—' end as "delete",
  case
    when org_scoped and not can_read then 'GAP — a tenant table the owner cannot read'
    when tbl = 'organizations' and not can_update then 'GAP — cannot change a plan or suspend'
    when tbl = 'plan_limits'  and not can_update then 'GAP — cannot change pricing'
    when policies = 0 then 'RLS on with NO policies — nobody but the service role gets in'
    else ''
  end as note
from cov
order by (org_scoped and not can_read) desc, org_scoped desc, tbl;

-- ── The admin operations, and who can call them ─────────────────────────────
select
  p.proname as "function",
  case when has_function_privilege('authenticated',
         p.oid, 'EXECUTE') then '✓' else '—' end as "signed-in user",
  case when has_function_privilege('anon', p.oid, 'EXECUTE')
       then 'FAIL — anon can call this' else 'ok' end as "anon"
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'admin\_%'
order by p.proname;

-- ── Who holds the role ──────────────────────────────────────────────────────
-- Should be a very short list. Every one of these accounts can read and modify
-- every customer's data.
select email, full_name, status, org_id, created_at
  from public.profiles
 where role = 'super_admin'
 order by created_at;

-- ── The trail ───────────────────────────────────────────────────────────────
select created_at, actor_email, action, org_id, detail
  from public.admin_audit
 order by created_at desc
 limit 20;
