-- AbroBot CRM — four small findings that share one shape.
--
-- ════════════════════════════════════════════════════════════════════════════
-- The shape
-- ════════════════════════════════════════════════════════════════════════════
-- Every item in this file is a case of a control that reads as if it were made
-- and was not. The 22 September incident was the large version of it: a
-- correct-looking `deleted_at is null` in leads_read, with the actual decision
-- being made somewhere nobody was looking. These are the same thing at function
-- scope:
--
--   * a `grant execute to authenticated` that reads like an access decision,
--     while the access is really coming from the default PUBLIC grant nobody
--     revoked;
--   * a function with an internal authorisation check whose guard clause is
--     true for the role it was meant to exclude;
--   * three functions whose `set search_path` was dropped during a rewrite, so
--     the hardening is still described in the comments and no longer in the
--     code;
--   * a seed with `on conflict do update` that silently un-does a production
--     configuration every time the migration is replayed.
--
-- None of them needs new behaviour. All of them are things the schema already
-- meant to say.
--
-- Not here: is_org_admin(), which has the same missing revoke and the same
-- unpinned search_path. It is fixed in 20260924090000 instead, alongside
-- my_org(), is_active_member() and is_super_admin(), because the four are one
-- family and splitting them across two files is how one of them gets missed.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. recent_cron_failures — every signed-in user can read net._http_response
-- ════════════════════════════════════════════════════════════════════════════
-- 20260903140000 ends with:
--
--   revoke all on function public.recent_cron_failures(integer) from public, anon;
--   grant  execute on function public.recent_cron_failures(integer) to authenticated;
--
-- The revoke is right and the grant is much too wide. The function is SECURITY
-- DEFINER over net._http_response, it has no authorisation check inside it at
-- all, and it returns error_msg and status_code for EVERY pg_net request the
-- database has made — which is every customer's outbound webhook, with the
-- failure detail, across all tenants. Any authenticated user of any
-- organisation could call
--
--   POST /rest/v1/rpc/recent_cron_failures
--
-- and read another customer's integration failures. It is a diagnostic for
-- whoever operates the platform, and that is one person.
--
-- ── Why the fix is a revoke and not an internal check ───────────────────────
-- The obvious hardening — add `and public.is_super_admin()` to the WHERE — is
-- wrong here, and the reason is worth writing down because it recurs. Once
-- authenticated loses EXECUTE, the only callers left are service_role and the
-- owner, and both of those have auth.uid() = NULL, so is_super_admin() is false
-- for them: the internal check would empty the function out for precisely the
-- callers who are supposed to use it. A predicate that is only satisfiable by a
-- role that can no longer call the function is not defence in depth, it is a
-- second bug.
--
-- If a super-admin screen ever needs this, the right shape is a separate
-- wrapper granted to authenticated that carries the is_super_admin() test —
-- then the check is meaningful because the caller has a JWT.
revoke all on function public.recent_cron_failures(integer) from public, anon, authenticated;
grant execute on function public.recent_cron_failures(integer) to service_role;

comment on function public.recent_cron_failures(integer) is
  'Operator diagnostic: recent non-2xx and errored pg_net responses. service_role only. It exposes every tenant''s webhook failure detail and has no internal authorisation check — from 3 to 24 September 2026 it was executable by every authenticated user of every organisation.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The grant that never removed the default
