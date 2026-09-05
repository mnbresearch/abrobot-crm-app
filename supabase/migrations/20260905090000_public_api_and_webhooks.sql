-- AbroBot CRM — the integration layer: API keys, a public REST API, and
-- outbound webhooks.
-- NOT APPLIED.
--
-- Why this exists: pricing.html sells Business at ₹4,999 with "API & webhooks".
-- Neither existed in any form. There was no way to read data out, and nothing
-- anywhere fired when a record was created or a stage changed. Meanwhile the
-- Install tab told customers to "create a key under webhook keys first" —
-- a screen that was never built, so even inbound capture was unreachable.
--
-- Three pieces:
--   1. api_keys          — customer-generated credentials for the REST API
--   2. webhook_endpoints — customer URLs we POST to when something happens
--   3. webhook_deliveries — the attempt log, because a webhook you cannot
--                           debug is a webhook you cannot trust
--
-- Idempotent.

begin;

create extension if not exists pgcrypto;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. API keys
-- ════════════════════════════════════════════════════════════════════════════
-- The raw key is shown ONCE, at creation, and never stored. What we keep is a
-- SHA-256 hash. If this table leaks, the keys in it cannot be used — the same
-- reason nobody stores passwords in plaintext, and the reason "we'll email you
-- your key" is always a red flag.
--
-- key_prefix exists so the UI can say "abk_live_7f2a…" in a list without
-- holding anything usable.

create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  name         text not null,
  key_hash     text not null unique,
  key_prefix   text not null,
  -- Least privilege by default. 'leads:read' is a very different grant from
  -- 'leads:write', and a customer wiring up a reporting dashboard should not
  -- have to hand it a key that can also modify records.
  scopes       text[] not null default array['leads:read'],
  last_used_at timestamptz,
  use_count    bigint not null default 0,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  expires_at   timestamptz
);

create index if not exists api_keys_org_idx on public.api_keys (org_id, created_at desc);
create index if not exists api_keys_hash_idx on public.api_keys (key_hash) where revoked_at is null;

alter table public.api_keys enable row level security;

-- Admins only. A counsellor who can mint an API key can exfiltrate the whole
-- org through it, quietly, from anywhere, and keep doing so after being
-- disabled — because revoking a login does not revoke a bearer token.
drop policy if exists api_keys_admin on public.api_keys;
create policy api_keys_admin on public.api_keys
  for all using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  ) with check (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  );

