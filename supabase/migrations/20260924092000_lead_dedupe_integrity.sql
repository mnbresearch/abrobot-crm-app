-- AbroBot CRM — stop creating the same student twice.
--
-- ════════════════════════════════════════════════════════════════════════════
-- What is actually happening
-- ════════════════════════════════════════════════════════════════════════════
-- There is no unique constraint anywhere on leads. Not on (org_id, email), not
-- on (org_id, phone), not on anything. The entire defence against duplicates is
-- three read-then-insert sequences in application code:
--
--   supabase/functions/lead-webhook/index.ts:243   .eq("email", lead.email)
--   supabase/functions/chat-agent/index.ts:524     .eq("email", email)
--   supabase/functions/api/index.ts:295            .eq("email", email)
--
-- (and a fourth lookup of the same shape in app-signup/index.ts:99, which reads
-- a lead by org + email to find its nurture_token.)
--
-- Two independent problems with that, and they compound:
--
--   1. `.eq` is case-sensitive. PostgreSQL's `=` on text compares bytes, so
--      "Ravi@x.com" does not equal "ravi@x.com" and the lookup misses. A
--      student who filled the website form on their phone with autocapitalise
--      on, and the same student a week later from a laptop, are two records.
--      Two nurture sequences to the same inbox. Two assignees, each believing
--      they own the relationship. Two rows counting against the plan's lead
--      cap, so the customer pays for their own duplicate.
--
--   2. Read-then-insert is not atomic. Even with a case-insensitive lookup,
--      two concurrent inbound enquiries — the website form and the WhatsApp
--      webhook firing within the same second, which is normal, because people
--      do both — both read "not found" and both insert. No amount of care in
--      the application closes that; the check and the write are separate
--      statements against a moving database.
--
-- Only the database can enforce this, and only with a unique index.
--
-- ════════════════════════════════════════════════════════════════════════════
-- And the index that was supposed to make the lookup fast does not
-- ════════════════════════════════════════════════════════════════════════════
-- 20260914090000 added, with the comment "Dedupe … on every inbound enquiry,
-- which is the one path that must never be slow":
--
--   create index leads_org_email_idx on public.leads (org_id, lower(email))
--     where email is not null;
--
-- That is an index on the EXPRESSION lower(email). An expression index can only
-- serve a query that contains the same expression. All four call sites filter
-- the raw column (`email = $1`), so none of them can use it. What they get
-- instead is the index's leading column — org_id — which on a tenant's whole
-- lead table is close to no selectivity at all: a scan of every lead in the org
-- to find one email, on the hottest path in the product.
--
-- The index has been there since 14 September doing nothing but slowing down
-- every insert.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ The consequence of this migration that you have to decide about ⚠
-- ════════════════════════════════════════════════════════════════════════════
-- A unique index turns a silent duplicate into a loud error. After this, an
-- inbound enquiry from "Ravi@x.com" when "ravi@x.com" already exists will:
--
--   * miss the case-sensitive lookup (unchanged)
--   * attempt the insert (unchanged)
--   * and now get  ERROR: 23505 duplicate key value violates unique constraint
--                  "leads_org_email_unique_idx"
--
-- If the edge function does not handle 23505, that enquiry is REJECTED rather
-- than duplicated. A duplicate lead is bad. A dropped enquiry is worse.
--
-- So the correct order of work is: fix the four call sites first, then apply
-- this. The fix at each site is to match the index —
--
--   .ilike("email", email)            or, better, normalise before querying
--
-- — and to catch 23505 by re-reading the existing row instead of failing, which
-- is the atomicity hole from problem 2 above and needs handling regardless of
-- what this migration does.
--
-- This file cannot make that change and does not pretend to. It is written so
-- that applying it early is survivable rather than silent: the verify block
-- below tells you exactly what state you are in.
--
-- ════════════════════════════════════════════════════════════════════════════
-- Why the index creation is conditional
-- ════════════════════════════════════════════════════════════════════════════
-- CREATE UNIQUE INDEX fails outright if the data already violates it, and I
-- cannot connect to the database to find out whether it does — after weeks of
-- case-sensitive dedupe, duplicates are the expected state, not the surprise.
--
-- A migration that raises is a migration that does not get applied, and then
-- neither half of the fix lands. So: count the collisions first, and create the
-- index only when there are none. When there are, print them and finish
-- successfully, leaving the merge to a human.
--
-- Nothing here deletes, merges or edits a single lead row. Which record is the
-- real one, which assignee keeps the relationship and which nurture sequence
-- gets cancelled are questions with a customer on the other end of them. A
-- migration that picked for you would be a migration that silently threw away
-- somebody's notes.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Preconditions
-- ════════════════════════════════════════════════════════════════════════════
-- public.leads is not created by any migration in this repo — it predates the
-- history, like my_org() (see 20260924090000). So its columns are checked
-- rather than assumed.