-- ════════════════════════════════════════════════════════════════════════════
-- A newly created function has EXECUTE granted to PUBLIC. `grant execute to
-- authenticated` on top of that adds a redundant second grant and removes
-- nothing; PUBLIC includes anon, and anon keeps it.
--
--   plan_seat_cap(uuid)   20260821080000:475, again 20260901090000:446
--   ensure_profile()      20260821090000:59
--
-- Both were granted without a preceding revoke. Compare 20260903140000, which
-- does `revoke ... from public, anon` first and then grants — the pattern was
-- known, it just was not applied uniformly.
--
-- plan_seat_cap is the one that matters. 20260901090000 rewrote it specifically
-- to stop it disclosing another organisation's plan, and gave it:
--
--   if not (public.is_super_admin() or p_org_id = public.my_org()
--           or auth.uid() is null) then
--     raise exception 'not authorised' …
--
-- `auth.uid() is null` is true for an anonymous PostgREST request. So the guard
-- that was added to close cross-org disclosure admits the one caller with no
-- identity at all, and the PUBLIC grant is what lets that caller in. Two
-- halves of the same oversight, and either one alone would have been harmless.
--
-- ⚠ Do NOT "fix" the auth.uid() is null branch by deleting it. It is what lets
-- service_role, pg_cron and the SECURITY DEFINER callers (guard_profile_changes
-- checks the seat cap on every profile update) use the function at all — they
-- have no JWT by construction. The revoke below is the correct fix: with anon
-- unable to execute it, "no JWT" once again means "internal caller", which is
-- what that branch was always trying to say.
revoke all on function public.plan_seat_cap(uuid) from public, anon;
grant execute on function public.plan_seat_cap(uuid) to authenticated, service_role;

-- ensure_profile() is a smaller version of the same thing. Its own first line
-- raises 'not signed in' when auth.uid() is null, so anon calling it got an
-- error rather than data — the exposure was never real. The revoke is still
-- worth doing: an ACL that says what it means is the difference between "anon
-- is denied" and "anon happens to be denied by the current function body", and
-- the body is a thing people edit.
revoke all on function public.ensure_profile() from public, anon;
grant execute on function public.ensure_profile() to authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. The SSRF guard lost its search_path pin
-- ════════════════════════════════════════════════════════════════════════════
-- 20260912100000 defined is_safe_webhook_url with the path pinned. The
-- 20260917120000 rewrite — which fixed a genuine and serious bug, the one where
-- https://2852039166/ reached the cloud metadata endpoint — rebuilt all three
-- functions and did not carry the `set search_path` over:
--
--   parse_ip_literal(text)     immutable, no SET
--   is_reserved_ip(inet)       immutable, no SET
--   is_safe_webhook_url(text)  immutable, no SET
--
-- These are not ordinary functions. is_safe_webhook_url backs the CHECK
-- constraint webhook_endpoints_url_safe, which 20260917120000 then VALIDATEd —
-- so it is evaluated on every write to webhook_endpoints, under whatever
-- search_path the writing session happens to have. They are not SECURITY
-- DEFINER, so this is not the classic privilege-escalation setup; the exposure
-- is that the operators and casts they depend on (`<<=` on inet, `::inet`,
-- regexp_replace) resolve through the caller's path, and a role that can create
-- objects in a schema ahead of pg_catalog can change what `<<=` means. The
-- answer that comes back would still be a boolean, and the constraint would
-- still report that it had checked.
--
-- The bodies below are VERBATIM from 20260917120000. Only the SET clause is
-- added. The verify block at the bottom re-runs that migration's entire
-- 40-case table unchanged, which is the point: if the replacement changed
-- behaviour by so much as one address, it says so.
--
-- One real cost, stated rather than glossed: a function with a SET clause
-- cannot be inlined by the planner, so is_reserved_ip is now a real function
-- call instead of being folded into its caller. It is called once per URL, from
-- a plpgsql function, on writes to a table with tens of rows. Not measurable.

create or replace function public.parse_ip_literal(p_host text)
returns inet
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  parts  text[];
  n      int;
  i      int;
  k      int;
  part   text;
  v      numeric;
  total  numeric := 0;
  maxlast numeric;
  shift_last numeric;
