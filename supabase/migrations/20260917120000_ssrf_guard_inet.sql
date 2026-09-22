-- AbroBot CRM — make the SSRF guard test addresses instead of spellings.
-- (Audit H4.)
--
-- ════════════════════════════════════════════════════════════════════════════
-- The bug
-- ════════════════════════════════════════════════════════════════════════════
-- 20260912100000 blocks internal destinations with string-prefix regexes:
--
--     if v_host ~ '^169\.254\.' or v_host ~ '^127\.' or … then return false;
--
-- That tests how an address is *written*, and an IPv4 address has many
-- spellings. Every one of these reaches 169.254.169.254, the cloud metadata
-- endpoint, and not one of them starts with "169.":
--
--     https://2852039166/            decimal
--     https://0xa9fea9fe/            hex
--     https://0251.0376.0251.0376/   octal
--     https://169.254.43518/         three-part, last part 16-bit
--     https://0xa9.0xfe.0xa9.0xfe/   per-octet hex
--
-- and the same trick reaches loopback: https://2130706433/, https://127.1/,
-- https://0x7f000001/.
--
-- The receiving side does not care about the spelling. inet_aton — which is
-- what curl, and pg_net underneath it, ultimately use — accepts all of these
-- and resolves them to the same 32 bits. So the guard and the thing it guards
-- disagreed about what the string meant, which is the whole vulnerability.
--
-- ════════════════════════════════════════════════════════════════════════════
-- The fix
-- ════════════════════════════════════════════════════════════════════════════
-- Stop pattern-matching text. Parse the host into an actual address using the
-- same rules the network stack uses, then ask Postgres's inet type whether it
-- falls inside a reserved block. `<<=` is real subnet containment; it cannot be
-- fooled by notation, because by then there is no notation left — only 32 bits.
--
-- What this still does NOT defeat: DNS rebinding. attacker.com can resolve to a
-- public address when this constraint runs and to 169.254.169.254 when pg_net
-- connects, and nothing checkable at write time can prevent that. The honest
-- mitigation is egress filtering at the network layer. This closes the literal
-- bypasses, which are the ones anyone can use today from the Integrations
-- screen with no infrastructure at all.

begin;

-- ── 1. Parse a host the way inet_aton does ──────────────────────────────────

create or replace function public.parse_ip_literal(p_host text)
returns inet
language plpgsql
immutable
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
  -- like it was doing arithmetic. Verified against every case in the block at
  -- the bottom of this file.
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
      -- body, so a nested `i` would shadow the outer one. It happens to work,
      -- and it is the kind of thing that stops working the moment someone
      -- moves a line.
      if length(part) > 12 then return null; end if;
      v := 0;
      for k in 1 .. length(part) loop
        v := v * 8 + (substring(part from k for 1))::int;
      end loop;
    elsif part ~ '^(0|[1-9][0-9]*)$' then
      -- No leading zeros. A leading zero means octal, and the branch above has
      -- already had its chance — so "08" is not decimal 8, it is a malformed
      -- octal literal, exactly as inet_aton treats it. Accepting it here would
      -- have made this parser more permissive than the stack it is modelling,
      -- and a guard that disagrees with the resolver is the whole bug.
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
  -- that sails through every reserved-block test below. The guard would have
  -- done all the parsing correctly and then approved the metadata endpoint on
  -- the last line. Caught by the case table at the bottom of this file, which
  -- is the entire reason it asserts exact addresses rather than just safe/unsafe.
  return (
    (div(total, 16777216) % 256)::text || '.' ||
    (div(total, 65536)    % 256)::text || '.' ||
    (div(total, 256)      % 256)::text || '.' ||
    (total                % 256)::text
  )::inet;
exception when others then
  -- A parse failure must not be readable as "safe". The caller treats NULL as
  -- "not an IP literal" and falls through to the hostname rules, which is the
  -- correct conservative reading: an unparseable numeric-looking host is not a
  -- host we can vouch for either way, and the scheme/suffix checks still apply.
  return null;
end;
$$;

comment on function public.parse_ip_literal is
  'Parses a host string into an inet using inet_aton semantics: decimal, octal and hex parts, and the 1-, 2- and 3-part shorthand forms. Returns NULL when the host is not an address literal. Exists because the previous SSRF guard matched the spelling of an address rather than its value, so https://2852039166/ reached 169.254.169.254.';