do $pre$
declare
  missing text[] := '{}';
  c text;
begin
  if to_regclass('public.leads') is null then
    raise exception 'public.leads does not exist';
  end if;

  foreach c in array array['org_id','email','phone','deleted_at'] loop
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'leads'
                      and column_name = c) then
      missing := missing || c;
    end if;
  end loop;

  if array_length(missing, 1) > 0 then
    raise exception 'public.leads is missing column(s): % — cannot build the dedupe indexes',
      array_to_string(missing, ', ');
  end if;
end
$pre$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. (org_id, lower(email)) — report, then build only if clean
-- ════════════════════════════════════════════════════════════════════════════
-- lower(email), matching the expression 20260914090000 already chose, because
-- case-insensitivity is the actual bug. NOT lower(btrim(email)): trimming would
-- be a second, separate normalisation decision, and an index expression that
-- differs from the one the rest of the schema uses is how the mismatch above
-- happened in the first place.
--
-- The predicate is `email is not null and deleted_at is null`:
--
--   email is not null   a partial index over the rows that have an email at
--                       all. Many leads are phone-only, and NULLs are distinct
--                       under a unique index anyway, so including them would
--                       only make the index bigger.
--   deleted_at is null  archived records must not block a re-enquiry. A student
--                       archived in March who writes again in September is a
--                       new, legitimate lead; if the unique index counted the
--                       archived row, the new enquiry would be rejected and the
--                       reason would be invisible to everyone (the archived row
--                       is hidden from SELECT by leads_hide_archived since
--                       20260922100000 — the operator would see a duplicate-key
--                       error naming a row they cannot see).

do $email$
declare
  v_groups integer;
  v_rows   integer;
  v_sample text;
begin
  select count(*), coalesce(sum(c), 0),
         string_agg(org_id::text || ' / ' || e || ' ×' || c::text, ',  ' order by c desc, e)
    into v_groups, v_rows, v_sample
    from (
      select org_id, lower(email) as e, count(*) as c
        from public.leads
       where email is not null
         and deleted_at is null
       group by org_id, lower(email)
      having count(*) > 1
       order by count(*) desc
       limit 25
    ) d;

  if coalesce(v_groups, 0) = 0 then
    -- `if not exists` on the NAME, which is all PostgreSQL offers. That is a
    -- weak guard in general (20260914090000 has a note about exactly this
    -- trap), but here the name is new in this file and nothing else uses it.
    execute $ddl$
      create unique index if not exists leads_org_email_unique_idx
        on public.leads (org_id, lower(email))
        where email is not null and deleted_at is null
    $ddl$;
    raise notice '[dedupe] email: no collisions — unique index created';
  else
    raise warning '[dedupe] email: % colliding group(s) covering % row(s). Unique index NOT created. Merge them, then re-run this migration. Sample: %',
      v_groups, v_rows, coalesce(v_sample, '(none)');
  end if;
end
$email$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. (org_id, phone) — same treatment, no lower()
-- ════════════════════════════════════════════════════════════════════════════
-- Phone numbers have no case, so the raw column is the right key and the
-- existing leads_org_phone_idx already matches how the code queries it.
--
-- What this does NOT normalise: formatting. "+91 98765 43210",
-- "+919876543210" and "9876543210" are the same phone and three different
-- strings, and this index treats them as three different leads. Canonicalising
-- them is a real fix and a bigger one — it needs a decision about default
-- country, a backfill of existing rows, and a change at every write site — so
-- it is deliberately out of scope here rather than half-done. This index closes
-- the exact-match duplicate, which is the common case: the same webhook payload
-- delivered twice.