begin
  p_host := lower(btrim(coalesce(p_host, '')));
  if p_host = '' then return null; end if;

  -- A trailing dot is legal in a fully-qualified name ("example.com.") and
  -- would otherwise produce an empty final part and be rejected here, which is
  -- harmless — but it also slips past the internal-suffix checks downstream, so
  -- strip it once, here, for everyone.
  p_host := rtrim(p_host, '.');
  if p_host = '' then return null; end if;

  -- IPv6: let Postgres parse it. Brackets are already stripped by the caller.
  if position(':' in p_host) > 0 then
    begin
      return p_host::inet;
    exception when others then
      return null;
    end;
  end if;

  parts := string_to_array(p_host, '.');
  n := coalesce(array_length(parts, 1), 0);
  if n < 1 or n > 4 then return null; end if;

  -- inet_aton's shorthand forms. The last part absorbs all remaining octets,
  -- which is why 169.254.43518 and 127.1 work and why a prefix regex misses
  -- them.
  --   a            32 bits
  --   a.b          b is 24 bits
  --   a.b.c        c is 16 bits
  --   a.b.c.d      8 bits each
  maxlast := case n when 1 then 4294967295 when 2 then 16777215
                    when 3 then 65535 else 255 end;

  -- How much the final part is shifted left: it occupies 5 - n octets.
  -- I first wrote 4 - n, which is the count of parts remaining rather than the
  -- count of octets the last part covers. It made 169.254.43518 evaluate to
  -- 11184126 (0.170.170.190) instead of 2852039166 — a non-reserved address,
  -- so the guard would have returned "safe" for a metadata URL while looking
  -- like it was doing arithmetic.
  shift_last := case n when 1 then 4294967296 when 2 then 16777216
                       when 3 then 65536 else 256 end;

  for i in 1 .. n loop
    part := parts[i];
    if part = '' then return null; end if;

    if part ~ '^0[xX][0-9a-f]+$' then
      -- Hex. Length-capped so an absurd literal cannot be turned into a
      -- denial of service inside a CHECK constraint.
      if length(part) > 10 then return null; end if;
      v := ('x' || lpad(substring(part from 3), 8, '0'))::bit(32)::bigint;
    elsif part ~ '^0[0-7]+$' then
      -- Octal. Note 010 is 8, not 10 — the reason 0251.0376.0251.0376 is
      -- 169.254.169.254.
      -- Loop variable `k`, not `i`: plpgsql scopes a FOR variable to its own
      -- body, so a nested `i` would shadow the outer one.
      if length(part) > 12 then return null; end if;
      v := 0;
      for k in 1 .. length(part) loop
        v := v * 8 + (substring(part from k for 1))::int;
      end loop;
    elsif part ~ '^(0|[1-9][0-9]*)$' then
      -- No leading zeros. A leading zero means octal, and the branch above has
      -- already had its chance — so "08" is not decimal 8, it is a malformed
      -- octal literal, exactly as inet_aton treats it.
      if length(part) > 10 then return null; end if;
      v := part::numeric;
    else
      -- Not numeric in any base: this is a hostname, not an address literal.
      return null;
    end if;

    if i < n then
      if v > 255 then return null; end if;
      total := total * 256 + v;
    else
      if v > maxlast then return null; end if;
      total := total * shift_last + v;
    end if;
  end loop;

  if total < 0 or total > 4294967295 then return null; end if;

  -- div(), not `/`. On numeric, `/` is exact division and ::bigint ROUNDS:
  -- 2852039166 / 16777216 is 169.9999…, which rounded to 170 and turned
  -- 169.254.169.254 into 170.255.170.254 — a perfectly ordinary public address
  -- that sails through every reserved-block test below.
  return (
    (div(total, 16777216) % 256)::text || '.' ||
    (div(total, 65536)    % 256)::text || '.' ||
    (div(total, 256)      % 256)::text || '.' ||
    (total                % 256)::text
  )::inet;
exception when others then
  -- A parse failure must not be readable as "safe". The caller treats NULL as
  -- "not an IP literal" and falls through to the hostname rules.
  return null;
end;
$$;

