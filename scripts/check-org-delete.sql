-- Who can delete an organisation?
--
-- The super-admin verify flagged: "a delete path exists". I did not create one
-- — my two new policies are UPDATE and INSERT only — so this is a policy that
-- predates the migrations and has never been in any file.
--
-- Why it matters: DELETE on organizations cascades. Every lead, activity,
-- conversation, transcript, template, automation and API key belonging to that
-- tenant goes with it, and there is no restore. If the policy below turns out
-- to be `for all using (id = my_org() and is_org_admin())`, then a CUSTOMER's
-- own admin can destroy their entire account in one request — and the first
-- you would know is a support email.
--
-- Reads only. Decide after looking.

-- ── 1. Every policy on organizations, in full ───────────────────────────────
select
  polname                                     as policy,
  case polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
              when 'w' then 'UPDATE' when 'd' then 'DELETE'
              when '*' then 'ALL' end          as applies_to,
  (select string_agg(rolname, ', ') from pg_roles
    where oid = any(polroles))                 as roles,
  pg_get_expr(polqual, polrelid)               as using_clause,
  pg_get_expr(polwithcheck, polrelid)          as with_check
from pg_policy
where polrelid = 'public.organizations'::regclass
order by polcmd, polname;

-- ── 2. Table-level grants ───────────────────────────────────────────────────
-- RLS only applies once the role holds the privilege at all. If `authenticated`
-- has no DELETE grant here, a permissive policy is moot.
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'organizations'
   and grantee in ('authenticated', 'anon')
 order by grantee, privilege_type;

-- ── 3. What would go with it ────────────────────────────────────────────────
-- Everything that cascades from a single organisations row.
select
  tc.constraint_name,
  tc.table_name       as child_table,
  rc.delete_rule
from information_schema.table_constraints tc
join information_schema.referential_constraints rc
  on rc.constraint_name = tc.constraint_name
join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name
where tc.constraint_type = 'FOREIGN KEY'
  and ccu.table_name = 'organizations'
order by rc.delete_rule desc, tc.table_name;
