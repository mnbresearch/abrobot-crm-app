-- AbroBot CRM — put the four predicates every policy depends on into the repo.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ READ THIS BEFORE RUNNING IT ON PRODUCTION ⚠
-- ════════════════════════════════════════════════════════════════════════════
-- This migration REDEFINES three functions that already exist in production
-- with definitions nobody in this repo has ever seen. Between them they decide
-- the outcome of 157 policy predicates. If my reconstruction differs from what
-- is live, the blast radius is every table in the product, in either
-- direction: a stricter definition locks users out of their own data, a looser
-- one shows one tenant another tenant's records.
--
-- So before applying this anywhere that has customers in it, run this against
-- production and read the four definitions it prints:
--
--   select p.oid::regprocedure as signature, pg_get_functiondef(p.oid) as def
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('my_org','is_active_member','is_super_admin',
--                        'is_org_admin')
--    order by 1;
--
-- Compare them with the definitions below. If they agree, this migration is a
-- no-op that finally writes the truth down. If they disagree, STOP — the
-- difference is the actual finding, and it needs a decision, not a migration.
--
-- Running it anyway is survivable but not free: the transaction below captures
-- each live definition into public.legacy_predicate_snapshots BEFORE touching
-- anything, and pg_get_functiondef output is directly re-runnable SQL — so
-- that table is the rollback script. Restoring is:
--
--   select definition from public.legacy_predicate_snapshots
--    where function_signature = 'public.my_org()';
--   -- then paste and run it
--
-- ════════════════════════════════════════════════════════════════════════════
-- Why this file exists at all
-- ════════════════════════════════════════════════════════════════════════════
-- Grep the migrations for the four predicates the whole authorisation model is
-- built on:
--
--   is_super_admin()    80 references, defined in NO migration
--   my_org()            61 references, defined in NO migration
--   is_active_member()  35 references, defined in NO migration
--   is_org_admin()      29 references, defined in 20260816120000  ← the only one
--
-- The first three are legacy dashboard objects, the same category as
-- super_all_leads and conversations_org in 20260922100000. That file's lesson
-- was "a rule that lives in one permissive policy can be out-voted by another
-- one you cannot see". This is the same failure one level down: a rule that
-- lives only in the database can be *anything at all*, and nobody can tell.
--
-- Two concrete consequences, both verified by reading rather than assumed:
--
--   (a) The schema is not reproducible. `supabase db reset`, a staging clone,
--       a local dev database, a restore into a fresh project — every one of
--       them replays these migrations into a database where my_org() does not
--       exist. The first policy that evaluates raises
--
--           ERROR: 42883: function my_org() does not exist
--
--       and it is not one table that breaks, it is all 157 predicates. There
--       is currently no way to stand this product up from source.
--
--   (b) The three most security-critical functions in the system cannot be
--       reviewed. Not "have not been reviewed" — cannot be, by anyone reading
--       the repo. is_super_admin() gates cross-tenant access to every table.
--       Its definition is a string in a catalog that no pull request has ever
--       touched.
--
-- ════════════════════════════════════════════════════════════════════════════
-- What the definitions below are, and what they are not
-- ════════════════════════════════════════════════════════════════════════════
-- They are the obvious semantics, reconstructed from how the rest of the
-- schema uses them and from what profiles actually contains:
--
--   my_org()            the caller's profiles.org_id
--   is_active_member()  the caller has a profile row with status = 'active'
--   is_super_admin()    ... and role = 'super_admin'
--   is_org_admin()      ... and role in ('org_admin','super_admin')
--                       — verbatim from 20260816120000, re-stated here so the
--                       four live together, with its search_path pinned and
--                       the missing revoke supplied (see below).
--
-- They are NOT a claim about what production currently does. That claim is
-- what the snapshot table and the verify block at the bottom exist to test.
--
-- Three properties are pinned deliberately on all four:
--
--   security definer  they read public.profiles, and the caller must not need
--                     SELECT on profiles to be told whether they are an admin.
--                     Without it, every policy using them would depend on the
--                     policies on profiles — authorisation defined in terms of
--                     itself.
--   stable            they are evaluated once per row of a policy scan. VOLATILE
--                     would forbid the planner caching them and turn a seq scan
--                     over leads into one profiles lookup per lead.
--   set search_path   pinned EXPLICITLY, including pg_temp. A SECURITY DEFINER
--     = public,       function without this is the classic Postgres escalation:
--       pg_temp       pg_temp is searched FIRST when it is not named, so any
--                     role that can create temporary objects (PUBLIC can, by
--                     default) could shadow public.profiles with a temp table
--                     of their own and make is_super_admin() return true.
--                     Naming pg_temp last moves it to the end of the path,
--                     which is the entire point of writing it out.
--
-- Deliberately NOT done here: nothing is dropped, no policy is touched, and no
-- behaviour is added. If the live definitions match, applying this changes the
-- database by exactly one table and four function bodies that compile to the
-- same thing.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Capture what is live, BEFORE replacing it
-- ════════════════════════════════════════════════════════════════════════════
-- The verify block at the bottom runs after COMMIT, so pg_get_functiondef
-- there would report the NEW definition — useless for deciding whether to
-- trust it. The only moment the old text is readable is now.