create or replace function public.is_reserved_ip(p_ip inet)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_ip is not null and (
    -- IPv4
    p_ip <<= '0.0.0.0/8'::inet          -- "this network"
    or p_ip <<= '10.0.0.0/8'::inet         -- private
    or p_ip <<= '100.64.0.0/10'::inet      -- carrier-grade NAT / cloud fabric
    or p_ip <<= '127.0.0.0/8'::inet        -- loopback
    or p_ip <<= '169.254.0.0/16'::inet     -- link-local — cloud metadata
    or p_ip <<= '172.16.0.0/12'::inet      -- private
    or p_ip <<= '192.0.0.0/24'::inet       -- IETF protocol assignments
    or p_ip <<= '192.0.2.0/24'::inet       -- TEST-NET-1
    or p_ip <<= '192.168.0.0/16'::inet     -- private
    or p_ip <<= '198.18.0.0/15'::inet      -- benchmarking
    or p_ip <<= '198.51.100.0/24'::inet    -- TEST-NET-2
    or p_ip <<= '203.0.113.0/24'::inet     -- TEST-NET-3
    or p_ip <<= '224.0.0.0/4'::inet        -- multicast
    or p_ip <<= '240.0.0.0/4'::inet        -- reserved, incl. 255.255.255.255
    -- IPv6
    or p_ip <<= '::/128'::inet             -- unspecified
    or p_ip <<= '::1/128'::inet            -- loopback
    or p_ip <<= 'fc00::/7'::inet           -- unique local
    or p_ip <<= 'fe80::/10'::inet          -- link-local
    or p_ip <<= 'ff00::/8'::inet           -- multicast
    or p_ip <<= '2001:db8::/32'::inet      -- documentation
    -- IPv4-mapped and 6to4/Teredo wrappers, which are how an IPv6 literal
    -- reaches an IPv4 metadata address: ::ffff:169.254.169.254.
    or p_ip <<= '::ffff:0:0/96'::inet
    or p_ip <<= '64:ff9b::/96'::inet
    or p_ip <<= '2002::/16'::inet
    or p_ip <<= '2001::/32'::inet
  );
$$;

