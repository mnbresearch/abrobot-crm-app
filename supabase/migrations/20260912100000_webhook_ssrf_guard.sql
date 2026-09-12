-- SECURITY FIX — stop a tenant pointing an outbound webhook at our own network.
--
-- ── The hole ────────────────────────────────────────────────────────────────
-- `webhook_endpoints.url` is declared `text not null` with NO constraint. The
-- only validation is in the browser:
--
--     Integrations.tsx:213  try { u = new URL(epUrl.trim()); } catch { … }
--     Integrations.tsx:215  if (u.protocol !== "https:") { … }
--
-- That is a usability check, not a control. `webhook_endpoints` is an ordinary
-- table and an org_admin — which is whoever signs up, free, self-serve — can
-- INSERT into it directly through PostgREST and skip the form entirely:
--
--     POST /rest/v1/webhook_endpoints
--     { "org_id": "<their own org>", "events": ["lead.created"],
--       "url": "http://169.254.169.254/latest/meta-data/" }
--
-- Then they create a lead in their own account, and `fire_webhooks` — which is
-- SECURITY DEFINER — does this (20260905090000):
--
--     perform net.http_post(url := ep.url, …)
--
-- `net.http_post` is pg_net. The request leaves from INSIDE the Postgres
-- network, which is the most privileged network position in the system. The
-- attacker has turned our database into an HTTP client pointed wherever they
-- like: cloud metadata at 169.254.169.254, 127.0.0.1, 10.0.0.0/8, internal
-- Supabase services, anything not exposed to the internet.
--
-- ── How bad ─────────────────────────────────────────────────────────────────
-- BLIND, not full read. `webhook_deliveries` records `status_code`, `error` and
-- `duration_ms` — it never stores the response body, so the attacker sees the
-- shape of the answer and not its contents. That is still a usable oracle for
-- port scanning and service discovery, and some metadata endpoints act on the
-- request rather than merely answering it. It also makes us an outbound relay
-- that sends attacker-chosen, HMAC-signed traffic to arbitrary hosts.
--
-- Moderate rather than critical, and worth closing before there is a customer
-- who is not you.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
-- Validate in the database, where the browser cannot be skipped. https only,
-- and no loopback, private, link-local or internal-suffix destination.
--
-- Honest about the limit: this blocks literals and obvious names. It does NOT
-- stop DNS rebinding — a hostname that resolves to 169.254.169.254 at request
-- time passes, because Postgres cannot resolve-then-pin before pg_net dials.
-- Closing that properly means moving delivery out of pg_net and into an edge
-- function that resolves the host, checks the IP, and connects to the IP it
-- checked. Noted at the bottom as the real fix; this raises the bar meanwhile.

begin;

create or replace function public.is_safe_webhook_url(p_url text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  v_host text;
begin
  if p_url is null or length(p_url) > 2000 then
    return false;
  end if;

  -- https only. http would also expose the signed payload in clear text on the
  -- wire, so this is two controls in one.
  if p_url !~* '^https://' then
    return false;
  end if;

  -- Extract the host, in the order a browser would.
  v_host := substring(p_url from 9);                    -- drop 'https://'
  v_host := regexp_replace(v_host, '[/?#].*$', '');     -- drop path, query, fragment

  -- Drop userinfo. Greedy `^.*@` removes up to the LAST @, which is what the
  -- URL spec says the host is. `https://example.com@127.0.0.1/` reads as
  -- external to a careless parser and dials loopback — this is the single most
  -- common way an SSRF allowlist gets walked past.
  v_host := regexp_replace(v_host, '^.*@', '');

  -- Port. IPv6 literals are bracketed, so the colon rule differs: for
  -- `[::1]:8443` the host is what is inside the brackets, and splitting on the
  -- first colon would yield a bare `[`.
  if v_host ~ '^\[' then
    v_host := substring(v_host from '^\[([^\]]*)\]');
  else
    v_host := split_part(v_host, ':', 1);
  end if;

  v_host := lower(coalesce(v_host, ''));

  if v_host = '' then
    return false;
  end if;

  -- Loopback and "this host" by name.
  if v_host in ('localhost', 'localhost.localdomain', '127.0.0.1', '0.0.0.0', '::1', '[::1]') then
    return false;
  end if;

  -- IPv4 literals in the ranges that are never a customer's server.
  --   127./8      loopback
  --   10./8       private
  --   172.16-31   private
  --   192.168./16 private
  --   169.254./16 link-local — this is where cloud metadata lives
  --   0./8        "this network"
  --   100.64-127  carrier-grade NAT, used by some cloud internal fabrics
  if v_host ~ '^127\.' or v_host ~ '^10\.' or v_host ~ '^192\.168\.'
     or v_host ~ '^169\.254\.' or v_host ~ '^0\.'
     or v_host ~ '^172\.(1[6-9]|2[0-9]|3[01])\.'
     or v_host ~ '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.' then
    return false;
  end if;

  -- IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10).
  -- Brackets are already stripped above, so these match the bare address.
  -- `::ffff:127.0.0.1` is the IPv4-mapped form of loopback and is caught too.
  if v_host in ('::1', '::') or v_host ~ '^(fc|fd)[0-9a-f]{2}:' or v_host ~ '^fe80:'
     or v_host ~ '^::ffff:(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)' then
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
  'Rejects outbound webhook destinations that point back into our own network. https only; no loopback, private, link-local, CGNAT or internal-suffix host. Does NOT defeat DNS rebinding — see 20260912100000 for why and what the real fix is.';