create table if not exists public.legacy_predicate_snapshots (
  function_signature text primary key,
  captured_at        timestamptz not null default now(),
  definition         text,
  note               text
);

comment on table public.legacy_predicate_snapshots is
  'The definition each legacy dashboard-created predicate had immediately before 20260924090000 replaced it. pg_get_functiondef output is re-runnable SQL, so a row here is a complete rollback for that function. First capture wins: re-running the migration must not overwrite the legacy text with the replacement.';

alter table public.legacy_predicate_snapshots enable row level security;
-- RLS on with no policies denies every row to anon and authenticated; the
-- revoke is the belt-and-braces layer that survives someone turning RLS off.
-- These definitions describe the authorisation model in full, which makes them
-- a map for anyone attacking it.
revoke all on public.legacy_predicate_snapshots from anon, authenticated;

do $cap$
declare
  sigs text[] := array[
    'public.my_org()',
    'public.is_active_member()',
    'public.is_super_admin()',
    'public.is_org_admin()'
  ];
  s text;
  o regprocedure;
  d text;
begin
  foreach s in array sigs loop
    -- to_regprocedure, not ::regprocedure: the cast raises when the function
    -- is absent, and "absent" is the expected answer on a fresh database.
    o := to_regprocedure(s);

    if o is null then
      d := null;
      raise notice '[capture] % — NOT PRESENT (fresh database, nothing to compare)', s;
    else
      d := pg_get_functiondef(o::oid);
      raise notice '[capture] % — live definition follows:%', s, chr(10) || d;
    end if;

    -- DO NOTHING, not DO UPDATE. On the second run the "live" definition is
    -- this migration's own replacement, and overwriting the snapshot with it
    -- would quietly destroy the only copy of the legacy text — the one thing
    -- this table exists to hold.
    insert into public.legacy_predicate_snapshots (function_signature, definition, note)
    values (s, d,
            case when d is null
                 then 'not present at capture time'
                 else 'captured immediately before 20260924090000 replaced it' end)
    on conflict (function_signature) do nothing;
  end loop;
end
$cap$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Preconditions — refuse rather than lock everyone out
-- ════════════════════════════════════════════════════════════════════════════
-- Every definition below reads public.profiles (id, org_id, status, role). If
-- any of those is missing or renamed, the functions still CREATE cleanly and
-- then raise 42703 the first time a policy evaluates them — which is on the
-- next query anyone runs, against any table. That is a total outage produced
-- by a migration that reported success.
--
-- Raising here aborts the transaction, so nothing is changed at all.

do $pre$
declare
  missing text[] := '{}';
  c text;