-- ── 2. Blocks that are never a customer's webhook receiver ──────────────────

create or replace function public.is_reserved_ip(p_ip inet)
returns boolean
language sql
immutable
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

comment on function public.is_reserved_ip is
  'True when the address falls in a block no customer webhook receiver should live in. Uses inet containment, so it is immune to the notation tricks that defeat prefix matching.';

-- ── 3. The guard, rewritten around the two above ────────────────────────────

create or replace function public.is_safe_webhook_url(p_url text)
returns boolean
language plpgsql
immutable
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

  -- The address test. This replaces eight prefix regexes, and unlike them it
  -- is decided by the value rather than the spelling — so the decimal, hex,
  -- octal and short-form literals in the header are all caught here.
  v_ip := public.parse_ip_literal(v_host);
  if v_ip is not null then
    return not public.is_reserved_ip(v_ip);
  end if;

  -- Not a valid address literal. Before treating it as a name, require it to
  -- look like one: a resolvable public host ends in an alphabetic TLD.
  --
  -- This is what catches the near-misses — "08.1.1.1", "1.2.3.4.5",
  -- "999.1.1.1", "0x1.0x2.0x3.0x4.0x5". Each fails to parse as an address and
  -- would otherwise fall through to the name rules, which see dots, no
  -- internal suffix, and wave it past. Whether any of them resolves to
  -- anything is not a question worth leaving open: nothing legitimate is
  -- shaped this way, so refuse.
  if v_host !~ '\.[a-z][a-z0-9-]*$' then
    return false;
  end if;

  -- Names that resolve inside a cloud or a LAN rather than on the internet.
  -- (A single label is already refused above — it has no dot, so no TLD, and
  -- it resolves through the local search domain, which is precisely the
  -- network we are trying not to reach.)
  if v_host ~ '\.(internal|local|localdomain|intranet|lan|home|corp|private)$'
     or v_host = 'metadata.google.internal'
     or v_host ~ '^metadata\.' then
    return false;
  end if;

  return true;
end;
$$;

comment on function public.is_safe_webhook_url is
  'Rejects outbound webhook destinations that point back into our own network. https only; the host is parsed as an address (inet_aton semantics) and tested against reserved CIDRs by containment, so notation tricks do not help; unqualified and internal-suffix names are refused. Does NOT defeat DNS rebinding — that needs egress filtering, not a write-time check.';

-- ── 4. Make the constraint actually cover existing rows ─────────────────────
-- It was added NOT VALID, for a good reason at the time: a migration that
-- refuses to apply because of pre-existing data is a migration that does not
-- get applied. But that left it unproven, and fire_webhooks never re-checks,
-- so an endpoint written before 12 September was never tested by anything.
--
-- VALIDATE takes only a SHARE UPDATE EXCLUSIVE lock — it does not block reads
-- or writes — and the table is small. If it raises, the message names the row,
-- which is the information needed to deal with it deliberately.
alter table public.webhook_endpoints validate constraint webhook_endpoints_url_safe;

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- Verify — every bypass in the header, plus the cases that must still work
-- ════════════════════════════════════════════════════════════════════════════
with cases(url, should_pass, why) as (values
  -- The bypasses. All of these reached 169.254.169.254 or 127.0.0.1 before.
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
  -- Things the old guard already caught, which must stay caught.
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
  -- Near-misses: not valid literals, not plausible names either.
  ('https://08.1.1.1/hook',                false, 'malformed octal, not decimal 8'),
  ('https://1.2.3.4.5/hook',               false, 'five parts'),
  ('https://999.1.1.1/hook',               false, 'octet out of range'),
  ('https://0x1.0x2.0x3.0x4.0x5/hook',     false, 'five hex parts'),
  -- Real customer endpoints. These must keep working.
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
            then 'PASS — all ' || count(*) || ' cases behave as specified'
            else 'FAIL — ' || count(*) filter (where public.is_safe_webhook_url(url) <> should_pass)
                 || ' of ' || count(*) || ' wrong: '
                 || string_agg(url || ' (' || why || ')', '; ')
                    filter (where public.is_safe_webhook_url(url) <> should_pass)
       end as result
from cases;