create or replace function public.is_safe_webhook_url(p_url text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_host text;
  v_ip   inet;
begin
  if p_url is null or btrim(p_url) = '' then
    return false;
  end if;

  p_url := btrim(p_url);

  -- https only. Unchanged, and still the cheapest useful rule here.
  if p_url !~* '^https://' then
    return false;
  end if;

  -- Authority: everything between the scheme and the first /, ? or #.
  v_host := substring(p_url from '^https://([^/?#]+)');
  if v_host is null or v_host = '' then
    return false;
  end if;

  -- Strip userinfo. "https://expected.com@169.254.169.254/" is a classic, and
  -- it reads as expected.com to a human skimming the Integrations screen.
  v_host := regexp_replace(v_host, '^.*@', '');

  -- Port. IPv6 literals are bracketed, so the colon rule differs: for
  -- `[::1]:8443` the host is what is inside the brackets, and splitting on the
  -- first colon would yield a bare `[`.
  if v_host ~ '^\[' then
    v_host := substring(v_host from '^\[([^\]]*)\]');
  else
    v_host := split_part(v_host, ':', 1);
  end if;

  v_host := lower(btrim(coalesce(v_host, '')));
  v_host := rtrim(v_host, '.');

  if v_host = '' then
    return false;
  end if;

  -- Loopback and "this host" by name.
  if v_host in ('localhost', 'localhost.localdomain') then
    return false;
  end if;

  -- The address test. Decided by the value rather than the spelling — so the
  -- decimal, hex, octal and short-form literals are all caught here.
  v_ip := public.parse_ip_literal(v_host);
  if v_ip is not null then
    return not public.is_reserved_ip(v_ip);
  end if;

  -- Not a valid address literal. Before treating it as a name, require it to
  -- look like one: a resolvable public host ends in an alphabetic TLD.
  if v_host !~ '\.[a-z][a-z0-9-]*$' then
    return false;
  end if;

  -- Names that resolve inside a cloud or a LAN rather than on the internet.
  if v_host ~ '\.(internal|local|localdomain|intranet|lan|home|corp|private)$'
     or v_host = 'metadata.google.internal'
     or v_host ~ '^metadata\.' then
    return false;
  end if;

  return true;
end;
$$;

comment on function public.is_safe_webhook_url is
  'Rejects outbound webhook destinations that point back into our own network. https only; the host is parsed as an address (inet_aton semantics) and tested against reserved CIDRs by containment, so notation tricks do not help; unqualified and internal-suffix names are refused. Does NOT defeat DNS rebinding — that needs egress filtering, not a write-time check. search_path pinned on 24 September 2026; the 17 September rewrite dropped the pin while leaving this backing a CHECK constraint.';

-- ════════════════════════════════════════════════════════════════════════════
-- 4. A safety net under the cron_secret seed
-- ════════════════════════════════════════════════════════════════════════════
-- 20260903140000:52 seeds the secret like this:
--
--   insert into public.app_settings (key, value)
--   values ('cron_secret', 'REPLACE_WITH_YOUR_CRON_SECRET')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
--
-- DO UPDATE, not DO NOTHING. So replaying that migration against a database
-- where the secret is configured overwrites the real secret with the
-- placeholder — and call_edge_function() explicitly refuses to run with the
-- placeholder:
--
--   if secret is null or secret = 'REPLACE_WITH_YOUR_CRON_SECRET' then
--     raise exception 'cron_secret is not configured in app_settings';
--
-- which stops every edge-function cron job in the product. That is not a
-- hypothetical: it is Layer 1 of the 14 September post-mortem, the state that
-- produced 2,502 silent failures over eight days, and one `supabase db push`
-- against a database whose migration history has been reset would recreate it
-- exactly.
--
-- I cannot fix the migration — it is applied, and editing an applied migration
-- changes nothing live while making the repo lie about what was run. So the
-- fix goes where it can still act: a BEFORE trigger that refuses the specific
-- transition "configured secret → placeholder".
--
-- ── Refuse-and-warn rather than raise ───────────────────────────────────────
-- Raising would abort the replay, which is louder and arguably more correct.
-- But the whole point is to protect a running production system from a routine
-- operation, and an exception here turns "your migration replay skipped one
-- line" into "your migration replay failed" — which invites someone to work
-- around it at 1am by deleting the trigger. Keeping the good value and shouting
-- leaves the system running and the message in the output.
--
-- Deliberately narrow. It fires only for key = 'cron_secret', only when the NEW
-- value is exactly the placeholder, and only when the OLD value is something
-- else. A first install (INSERT, or UPDATE from the placeholder) is untouched,
-- so a fresh database still seeds normally.

create or replace function public.guard_cron_secret_placeholder()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.key <> 'cron_secret' then
    return new;
  end if;

  if btrim(coalesce(new.value, '')) <> 'REPLACE_WITH_YOUR_CRON_SECRET' then
    return new;
  end if;

  -- INSERT: nothing to protect. This is a fresh database being seeded.
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if btrim(coalesce(old.value, '')) in ('', 'REPLACE_WITH_YOUR_CRON_SECRET') then
    return new;
  end if;

  -- The deliberate escape hatch, for the one legitimate case: someone actually
  -- wants to reset to the placeholder.
  --   begin;
  --     set local abrobot.allow_cron_secret_reset = 'on';
  --     update public.app_settings set value = 'REPLACE_WITH_YOUR_CRON_SECRET'
  --      where key = 'cron_secret';
  --   commit;
  if coalesce(current_setting('abrobot.allow_cron_secret_reset', true), 'off') = 'on' then
    raise warning 'cron_secret reset to the placeholder, as explicitly requested via abrobot.allow_cron_secret_reset';
    return new;
  end if;

  raise warning 'REFUSED to overwrite the configured cron_secret with the placeholder. This is almost certainly 20260903140000 being replayed; accepting it would have stopped every edge-function cron job (see the 14 September post-mortem in 20260914120000). The existing secret has been kept. To reset deliberately, set abrobot.allow_cron_secret_reset = ''on'' first.';

  -- Keep the configured value; let the rest of the row (updated_at) through, so
  -- the attempt is still visible as a timestamp change.
  new.value := old.value;
  return new;
end;
$$;

comment on function public.guard_cron_secret_placeholder is
  'Refuses the single transition "configured cron_secret → placeholder". 20260903140000 seeds the secret with ON CONFLICT DO UPDATE, so replaying it against a configured database silently disables every edge-function cron job. That migration cannot be edited once applied, so the guard lives here.';

drop trigger if exists app_settings_cron_secret_guard on public.app_settings;
create trigger app_settings_cron_secret_guard
  before insert or update on public.app_settings
  for each row
  execute function public.guard_cron_secret_placeholder();

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- Verify
-- ════════════════════════════════════════════════════════════════════════════
-- Rows 1–5 are PASS/FAIL. Row 6 is the 40-case SSRF table from 20260917120000,
-- re-run unchanged: it is the only thing that proves adding SET search_path did
-- not alter the guard's behaviour. Row 7 reports live state — whether the
-- production secret is currently configured — which no file can know.

select * from (

  -- 1. recent_cron_failures is no longer reachable from a browser session.
  select 1 as ord, 'recent_cron_failures: authenticated and anon cannot execute' as check,
         case when to_regprocedure('public.recent_cron_failures(integer)') is null
              then 'FAIL — function not found'
         when (select coalesce(string_agg(distinct coalesce(r.rolname, 'PUBLIC'), ', '), '')
                 from pg_proc p
                 cross join lateral aclexplode(p.proacl) a
                 left join pg_roles r on r.oid = a.grantee
                where p.oid = to_regprocedure('public.recent_cron_failures(integer)')::oid
                  and a.privilege_type = 'EXECUTE'
                  and coalesce(r.rolname, 'PUBLIC') in ('PUBLIC','anon','authenticated')) = ''
              then 'PASS — executable only by the owner and service_role'
              else 'FAIL — still granted to: ' ||
                   (select string_agg(distinct coalesce(r.rolname, 'PUBLIC'), ', ')
                      from pg_proc p
                      cross join lateral aclexplode(p.proacl) a
                      left join pg_roles r on r.oid = a.grantee
                     where p.oid = to_regprocedure('public.recent_cron_failures(integer)')::oid
                       and a.privilege_type = 'EXECUTE'
                       and coalesce(r.rolname, 'PUBLIC') in ('PUBLIC','anon','authenticated'))
         end as detail

  -- 2. plan_seat_cap: anon and PUBLIC out, authenticated still in.
  union all
  select 2, 'plan_seat_cap: PUBLIC/anon revoked, authenticated kept',
         case when to_regprocedure('public.plan_seat_cap(uuid)') is null
              then 'FAIL — function not found'
         when (select count(*) from pg_proc p
                 cross join lateral aclexplode(p.proacl) a
                 left join pg_roles r on r.oid = a.grantee
                where p.oid = to_regprocedure('public.plan_seat_cap(uuid)')::oid
                  and a.privilege_type = 'EXECUTE'
                  and coalesce(r.rolname, 'PUBLIC') in ('PUBLIC','anon')) > 0
              then 'FAIL — PUBLIC or anon still holds EXECUTE'
         when (select count(*) from pg_proc p
                 cross join lateral aclexplode(p.proacl) a
                 join pg_roles r on r.oid = a.grantee
                where p.oid = to_regprocedure('public.plan_seat_cap(uuid)')::oid
                  and a.privilege_type = 'EXECUTE' and r.rolname = 'authenticated') = 0
              then 'FAIL — authenticated lost EXECUTE, the Plan & usage screen will break'
              else 'PASS'
         end

  -- 3. ensure_profile: same test.
  union all
  select 3, 'ensure_profile: PUBLIC/anon revoked, authenticated kept',
         case when to_regprocedure('public.ensure_profile()') is null
              then 'FAIL — function not found'
         when (select count(*) from pg_proc p
                 cross join lateral aclexplode(p.proacl) a
                 left join pg_roles r on r.oid = a.grantee
                where p.oid = to_regprocedure('public.ensure_profile()')::oid
                  and a.privilege_type = 'EXECUTE'
                  and coalesce(r.rolname, 'PUBLIC') in ('PUBLIC','anon')) > 0
              then 'FAIL — PUBLIC or anon still holds EXECUTE'
         when (select count(*) from pg_proc p
                 cross join lateral aclexplode(p.proacl) a
                 join pg_roles r on r.oid = a.grantee
                where p.oid = to_regprocedure('public.ensure_profile()')::oid
                  and a.privilege_type = 'EXECUTE' and r.rolname = 'authenticated') = 0
              then 'FAIL — authenticated lost EXECUTE, sign-in will break'
              else 'PASS'
         end

  -- 4. The three SSRF functions carry a pinned path again.
  union all
  select 4, 'parse_ip_literal / is_reserved_ip / is_safe_webhook_url: search_path pinned',
         case when (select count(*) from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'
                       and p.proname in ('parse_ip_literal','is_reserved_ip','is_safe_webhook_url')
                       and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path=public, pg_temp%') = 3
              then 'PASS — 3 of 3'
              else 'FAIL — only ' || (select count(*)::text from pg_proc p
                                        join pg_namespace n on n.oid = p.pronamespace
                                       where n.nspname = 'public'
                                         and p.proname in ('parse_ip_literal','is_reserved_ip','is_safe_webhook_url')
                                         and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path=public, pg_temp%')
                   || ' of 3 pinned'
         end

  -- 5. The cron_secret guard is attached.
  union all
  select 5, 'cron_secret placeholder guard is installed',
         case when exists (select 1 from pg_trigger
                            where tgrelid = 'public.app_settings'::regclass
                              and tgname = 'app_settings_cron_secret_guard'
                              and not tgisinternal)
              then 'PASS — replaying 20260903140000 can no longer blank a configured secret'
              else 'FAIL — trigger missing'
         end

  -- 6. The behavioural proof. Copied unchanged from 20260917120000 so that a
  --    difference in outcome is a difference caused by this file.
  union all
  select 6, 'SSRF guard behaviour is unchanged by the search_path pin',
         (with cases(url, should_pass, why) as (values
            ('https://2852039166/hook',              false, 'decimal 169.254.169.254'),
            ('https://0xa9fea9fe/hook',              false, 'hex 169.254.169.254'),
            ('https://0251.0376.0251.0376/hook',     false, 'octal 169.254.169.254'),
            ('https://169.254.43518/hook',           false, 'three-part 169.254.169.254'),
            ('https://0xa9.0xfe.0xa9.0xfe/hook',     false, 'per-octet hex'),
            ('https://2130706433/hook',              false, 'decimal 127.0.0.1'),
            ('https://127.1/hook',                   false, 'two-part loopback'),
            ('https://0x7f000001/hook',              false, 'hex loopback'),
            ('https://017700000001/hook',            false, 'octal loopback'),
            ('https://[::ffff:169.254.169.254]/x',   false, 'IPv4-mapped metadata'),
            ('https://[::ffff:a9fe:a9fe]/x',         false, 'IPv4-mapped, hex form'),
            ('https://expected.com@169.254.169.254/', false, 'userinfo disguise'),
            ('https://169.254.169.254./hook',        false, 'trailing dot'),
            ('https://127.0.0.1/hook',               false, 'plain loopback'),
            ('https://10.0.0.5/hook',                false, 'private'),
            ('https://192.168.1.1/hook',             false, 'private'),
            ('https://172.16.0.1/hook',              false, 'private'),
            ('https://100.100.100.200/hook',         false, 'CGNAT'),
            ('https://localhost:8443/hook',          false, 'loopback by name'),
            ('https://[::1]:8443/hook',              false, 'IPv6 loopback'),
            ('https://[fd00::1]/hook',               false, 'unique local'),
            ('https://metadata.google.internal/x',   false, 'cloud metadata by name'),
            ('https://build.corp/hook',              false, 'internal suffix'),
            ('https://intranet/hook',                false, 'single label'),
            ('http://example.com/hook',              false, 'not https'),
            ('https://255.255.255.255/hook',         false, 'broadcast'),
            ('https://224.0.0.1/hook',               false, 'multicast'),
            ('https://08.1.1.1/hook',                false, 'malformed octal, not decimal 8'),
            ('https://1.2.3.4.5/hook',               false, 'five parts'),
            ('https://999.1.1.1/hook',               false, 'octet out of range'),
            ('https://0x1.0x2.0x3.0x4.0x5/hook',     false, 'five hex parts'),
            ('https://example.com/hooks/abrobot',    true,  'ordinary host'),
            ('https://hooks.slack.com/services/A/B', true,  'slack'),
            ('https://api.customer.co.in:8443/hook', true,  'explicit port'),
            ('https://8.8.8.8/hook',                 true,  'public IP literal'),
            ('https://1.1.1.1/hook',                 true,  'public IP literal'),
            ('https://169.253.1.1/hook',             true,  'adjacent to link-local but public'),
            ('https://172.15.0.1/hook',              true,  'just below the private block'),
            ('https://172.32.0.1/hook',              true,  'just above the private block'),
            ('https://100.63.255.255/hook',          true,  'just below CGNAT'),
            ('https://100.128.0.1/hook',             true,  'just above CGNAT'),
            ('https://[2606:4700::1111]/hook',       true,  'public IPv6'),
            ('https://my.local.customer.com/hook',   true,  'internal word not in suffix position')
          )
          select case when count(*) filter (where public.is_safe_webhook_url(url) <> should_pass) = 0
                      then 'PASS — all ' || count(*) || ' cases still behave exactly as they did'
                      else 'FAIL — ' || count(*) filter (where public.is_safe_webhook_url(url) <> should_pass)
                           || ' of ' || count(*) || ' changed: '
                           || string_agg(url || ' (' || why || ')', '; ')
                              filter (where public.is_safe_webhook_url(url) <> should_pass)
                 end
            from cases)

  -- 7. ── LIVE STATE ─────────────────────────────────────────────────────────
  --    Is the secret currently a real one? The guard only protects a configured
  --    secret; if this says placeholder, the cron jobs are already dead and the
  --    guard is protecting nothing.
  union all
  select 7, 'cron_secret right now',
         coalesce((select case
                            when btrim(value) = 'REPLACE_WITH_YOUR_CRON_SECRET'
                              then '⚠ STILL THE PLACEHOLDER — every edge-function cron job is failing right now, and has been since it was set. call_edge_function() raises on it.'
                            when btrim(value) = '' then '⚠ EMPTY'
                            when value <> btrim(value)
                              then '⚠ configured BUT has leading/trailing whitespace — call_edge_function btrims it, so this works, but cron-auth.ts must too (Layer 3 of the 14 Sep post-mortem)'
                            else 'configured (' || left(btrim(value), 4) || '…, ' || length(btrim(value))::text || ' chars)'
                          end
                     from public.app_settings where key = 'cron_secret'),
                  '⚠ no cron_secret row at all')

) t order by ord;

-- ── Smoke tests worth running by hand ───────────────────────────────────────
-- The guard, without touching anything (rolls back):
--
--   begin;
--     update public.app_settings set value = 'REPLACE_WITH_YOUR_CRON_SECRET'
--      where key = 'cron_secret';
--     select left(value, 4) from public.app_settings where key = 'cron_secret';
--     -- expect: the real secret, and a WARNING in the output
--   rollback;
--
-- The revokes, from the app: sign in as an ordinary counsellor and call
-- /rest/v1/rpc/recent_cron_failures — expect 42501, not a list of other
-- customers' webhook errors. Then load Settings → Plan & usage, which calls
-- plan_seat_cap, and confirm it still renders.