begin
  if to_regclass('public.profiles') is null then
    raise exception
      'public.profiles does not exist — refusing to define predicates that would raise on every policy in the database';
  end if;

  foreach c in array array['id','org_id','status','role'] loop
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public'
                      and table_name   = 'profiles'
                      and column_name  = c) then
      missing := missing || c;
    end if;
  end loop;

  if array_length(missing, 1) > 0 then
    raise exception
      'public.profiles is missing column(s): % — the predicates below would compile and then fail at policy-evaluation time on every table',
      array_to_string(missing, ', ');
  end if;
end
$pre$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. The four predicates
-- ════════════════════════════════════════════════════════════════════════════
-- `create or replace`, not `drop` + `create`. Dropping would fail anyway —
-- 157 policies depend on these — but more importantly replace preserves the
-- OID, and policies reference functions by OID. A drop-and-recreate would need
-- every policy rebuilt.
--
-- If a live function's return type differs from what is written here, this
-- raises 42P13 ("cannot change return type of existing function") and the
-- whole transaction rolls back. That is the correct outcome: it means the
-- reconstruction is wrong in a way worth stopping for. The same file that
-- taught this project about 42P13 — 20260922100000 — is where that lesson
-- came from.

-- ── my_org ──────────────────────────────────────────────────────────────────
create or replace function public.my_org()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.org_id from public.profiles p where p.id = auth.uid();
$$;

comment on function public.my_org() is
  'The organisation the signed-in user belongs to, or NULL when there is no JWT or no profile row. The tenant boundary in 54 policy predicates. Defined here rather than in the dashboard since 24 September 2026 — before that it existed only in the database and could not be reviewed.';

-- ── is_active_member ────────────────────────────────────────────────────────
create or replace function public.is_active_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.status = 'active'
  );
$$;

comment on function public.is_active_member() is
  'True when the caller has a profile row with status = ''active''. Deliberately says nothing about which organisation: every policy pairs it with org_id = my_org(), and folding the org test in here would hide half the predicate from anyone reading a policy.';

-- ── is_super_admin ──────────────────────────────────────────────────────────
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.status = 'active'
       and p.role = 'super_admin'
  );
$$;

comment on function public.is_super_admin() is
  'True when the caller is an active platform super admin. The single most powerful predicate in the schema: it appears in 80 places and each one grants cross-tenant reach. status = ''active'' is part of the test, not decoration — a deactivated super admin must lose the reach immediately, without every policy being edited.';

-- ── is_org_admin ────────────────────────────────────────────────────────────
-- Body verbatim from 20260816120000. Restated here for two reasons: the four
-- belong together, and the original had `set search_path = public` without
-- pg_temp (see the header — pg_temp is searched first when unnamed) and was
-- granted to authenticated with no preceding revoke, so the default PUBLIC
-- EXECUTE it was born with is still there. Both are fixed below.
create or replace function public.is_org_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.status = 'active'
      and p.role in ('org_admin', 'super_admin')
  );
$$;

comment on function public.is_org_admin() is
  'True when the caller is an active org_admin or super_admin. Companion to is_active_member(). Search path pinned and PUBLIC EXECUTE revoked on 24 September 2026.';

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Grants
-- ════════════════════════════════════════════════════════════════════════════
-- `revoke ... from public` FIRST, every time. A function is created with
-- EXECUTE granted to PUBLIC, and a later `grant execute to authenticated` does
-- not remove it — it just adds a second, redundant grant on top. That is the
-- exact mistake catalogued on plan_seat_cap and ensure_profile in
-- 20260924094000: the explicit grant reads like an access-control decision and
-- the real one was made by the default.
--
-- Then granted BACK to anon as well as authenticated, deliberately.
--
-- These four are not called only through RPC; they are called inside RLS
-- policy expressions, and a policy expression is evaluated with the querying
-- role's privileges. Revoking EXECUTE from anon does not make an anonymous
-- query return zero rows — it makes it raise
--
--   ERROR: 42501: permission denied for function is_super_admin
--
-- on every table whose policy mentions it. Denial by error rather than by
-- empty result is a worse answer to the same question, and it leaks the shape
-- of the policy while it is at it.
--
-- Nothing is disclosed by the grant: all four answer a question about the
-- caller, and for anon all four answer "no" (NULL for my_org). The value of
-- the revoke here is not narrowing anon, it is that the ACL is now written
-- down instead of inherited.
revoke all on function public.my_org()           from public;
revoke all on function public.is_active_member() from public;
revoke all on function public.is_super_admin()   from public;
revoke all on function public.is_org_admin()     from public;