do $phone$
declare
  v_groups integer;
  v_rows   integer;
  v_sample text;
begin
  select count(*), coalesce(sum(c), 0),
         string_agg(org_id::text || ' / ' || p || ' ×' || c::text, ',  ' order by c desc, p)
    into v_groups, v_rows, v_sample
    from (
      select org_id, phone as p, count(*) as c
        from public.leads
       where phone is not null
         and deleted_at is null
       group by org_id, phone
      having count(*) > 1
       order by count(*) desc
       limit 25
    ) d;

  if coalesce(v_groups, 0) = 0 then
    execute $ddl$
      create unique index if not exists leads_org_phone_unique_idx
        on public.leads (org_id, phone)
        where phone is not null and deleted_at is null
    $ddl$;
    raise notice '[dedupe] phone: no collisions — unique index created';
  else
    raise warning '[dedupe] phone: % colliding group(s) covering % row(s). Unique index NOT created. Sample: %',
      v_groups, v_rows, coalesce(v_sample, '(none)');
  end if;
end
$phone$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. An index the dedupe lookups can actually use
-- ════════════════════════════════════════════════════════════════════════════
-- The raw column, because `email = $1` is what the four call sites send today.
--
-- Note what is NOT in the predicate: deleted_at. The dedupe lookups run as
-- service_role from edge functions, and service_role has BYPASSRLS — so the
-- `deleted_at is null` that the restrictive policy adds for a signed-in user is
-- absent from their query, and the planner cannot use a partial index whose
-- predicate it cannot prove. An index on the hot path that the hot path cannot
-- use is the mistake this section exists to correct; making the same mistake
-- one row down would be embarrassing.
--
-- This index becomes redundant the moment the call sites are fixed to query
-- lower(email) — at which point drop it and keep leads_org_email_unique_idx:
--   drop index if exists public.leads_org_email_exact_idx;
create index if not exists leads_org_email_exact_idx
  on public.leads (org_id, email)
  where email is not null;

comment on index public.leads_org_email_exact_idx is
  'Serves the case-sensitive dedupe lookup the edge functions actually issue (email = $1). Temporary: delete it once lead-webhook, chat-agent and the public API query lower(email) instead, and leads_org_email_unique_idx will serve them.';

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Retire leads_org_email_idx — only if its replacement exists
-- ════════════════════════════════════════════════════════════════════════════
-- leads_org_email_idx is (org_id, lower(email)) where email is not null. The
-- new unique index has the IDENTICAL key with a narrower predicate, so every
-- query that could use the old one and also filters deleted_at is null — which
-- is every query from a signed-in user, since leads_hide_archived adds that
-- predicate for them — is served by the new one. The only queries left to the
-- old index are lower(email) lookups that deliberately include archived rows,
-- and there are none in the codebase: all four call sites use the raw column,
-- now covered by section 4.
--
-- So it is redundant, and not free — every insert into the hottest table in the
-- product maintains it. Dropping it is the one deletion in this file and it is
-- deliberate.
--
-- Conditional on the unique index existing. If section 2 found collisions and
-- skipped the build, dropping this would leave lower(email) with no index at
-- all, so the drop waits for the next run — after the duplicates are merged —
-- rather than trading one regression for another.
--
-- To put it back, one line:
--   create index leads_org_email_idx on public.leads (org_id, lower(email))
--     where email is not null;

do $retire$
begin
  if to_regclass('public.leads_org_email_unique_idx') is not null
     and to_regclass('public.leads_org_email_idx') is not null then
    drop index if exists public.leads_org_email_idx;
    raise notice '[dedupe] dropped leads_org_email_idx — leads_org_email_unique_idx has the same key';
  elsif to_regclass('public.leads_org_email_idx') is not null then
    raise warning '[dedupe] kept leads_org_email_idx: the unique index it duplicates was not created (collisions)';
  end if;
end
$retire$;