-- NOT VALID deliberately.
--
-- It applies to every INSERT and UPDATE from now on, which is the entire point,
-- but it does not re-check rows that already exist. A migration that refuses to
-- apply because of pre-existing data is a migration that does not get applied,
-- and the verification below lists any offending rows so they can be dealt with
-- deliberately rather than by an aborted transaction.
alter table public.webhook_endpoints
  drop constraint if exists webhook_endpoints_url_safe;

alter table public.webhook_endpoints
  add constraint webhook_endpoints_url_safe
  check (public.is_safe_webhook_url(url)) not valid;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select 'the constraint exists' as check,
       case when exists (select 1 from pg_constraint
                          where conname = 'webhook_endpoints_url_safe')
            then 'PASS' else 'FAIL' end as result
union all
select 'https is required',
       case when not public.is_safe_webhook_url('http://example.com/hook')
            then 'PASS' else 'FAIL' end
union all
select 'cloud metadata is blocked',
       case when not public.is_safe_webhook_url('https://169.254.169.254/latest/meta-data/')
            then 'PASS' else 'FAIL' end
union all
select 'loopback is blocked',
       case when not public.is_safe_webhook_url('https://127.0.0.1:8000/x')
             and not public.is_safe_webhook_url('https://localhost/x')
            then 'PASS' else 'FAIL' end
union all
select 'private ranges are blocked',
       case when not public.is_safe_webhook_url('https://10.0.0.5/x')
             and not public.is_safe_webhook_url('https://192.168.1.1/x')
             and not public.is_safe_webhook_url('https://172.16.0.1/x')
            then 'PASS' else 'FAIL' end
union all
select 'the userinfo trick is blocked',
       case when not public.is_safe_webhook_url('https://example.com@127.0.0.1/x')
            then 'PASS' else 'FAIL — https://good.com@127.0.0.1 still dials loopback' end
union all
select 'a real customer endpoint still works',
       case when public.is_safe_webhook_url('https://hooks.zapier.com/hooks/catch/123/abc')
             and public.is_safe_webhook_url('https://api.mycompany.co.in:8443/crm/webhook')
            then 'PASS' else 'FAIL — legitimate endpoints are being rejected' end
union all
-- Anything already stored that the constraint would now reject. Expected: none.
-- If this lists rows, look at them before deciding — they are either a mistake
-- or someone testing the hole.
select 'existing rows that would now be rejected',
       coalesce((select string_agg(o.slug || ' -> ' || e.url, ' | ')
                   from public.webhook_endpoints e
                   join public.organizations o on o.id = e.org_id
                  where not public.is_safe_webhook_url(e.url)),
                'none');

-- ── Still open, deliberately ────────────────────────────────────────────────
-- DNS rebinding defeats every hostname check, including this one. The real fix
-- is to stop delivering webhooks from inside Postgres:
--
--   1. Replace the net.http_post call in fire_webhooks with a queue row.
--   2. Deliver from an edge function that resolves the hostname, rejects the
--      resolved IP if it is private, and connects to that IP with a Host
--      header — so the address checked is the address dialled.
--
-- That also gets retries, backoff and per-delivery logging out of the database,
-- which is where they belong. Until then, delivery leaves from the DB network
-- and this constraint is what stands in front of it.