grant execute on function public.my_org()           to anon, authenticated, service_role;
grant execute on function public.is_active_member() to anon, authenticated, service_role;
grant execute on function public.is_super_admin()   to anon, authenticated, service_role;
grant execute on function public.is_org_admin()     to anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Prove they run before committing to them
-- ════════════════════════════════════════════════════════════════════════════
-- A function body is only parsed when it is first executed. `language sql`
-- bodies are checked at creation time, but the check is not exhaustive and it
-- says nothing about privileges. Calling each one here means a broken
-- definition aborts THIS transaction rather than the next customer query.
--
-- The migration runs with no JWT, so auth.uid() is NULL and the honest
-- expected answers are: my_org() NULL, the three booleans false. Anything
-- other than "it returned" is a failure.
do $smoke$
declare
  v_org  uuid;
  v_act  boolean;
  v_sup  boolean;
  v_adm  boolean;
begin
  v_org := public.my_org();
  v_act := public.is_active_member();
  v_sup := public.is_super_admin();
  v_adm := public.is_org_admin();

  raise notice '[smoke] as the migration runner (no JWT): my_org=% is_active_member=% is_super_admin=% is_org_admin=%',
    coalesce(v_org::text, 'NULL'), v_act, v_sup, v_adm;

  -- A super admin with no JWT would mean the definition ignores auth.uid(),
  -- which would hand every anonymous request the whole platform.
  if v_sup or v_adm or v_act then
    raise exception
      'refusing to commit: the predicates return true with no authenticated user (active=%, super=%, admin=%)',
      v_act, v_sup, v_adm;
  end if;
end
$smoke$;

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- Verify
-- ════════════════════════════════════════════════════════════════════════════
-- Rows 1–3 are PASS/FAIL. Rows 4–8 report LIVE STATE, which is the part that
-- cannot be asserted from a repo: whether the definition that was there before
-- this ran is the definition this file claims. Read them.