-- leads_org_phone_idx is deliberately KEPT. Unlike the email pair, its
-- replacement is not equivalent: leads_org_phone_unique_idx is partial on
-- deleted_at, and the service_role dedupe lookup does not filter deleted_at
-- (BYPASSRLS — see section 4), so the planner cannot use the unique index for
-- it. Dropping the non-partial one would make the inbound phone lookup a scan.

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- Verify
-- ════════════════════════════════════════════════════════════════════════════
-- Rows 1–2 are PASS/FAIL-or-BLOCKED. Rows 3–4 are the collision report: if the
-- indexes were not created, everything you need in order to merge is here.

select * from (

  select 1 as ord, 'unique index on (org_id, lower(email))' as check,
         case when to_regclass('public.leads_org_email_unique_idx') is not null
              then 'PASS — created; case-insensitive duplicates are now impossible'
              else 'BLOCKED — collisions exist, see row 3. Nothing was changed; merge and re-run.'
         end as detail

  union all
  select 2, 'unique index on (org_id, phone)',
         case when to_regclass('public.leads_org_phone_unique_idx') is not null
              then 'PASS — created'
              else 'BLOCKED — collisions exist, see row 4. Nothing was changed; merge and re-run.'
         end

  -- ── The collision report ─────────────────────────────────────────────────
  union all
  select 3, 'email collisions (org_id / email / count)',
         coalesce((
           select 'still ' || count(*)::text || ' group(s): '
                  || string_agg(org_id::text || ' / ' || e || ' ×' || c::text, ',  ' order by c desc)
             from (select org_id, lower(email) as e, count(*) as c
                     from public.leads
                    where email is not null and deleted_at is null
                    group by org_id, lower(email)
                   having count(*) > 1
                    order by count(*) desc limit 25) d),
           'none — clean')

  union all
  select 4, 'phone collisions (org_id / phone / count)',
         coalesce((
           select 'still ' || count(*)::text || ' group(s): '
                  || string_agg(org_id::text || ' / ' || p || ' ×' || c::text, ',  ' order by c desc)
             from (select org_id, phone as p, count(*) as c
                     from public.leads
                    where phone is not null and deleted_at is null
                    group by org_id, phone
                   having count(*) > 1
                    order by count(*) desc limit 25) d),
           'none — clean')

  -- ── Live state: what indexes leads now carries ───────────────────────────
  union all
  select 5, 'indexes on public.leads',
         coalesce((select string_agg(indexname, ', ' order by indexname)
                     from pg_indexes where schemaname = 'public' and tablename = 'leads'),
                  '(none)')

  -- ── The reminder that this migration cannot fix ──────────────────────────
  union all
  select 6, 'the application change this still needs',
         case when to_regclass('public.leads_org_email_unique_idx') is null
              then 'not urgent yet — the unique index was not created, so behaviour is unchanged'
              else 'URGENT: lead-webhook:243, chat-agent:524 and api:295 look leads up with case-sensitive .eq("email"). '
                   || 'They will now get 23505 on a mixed-case re-enquiry instead of creating a duplicate. '
                   || 'If they do not catch it, the enquiry is dropped. Change them to .ilike and handle 23505 by re-reading the row.'
         end

) t order by ord;

-- ── Merging a collision by hand ─────────────────────────────────────────────
-- Look at the group before deciding anything — the two rows are rarely equally
-- complete:
--
--   select id, name, email, phone, stage_key, assigned_to, source,
--          nurture_step, created_at, updated_at
--     from public.leads
--    where org_id = '<org>' and lower(email) = '<email>' and deleted_at is null
--    order by created_at;
--
-- Then, for each duplicate you have decided is the junior copy: move its
-- history onto the survivor and ARCHIVE it — never DELETE. archive_lead() keeps
-- the row, keeps it out of the lists, and keeps it recoverable if the call was
-- wrong, and the partial index predicate above means an archived row no longer
-- blocks the unique constraint:
--
--   update public.activities     set lead_id = '<keep>' where lead_id = '<drop>';
--   update public.conversations  set lead_id = '<keep>' where lead_id = '<drop>';
--   select public.archive_lead('<drop>');
--
-- When the report in rows 3 and 4 says "clean", run this migration again. It is
-- re-runnable and will create the indexes it skipped.