-- Mint a key. Returns the raw value exactly once.
create or replace function public.create_api_key(
  p_name text,
  p_scopes text[] default array['leads:read'],
  p_expires_days integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org    uuid := public.my_org();
  v_raw    text;
  v_hash   text;
  v_id     uuid;
  v_valid  text[] := array['leads:read','leads:write','conversations:read','stages:read'];
  s        text;
begin
  if not (public.is_super_admin() or (v_org is not null and public.is_org_admin())) then
    raise exception 'only an admin can create API keys' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Give the key a name so you can tell them apart later';
  end if;

  foreach s in array p_scopes loop
    if not (s = any(v_valid)) then
      raise exception 'unknown scope: % (valid: %)', s, array_to_string(v_valid, ', ');
    end if;
  end loop;

  -- abk_live_ + 32 random bytes as hex. The prefix makes a leaked key
  -- recognisable in a log or a GitHub scan.
  v_raw  := 'abk_live_' || encode(gen_random_bytes(32), 'hex');
  v_hash := encode(digest(v_raw, 'sha256'), 'hex');

  insert into public.api_keys (org_id, name, key_hash, key_prefix, scopes, created_by, expires_at)
  values (
    v_org, trim(p_name), v_hash, left(v_raw, 17), p_scopes, auth.uid(),
    case when p_expires_days is null then null else now() + make_interval(days => p_expires_days) end
  )
  returning id into v_id;

  return jsonb_build_object(
    'ok', true, 'id', v_id, 'key', v_raw, 'prefix', left(v_raw, 17), 'scopes', p_scopes,
    'warning', 'This is the only time the key will be shown. Store it now.'
  );
end;
$$;

grant execute on function public.create_api_key(text, text[], integer) to authenticated;
revoke all on function public.create_api_key(text, text[], integer) from public, anon;

-- Used by the API function (service role) to authenticate a request.
create or replace function public.resolve_api_key(p_raw text)
returns table (org_id uuid, key_id uuid, scopes text[])
language plpgsql
security definer
set search_path = public
as $$
declare v_hash text;
begin
  if p_raw is null or p_raw = '' then return; end if;
  v_hash := encode(digest(p_raw, 'sha256'), 'hex');

  return query
    update public.api_keys k
       set last_used_at = now(), use_count = k.use_count + 1
     where k.key_hash = v_hash
       and k.revoked_at is null
       and (k.expires_at is null or k.expires_at > now())
    returning k.org_id, k.id, k.scopes;
end;
$$;

revoke all on function public.resolve_api_key(text) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Outbound webhooks
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.webhook_endpoints (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  url           text not null,
  -- Used to HMAC-sign every payload, so the receiver can prove the call came
  -- from us. Without it a webhook URL is an open endpoint anyone can forge.
  secret        text not null default encode(gen_random_bytes(24), 'hex'),
  events        text[] not null default array['lead.created'],
  active        boolean not null default true,
  description   text,
  -- Consecutive failures. An endpoint that has been dead for days should stop
  -- being retried forever; see the auto-disable in deliver_webhooks().
  failure_count integer not null default 0,
  last_status   integer,
  last_error    text,
  last_success_at timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists webhook_endpoints_org_idx
  on public.webhook_endpoints (org_id) where active;

alter table public.webhook_endpoints enable row level security;

drop policy if exists webhook_endpoints_admin on public.webhook_endpoints;
create policy webhook_endpoints_admin on public.webhook_endpoints
  for all using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  ) with check (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  );

-- Every attempt, kept for 7 days. This is the difference between "your webhook
-- isn't working" and "here is the 500 your server returned at 14:03".
create table if not exists public.webhook_deliveries (
  id          uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.webhook_endpoints(id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  event       text not null,
  payload     jsonb not null,
  status_code integer,
  error       text,
  duration_ms integer,
  created_at  timestamptz not null default now()
);

create index if not exists webhook_deliveries_endpoint_idx
  on public.webhook_deliveries (endpoint_id, created_at desc);

alter table public.webhook_deliveries enable row level security;

drop policy if exists webhook_deliveries_read on public.webhook_deliveries;
create policy webhook_deliveries_read on public.webhook_deliveries
  for select using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  );

-- ── Firing them ─────────────────────────────────────────────────────────────
-- pg_net, so a slow or hanging customer endpoint can never block the request
-- that triggered it. A CRM that stops accepting leads because someone's Zapier
-- is down would be a poor trade.

create or replace function public.fire_webhooks(
  p_org_id uuid, p_event text, p_payload jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, net
as $$
declare
  ep  record;
  n   integer := 0;
  body jsonb;
  sig  text;
begin
  for ep in
    select * from public.webhook_endpoints
     where org_id = p_org_id and active and p_event = any(events)
  loop
    body := jsonb_build_object(
      'event', p_event,
      'org_id', p_org_id,
      'created_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'data', p_payload
    );

    -- HMAC-SHA256 over the exact body we send, so the receiver can verify it.
    sig := encode(hmac(body::text, ep.secret, 'sha256'), 'hex');

    perform net.http_post(
      url     := ep.url,
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'X-AbroBot-Event', p_event,
                   'X-AbroBot-Signature', 'sha256=' || sig
                 ),
      body    := body,
      timeout_milliseconds := 8000
    );

    insert into public.webhook_deliveries (endpoint_id, org_id, event, payload)
    values (ep.id, p_org_id, p_event, body);

    n := n + 1;
  end loop;

  return n;
end;
$$;

revoke all on function public.fire_webhooks(uuid, text, jsonb) from public, anon, authenticated;

-- ── The trigger that makes it automatic ─────────────────────────────────────
-- Doing this in the database rather than in application code is deliberate:
-- leads are created by five different paths (webhook, chat widget, CSV import,
-- manual add, automations) and the audit found that event automations fired
-- from exactly one of them. A trigger cannot be forgotten by the sixth path.

create or replace function public.notify_lead_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  payload jsonb;
  evt     text;
begin
  payload := jsonb_build_object(
    'id', new.id, 'name', new.name, 'email', new.email, 'phone', new.phone,
    'source', new.source, 'stage', new.stage_key, 'score', new.score,
    'assigned_to', new.assigned_to, 'tags', new.tags, 'custom', new.custom,
    'created_at', new.created_at
  );

  if tg_op = 'INSERT' then
    evt := 'lead_created';
    perform public.fire_webhooks(new.org_id, 'lead.created', payload);
  elsif new.stage_key is distinct from old.stage_key then
    evt := 'stage_changed';
    payload := payload || jsonb_build_object('previous_stage', old.stage_key);
    perform public.fire_webhooks(new.org_id, 'lead.stage_changed', payload);
  else
    return new;
  end if;

  -- Event-driven automations, fired from here rather than from application code.
  --
  -- fireEventAutomations() was imported by exactly ONE of the five paths that
  -- create a lead (lead-webhook). The chat widget, CSV import, manual add and
  -- the new API all bypassed it — so "when a record is created" rules, offered
  -- in the builder and shipped as a recipe, fired for almost nothing. Two of
  -- those paths are browser inserts that cannot call an edge function at all.
  -- 'stage_changed' was worse: nothing dispatched it, ever.
  --
  -- A trigger is the only place that sees every write regardless of who made
  -- it, which is exactly the property that was missing.
  begin
    perform public.call_edge_function(
      'run-automations',
      jsonb_build_object('event', evt, 'lead_id', new.id, 'org_id', new.org_id)
    );
  exception when others then
    -- Never let automation dispatch block the write that triggered it. A lead
    -- saved without its automation is recoverable; a lead lost because Zapier
    -- was slow is not.
    raise warning 'automation dispatch failed for lead %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists trg_notify_lead_change on public.leads;
create trigger trg_notify_lead_change
  after insert or update of stage_key on public.leads
  for each row execute function public.notify_lead_change();

-- ── Housekeeping ────────────────────────────────────────────────────────────
create or replace function public.prune_webhook_deliveries()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  delete from public.webhook_deliveries where created_at < now() - interval '7 days';
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.prune_webhook_deliveries() from public, anon, authenticated;

do $$ begin
  perform 1 from cron.job where jobname = 'prune-webhook-deliveries';
  if not found then
    perform cron.schedule('prune-webhook-deliveries', '45 3 * * *',
                          $c$ select public.prune_webhook_deliveries(); $c$);
  end if;
exception when undefined_table then
  raise notice 'pg_cron not present — schedule prune_webhook_deliveries manually';
end $$;

commit;


-- ── Verify ──────────────────────────────────────────────────────────────────
-- select public.create_api_key('Zapier', array['leads:read','leads:write']);
--   -> copy the "key" value; it is never shown again
--
-- select id, name, key_prefix, scopes, last_used_at, use_count
--   from public.api_keys where revoked_at is null;
--
-- Revoke:  update public.api_keys set revoked_at = now() where id = '<uuid>';
--
-- Add an endpoint:
--   insert into public.webhook_endpoints (org_id, url, events)
--   values (public.my_org(), 'https://example.com/hook',
--           array['lead.created','lead.stage_changed'])
--   returning id, secret;
--
-- Then create a lead and watch it arrive:
--   select event, status_code, error, created_at
--     from public.webhook_deliveries order by created_at desc limit 10;