select * from (

  -- 1. All four exist with the three properties pinned.
  select 1 as ord, 'all four predicates exist, definer + stable + pinned path' as check,
         case when (
                select count(*) from pg_proc p
                  join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public'
                   and p.proname in ('my_org','is_active_member','is_super_admin','is_org_admin')
                   and p.pronargs = 0
                   and p.prosecdef
                   and p.provolatile = 's'
                   and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path=public, pg_temp%'
              ) = 4
              then 'PASS — 4 of 4'
              else 'FAIL — only ' || (
                select count(*) from pg_proc p
                  join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public'
                   and p.proname in ('my_org','is_active_member','is_super_admin','is_org_admin')
                   and p.pronargs = 0
                   and p.prosecdef
                   and p.provolatile = 's'
                   and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path=public, pg_temp%'
              )::text || ' of 4 — run the pg_proc query at the bottom of this file'
         end as detail

  -- 2. PUBLIC no longer holds EXECUTE by default.
  union all
  select 2, 'PUBLIC EXECUTE revoked on all four',
         case when (
                select count(*) from pg_proc p
                  join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public'
                   and p.proname in ('my_org','is_active_member','is_super_admin','is_org_admin')
                   and p.pronargs = 0
                   -- proacl NULL means "never granted or revoked", i.e. the
                   -- built-in PUBLIC EXECUTE is still in force. It has to be
                   -- non-null AND carry no grantee 0 (= PUBLIC) entry.
                   and p.proacl is not null
                   and not exists (select 1 from aclexplode(p.proacl) a
                                    where a.grantee = 0 and a.privilege_type = 'EXECUTE')
              ) = 4
              then 'PASS — explicit ACLs on all four'
              else 'FAIL — at least one still carries the default PUBLIC EXECUTE'
         end

  -- 3. The legacy text was captured for every one of them.
  union all
  select 3, 'legacy definitions captured before replacement',
         case when (select count(*) from public.legacy_predicate_snapshots) = 4
              then 'PASS — 4 rows in legacy_predicate_snapshots (' ||
                   (select count(*)::text from public.legacy_predicate_snapshots where definition is null) ||
                   ' of them were absent, i.e. this is a fresh database)'
              else 'FAIL — ' || (select count(*)::text from public.legacy_predicate_snapshots) || ' of 4 captured'
         end

  -- 4. ── LIVE STATE — the question this migration cannot answer by itself ───
  -- Whitespace-normalised comparison of what was there against what is there
  -- now. DIFFERS is not necessarily wrong; it is necessarily worth reading.
  union all
  select 4, 'did the replacement change anything? (READ THIS)',
         coalesce((
           select string_agg(
                    s.function_signature || ': ' ||
                    case
                      when s.definition is null then 'was ABSENT — created fresh'
                      when to_regprocedure(s.function_signature) is null then 'GONE — investigate'
                      when regexp_replace(lower(s.definition), '\s+', ' ', 'g')
                         = regexp_replace(lower(pg_get_functiondef(to_regprocedure(s.function_signature)::oid)), '\s+', ' ', 'g')
                        then 'IDENTICAL'
                      else '*** DIFFERS *** — the live behaviour just changed'
                    end,
                    '  |  ' order by s.function_signature)
             from public.legacy_predicate_snapshots s), 'no snapshots')

  -- 5. The legacy text itself, in full, so it can be diffed by eye right here.
  union all
  select 5, 'legacy definition that was replaced: my_org()',
         coalesce((select definition from public.legacy_predicate_snapshots
                    where function_signature = 'public.my_org()'),
                  '(was not present)')

  union all
  select 6, 'legacy definition that was replaced: is_active_member()',
         coalesce((select definition from public.legacy_predicate_snapshots
                    where function_signature = 'public.is_active_member()'),
                  '(was not present)')

  union all
  select 7, 'legacy definition that was replaced: is_super_admin()',
         coalesce((select definition from public.legacy_predicate_snapshots
                    where function_signature = 'public.is_super_admin()'),
                  '(was not present)')

  -- 8. How much rests on them. This is the number that makes rows 4–7 worth
  --    the time: a wrong reconstruction is wrong in this many places at once.
  union all
  select 8, 'policy predicates that call these four',
         coalesce((
           select string_agg(fn || ': ' || cnt::text, ', ' order by cnt desc)
             from (
               select f.fn,
                      count(*) as cnt
                 from (values ('my_org'),('is_active_member'),('is_super_admin'),('is_org_admin')) as f(fn)
                 join pg_policy pol
                   on coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
                      || ' ' ||
                      coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
                      like '%' || f.fn || '(%'
                group by f.fn
             ) z), 'none found — which would itself be surprising')

) t order by ord;

-- ── If row 4 says DIFFERS ───────────────────────────────────────────────────
-- Do not shrug it off. Read the old and the new side by side:
--
--   select s.function_signature,
--          s.definition                                            as was,
--          pg_get_functiondef(to_regprocedure(s.function_signature)::oid) as now
--     from public.legacy_predicate_snapshots s
--    order by 1;
--
-- and if the old one was right, restore it by running the `was` column as-is.
-- It is complete, re-runnable SQL. Then fix this file to match, because the
-- repo is now the thing that is wrong.
