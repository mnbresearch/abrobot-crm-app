-- ════════════════════════════════════════════════════════════════════════════
-- AbroBot CRM — 13 October 2026 release, all three migrations in one paste.
--
--   1. 20261013090000_api_key_lifecycle   rotation, key history, guard rails
--   2. 20261013100000_product_analytics   first-party analytics + dashboard
--   3. 20261013110000_checkout_recovery   abandoned-checkout reminders (ships OFF)
--
-- GENERATED from those files (bodies verbatim, their separate VERIFY blocks
-- merged into the one at the bottom). Paste all of it into the Supabase SQL
-- editor and Run. Every row of the final table should say PASS.
-- Safe to re-run: every statement is idempotent.
--
-- Then, to prove behaviour rather than just structure, run:
--   scripts/test-api-keys.sql
--   scripts/test-analytics-recovery.sql
-- Both roll themselves back completely.
-- ════════════════════════════════════════════════════════════════════════════

-- ▼▼▼ supabase/migrations/20261013090000_api_key_lifecycle.sql ▼▼▼
-- ════════════════════════════════════════════════════════════════════════════
-- API key lifecycle: rotation, a tamper-proof key history, and guard rails.
--
-- What already existed (20260905090000) and is kept exactly as it is:
--   * keys are abk_live_ + 32 random bytes (256 bits) from gen_random_bytes
--   * only a SHA-256 hash is stored; the raw key is shown once
--   * scopes, expires_at, revoked_at, last_used_at, use_count
--   * resolve_api_key() refuses revoked and expired keys
--
-- What was missing, and is added here:
--
--   1. ROTATION. The only way to replace a key was revoke-then-create, which is
--      an outage for whatever integration holds it. rotate_api_key() issues a
--      replacement with the same name and scopes and either revokes the old one
--      at once or lets it keep working for a short overlap (max 7 days), so the
--      integration can be switched over without downtime.
--
--   2. A KEY HISTORY. Nothing recorded who created, revoked or rotated a key, or
--      when. api_key_events is written by triggers, so it is kept whether the
--      change comes from the app, the REST interface or the SQL editor, and the
--      browser cannot write to it at all. Secrets are never logged: the event
--      carries the 17-character display prefix, which is not usable.
--
--   3. GUARD RAILS on direct UPDATEs. The api_keys_admin policy is FOR ALL, so
--      an org admin's session could, through the REST interface, un-revoke a
--      revoked key, extend an expiry, rewrite key_hash or move a key to another
--      org's id (the policy's WITH CHECK stopped the last one; nothing stopped
--      the rest). Revocation that can be quietly undone is not revocation.
--      A BEFORE UPDATE trigger now makes the identity columns immutable,
--      revocation one-way, and expiry only shortenable.
--
-- Additions only. No row is changed by applying this file, resolve_api_key and
-- create_api_key are untouched, and the API keeps working throughout.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Columns ──────────────────────────────────────────────────────────────
alter table public.api_keys add column if not exists rotated_from  uuid references public.api_keys(id) on delete set null;
alter table public.api_keys add column if not exists revoked_by    uuid;
alter table public.api_keys add column if not exists revoke_reason text;

comment on column public.api_keys.rotated_from is
  'The key this one replaced via rotate_api_key(). NULL for a key created from scratch.';

-- ── 2. The key history ──────────────────────────────────────────────────────
create table if not exists public.api_key_events (
  id          bigserial primary key,
  -- No FK to api_keys: the history must outlive anything that might one day
  -- remove a key row. org_id does cascade, so closing a workspace removes it.
  key_id      uuid not null,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  actor_id    uuid,
  event       text not null check (event in
                ('created', 'rotated', 'revoked', 'expiry_changed', 'scopes_changed', 'renamed')),
  key_prefix  text,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists api_key_events_org_idx on public.api_key_events (org_id, created_at desc);
create index if not exists api_key_events_key_idx on public.api_key_events (key_id, created_at desc);

alter table public.api_key_events enable row level security;

-- Readable by the same people who can manage keys. No write policy exists, so
-- RLS denies every browser INSERT/UPDATE/DELETE; the revoke below makes that
-- belt-and-braces. Rows are written by the SECURITY DEFINER triggers only.
drop policy if exists api_key_events_read on public.api_key_events;
create policy api_key_events_read on public.api_key_events
  for select using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  );

revoke insert, update, delete on public.api_key_events from anon, authenticated;
grant select on public.api_key_events to authenticated;

-- ── 3. Guard: what a direct UPDATE may and may not change ───────────────────
create or replace function public.guard_api_key_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_valid text[] := array['leads:read','leads:write','conversations:read','stages:read'];
  s text;
begin
  -- Identity of the key. None of these has a legitimate reason to change.
  -- rotated_from may only go to NULL: that is what `on delete set null` does
  -- when the predecessor row is deleted, and refusing it would make any
  -- rotated-away key undeletable.
  if new.org_id      is distinct from old.org_id
     or new.key_hash   is distinct from old.key_hash
     or new.key_prefix is distinct from old.key_prefix
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by
     or (new.rotated_from is distinct from old.rotated_from and new.rotated_from is not null) then
    raise exception 'An API key''s identity cannot be changed. Create a new key instead.'
      using errcode = '42501';
  end if;

  -- Once revoked, who and why are part of the record.
  if old.revoked_at is not null
     and (new.revoked_by is distinct from old.revoked_by or new.revoke_reason is distinct from old.revoke_reason) then
    raise exception 'The revocation record of a key cannot be changed.' using errcode = '42501';
  end if;

  -- Revocation is one-way.
  if old.revoked_at is not null and new.revoked_at is null then
    raise exception 'A revoked key cannot be restored. Create a new key instead.'
      using errcode = '42501';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    new.revoked_at := old.revoked_at;   -- revoking twice keeps the first time
  end if;
  if old.revoked_at is null and new.revoked_at is not null then
    -- The session doing the revoking, not whatever the request claimed.
    new.revoked_by := coalesce(auth.uid(), new.revoked_by);
  end if;
  if old.revoked_at is null and new.revoked_at is null
     and (new.revoked_by is distinct from old.revoked_by or new.revoke_reason is distinct from old.revoke_reason) then
    raise exception 'Revocation details can only be set when revoking' using errcode = '42501';
  end if;

  -- Expiry may be set or brought forward, never pushed back or removed.
  if new.expires_at is distinct from old.expires_at
     and old.expires_at is not null
     and (new.expires_at is null or new.expires_at > old.expires_at) then
    raise exception 'A key''s expiry can be brought forward but not extended. Rotate it to get a new key.'
      using errcode = '42501';
  end if;

  if new.scopes is distinct from old.scopes then
    if new.scopes is null or cardinality(new.scopes) = 0 then
      raise exception 'A key needs at least one scope';
    end if;
    foreach s in array new.scopes loop
      if not (s = any(v_valid)) then
        raise exception 'unknown scope: % (valid: %)', s, array_to_string(v_valid, ', ');
      end if;
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists api_keys_guard_update on public.api_keys;
create trigger api_keys_guard_update
  before update on public.api_keys
  for each row execute function public.guard_api_key_update();

-- On INSERT: rotated_from may only point at a key of the SAME organisation.
-- The api_keys_admin policy is FOR ALL, so an org admin can insert a row
-- directly; without this, pointing rotated_from at another tenant's key id
-- would plant a cross-tenant reference (and make that key undeletable).
create or replace function public.guard_api_key_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.rotated_from is not null
     and not exists (select 1 from public.api_keys k where k.id = new.rotated_from and k.org_id = new.org_id) then
    raise exception 'rotated_from must reference a key in the same organisation' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists api_keys_guard_insert on public.api_keys;
create trigger api_keys_guard_insert
  before insert on public.api_keys
  for each row execute function public.guard_api_key_insert();

-- ── 4. History triggers ─────────────────────────────────────────────────────
-- Never allowed to fail the write it describes: an error here is logged as a
-- warning and swallowed. Losing one history row is better than a key that
-- cannot be revoked because the audit insert broke.
create or replace function public.log_api_key_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if tg_op = 'INSERT' then
      insert into public.api_key_events (key_id, org_id, actor_id, event, key_prefix, detail)
      values (new.id, new.org_id, coalesce(auth.uid(), new.created_by), 'created', new.key_prefix,
              jsonb_build_object('name', new.name, 'scopes', new.scopes, 'expires_at', new.expires_at,
                                 'rotated_from', new.rotated_from));
      return new;
    end if;

    if old.revoked_at is null and new.revoked_at is not null then
      insert into public.api_key_events (key_id, org_id, actor_id, event, key_prefix, detail)
      values (new.id, new.org_id, coalesce(auth.uid(), new.revoked_by), 'revoked', new.key_prefix,
              jsonb_build_object('reason', new.revoke_reason));
    end if;
    if new.expires_at is distinct from old.expires_at then
      insert into public.api_key_events (key_id, org_id, actor_id, event, key_prefix, detail)
      values (new.id, new.org_id, auth.uid(), 'expiry_changed', new.key_prefix,
              jsonb_build_object('from', old.expires_at, 'to', new.expires_at));
    end if;
    if new.scopes is distinct from old.scopes then
      insert into public.api_key_events (key_id, org_id, actor_id, event, key_prefix, detail)
      values (new.id, new.org_id, auth.uid(), 'scopes_changed', new.key_prefix,
              jsonb_build_object('from', old.scopes, 'to', new.scopes));
    end if;
    if new.name is distinct from old.name then
      insert into public.api_key_events (key_id, org_id, actor_id, event, key_prefix, detail)
      values (new.id, new.org_id, auth.uid(), 'renamed', new.key_prefix,
              jsonb_build_object('from', old.name, 'to', new.name));
    end if;
  exception when others then
    raise warning 'api key history not recorded for %: %', coalesce(new.id, old.id), sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists api_keys_log_insert on public.api_keys;
create trigger api_keys_log_insert
  after insert on public.api_keys
  for each row execute function public.log_api_key_event();

-- `of` these columns only, so resolve_api_key's per-request
-- last_used_at/use_count update never writes history.
drop trigger if exists api_keys_log_update on public.api_keys;
create trigger api_keys_log_update
  after update of revoked_at, expires_at, scopes, name on public.api_keys
  for each row execute function public.log_api_key_event();

-- ── 5. Revoke, with a reason ────────────────────────────────────────────────
create or replace function public.revoke_api_key(p_key_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare k public.api_keys%rowtype;
begin
  select * into k from public.api_keys where id = p_key_id for update;
  if not found
     or not (public.is_super_admin() or (k.org_id = public.my_org() and public.is_org_admin())) then
    -- Same answer for "no such key" and "not yours": which one it was is
    -- information about another tenant.
    raise exception 'No such key' using errcode = 'P0002';
  end if;
  if k.revoked_at is not null then
    return jsonb_build_object('ok', true, 'already_revoked', true, 'revoked_at', k.revoked_at);
  end if;

  update public.api_keys
     set revoked_at = now(), revoked_by = auth.uid(),
         revoke_reason = nullif(left(trim(coalesce(p_reason, '')), 200), '')
   where id = p_key_id;

  return jsonb_build_object('ok', true, 'revoked_at', now());
end;
$$;

revoke all on function public.revoke_api_key(uuid, text) from public, anon;
grant execute on function public.revoke_api_key(uuid, text) to authenticated;

-- ── 6. Rotate ───────────────────────────────────────────────────────────────
-- Returns the new raw key exactly once, like create_api_key.
--   p_overlap_minutes = 0      old key stops working immediately
--   p_overlap_minutes = 1..10080  old key keeps working that long, then expires
-- The replacement inherits name and scopes. If the old key had a lifetime, the
-- new one gets the same lifetime from now — rotating must not silently turn an
-- expiring key into a permanent one.
create or replace function public.rotate_api_key(p_key_id uuid, p_overlap_minutes integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  k        public.api_keys%rowtype;
  v_raw    text;
  v_hash   text;
  v_id     uuid;
  v_over   integer := greatest(0, least(coalesce(p_overlap_minutes, 0), 10080));
  v_exp    timestamptz;
  v_old_until timestamptz;
begin
  select * into k from public.api_keys where id = p_key_id for update;
  if not found
     or not (public.is_super_admin() or (k.org_id = public.my_org() and public.is_org_admin())) then
    raise exception 'No such key' using errcode = 'P0002';
  end if;
  if k.revoked_at is not null then
    raise exception 'That key is revoked. Create a new key instead.' using errcode = '22023';
  end if;
  if k.expires_at is not null and k.expires_at <= now() then
    raise exception 'That key has expired. Create a new key instead.' using errcode = '22023';
  end if;
  -- A key is rotated at most once. Rotating it again during its overlap would
  -- mint a second replacement in the same chain (even if the first
  -- replacement has itself since been rotated or revoked). Point the admin at
  -- the newest key instead.
  if exists (select 1 from public.api_keys n where n.rotated_from = k.id) then
    raise exception 'This key has already been rotated. Rotate its replacement instead.' using errcode = '22023';
  end if;

  v_raw  := 'abk_live_' || encode(gen_random_bytes(32), 'hex');
  v_hash := encode(digest(v_raw, 'sha256'), 'hex');
  v_exp  := case when k.expires_at is null then null
                 else now() + (k.expires_at - k.created_at) end;

  insert into public.api_keys (org_id, name, key_hash, key_prefix, scopes, created_by, expires_at, rotated_from)
  values (k.org_id, k.name, v_hash, left(v_raw, 17), k.scopes, auth.uid(), v_exp, k.id)
  returning id into v_id;

  if v_over = 0 then
    update public.api_keys
       set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'rotated'
     where id = k.id;
    v_old_until := now();
  else
    v_old_until := least(coalesce(k.expires_at, 'infinity'::timestamptz), now() + make_interval(mins => v_over));
    update public.api_keys set expires_at = v_old_until where id = k.id;
  end if;

  insert into public.api_key_events (key_id, org_id, actor_id, event, key_prefix, detail)
  values (k.id, k.org_id, auth.uid(), 'rotated', k.key_prefix,
          jsonb_build_object('new_key_id', v_id, 'new_prefix', left(v_raw, 17),
                             'overlap_minutes', v_over, 'old_key_valid_until', v_old_until));

  return jsonb_build_object(
    'ok', true, 'id', v_id, 'key', v_raw, 'prefix', left(v_raw, 17), 'scopes', k.scopes,
    'expires_at', v_exp, 'old_key_id', k.id, 'old_key_valid_until', v_old_until,
    'warning', 'This is the only time the key will be shown. Store it now.'
  );
end;
$$;

revoke all on function public.rotate_api_key(uuid, integer) from public, anon;
grant execute on function public.rotate_api_key(uuid, integer) to authenticated;

-- ── 7. Per-key rate limiting from the API ───────────────────────────────────
-- hit_rate_limit() exists (20260906100000) and is service-role only. The API
-- function now calls it per key; nothing to add here except saying so, so the
-- next reader does not go looking for a second limiter.
comment on function public.hit_rate_limit(text, integer, integer) is
  'Fixed-window counter. Used by chat-agent (per org+caller), by the public API (per presented key, 20261013090000) and by track_event (per user, or per client IP when signed out).';

commit;

-- ▼▼▼ supabase/migrations/20261013100000_product_analytics.sql ▼▼▼
-- ════════════════════════════════════════════════════════════════════════════
-- First-party product analytics for AbroBot CRM itself (not for tenants' data).
--
-- Answers the questions the platform owner could not answer without SQL:
-- how many people reach the landing page, how many ask for a sign-in link, how
-- many create a workspace, finish onboarding, open checkout, and pay — and
-- where they drop off.
--
-- DESIGN
--
--   * No third-party tracker. The privacy policy promises "no third-party
--     analytics", and that stays true: events go to our own database.
--
--   * MONEY AND ACCOUNTS ARE NEVER TAKEN FROM THE BROWSER. Payment, checkout,
--     subscription, workspace and API-key events are written by TRIGGERS on the
--     tables that the signature-verified webhook and the server functions
--     write. A browser redirect back from Cashfree proves nothing, so it is
--     recorded as `checkout_returned` and never counted as a payment.
--
--   * The browser can only send events from a fixed allow-list, through
--     track_event(), which: derives user and org from the JWT (never from the
--     request), strips the query string and fragment from the path (magic-link
--     tokens and order ids live there), keeps only allow-listed property keys
--     with short string values, and rate-limits per session and globally.
--
--   * No cookies and no persistent identifier for signed-out visitors: the
--     session id is a random value in sessionStorage, gone when the tab closes.
--     The client sends nothing at all when Do Not Track or Global Privacy
--     Control is on.
--
--   * Retention 13 months, purged daily. Deleting a user nulls user_id on their
--     events (FK on delete set null); closing a workspace deletes its events
--     (cascade); forget_user_analytics() erases one person on request.
--
-- Additions only. Every trigger swallows its own errors, so analytics can never
-- block a payment, a signup or a key creation.
-- ════════════════════════════════════════════════════════════════════════════

begin;

create table if not exists public.product_events (
  id          bigserial primary key,
  occurred_at timestamptz not null default now(),
  event       text not null,
  source      text not null check (source in ('client', 'server')),
  org_id      uuid references public.organizations(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  session_id  text,
  path        text,
  props       jsonb not null default '{}'::jsonb
);

create index if not exists product_events_time_idx  on public.product_events (occurred_at desc);
create index if not exists product_events_event_idx on public.product_events (event, occurred_at desc);
create index if not exists product_events_org_idx   on public.product_events (org_id, occurred_at desc) where org_id is not null;
-- For user deletion (FK set null) and forget_user_analytics, which would
-- otherwise scan the whole table.
create index if not exists product_events_user_idx  on public.product_events (user_id) where user_id is not null;

alter table public.product_events enable row level security;

drop policy if exists product_events_super_read on public.product_events;
create policy product_events_super_read on public.product_events
  for select using (public.is_super_admin());

revoke insert, update, delete on public.product_events from anon, authenticated;

comment on table public.product_events is
  'First-party product analytics. Client events only via track_event(); server events only via triggers on payments, subscriptions, organizations, profiles, pipeline_stages and api_keys. Readable by platform super admins. 13-month retention.';

-- ── 1. Server-side writer (definer-only, never granted) ─────────────────────
create or replace function public.log_product_event(
  p_event text, p_org uuid, p_user uuid, p_props jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.product_events (event, source, org_id, user_id, props)
  values (p_event, 'server', p_org, p_user, coalesce(p_props, '{}'::jsonb));
exception when others then
  raise warning 'product event % not recorded: %', p_event, sqlerrm;
end;
$$;

revoke all on function public.log_product_event(text, uuid, uuid, jsonb) from public, anon, authenticated;

-- ── 2. Browser-side writer ──────────────────────────────────────────────────
create or replace function public.track_event(
  p_event text, p_session text default null, p_path text default null, p_props jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed text[] := array[
    'landing_view', 'pricing_view', 'product_view', 'contact_view',
    'login_view', 'login_link_requested', 'login_succeeded',
    'page_view', 'feature_used',
    'plan_selected', 'checkout_opened', 'checkout_returned'
  ];
  v_keys    text[] := array['plan', 'months', 'feature', 'route', 'referrer_host',
                            'utm_source', 'utm_medium', 'utm_campaign', 'result'];
  v_props   jsonb := '{}'::jsonb;
  v_session text;
  v_path    text;
  v_uid     uuid := auth.uid();
  v_ip      text;
  k         text;
  v         jsonb;
  rl        jsonb;
begin
  if p_event is null or not (p_event = any(v_allowed)) then return false; end if;

  v_session := case when p_session ~ '^[A-Za-z0-9_-]{8,64}$' then p_session else null end;
  -- Path only. Query strings and fragments carry magic-link tokens, order ids
  -- and anything a page chose to put there; none of it belongs in analytics.
  v_path := left(split_part(split_part(coalesce(p_path, ''), '?', 1), '#', 1), 200);
  if v_path = '' then v_path := null; end if;

  if jsonb_typeof(p_props) = 'object' then
    for k, v in select * from jsonb_each(p_props) loop
      if k = any(v_keys) and jsonb_typeof(v) in ('string', 'number', 'boolean') then
        v_props := v_props || jsonb_build_object(k, left(v #>> '{}', 80));
      end if;
    end loop;
  end if;

  -- Per caller and global caps. A flood is dropped silently: the browser does
  -- not wait on this call and has nothing useful to do with a refusal.
  --
  -- Anonymous callers are bucketed by client IP, not by the session id they
  -- send: a session id is caller-chosen, so keying on it would let a script
  -- mint a fresh bucket per request. PostgREST exposes the request headers;
  -- Cloudflare (in front of Supabase) sets cf-connecting-ip.
  begin
    v_ip := nullif(coalesce(
      current_setting('request.headers', true)::json->>'cf-connecting-ip',
      split_part(current_setting('request.headers', true)::json->>'x-forwarded-for', ',', 1)), '');
  exception when others then v_ip := null; end;

  -- If no IP header reaches PostgREST, fall back to the session id rather
  -- than one shared bucket that would drop every visitor's events.
  rl := public.hit_rate_limit('evt:' || coalesce(v_uid::text, 'ip:' || v_ip, 'sid:' || v_session, 'anon'), 60, 60);
  if (rl->>'allowed')::boolean is not true then return false; end if;
  if v_uid is null then
    -- ~860k rows/day at most even under sustained abuse; real traffic is a
    -- tiny fraction of this.
    rl := public.hit_rate_limit('evt:anon-global', 600, 60);
    if (rl->>'allowed')::boolean is not true then return false; end if;
  end if;

  insert into public.product_events (event, source, org_id, user_id, session_id, path, props)
  values (p_event, 'client',
          case when v_uid is null then null else public.my_org() end,
          v_uid, v_session, v_path, v_props);
  return true;
exception when others then
  return false;
end;
$$;

revoke all on function public.track_event(text, text, text, jsonb) from public;
grant execute on function public.track_event(text, text, text, jsonb) to anon, authenticated;

-- ── 3. Triggers on the tables that hold the truth ───────────────────────────

-- Checkout and payment outcome. Status is written only by the service role
-- (billing-checkout creates 'created'; the verified webhook moves it on), so
-- these events are as trustworthy as the payments table itself.
create or replace function public.track_payment_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_product_event('checkout_started', new.org_id, new.created_by,
      jsonb_build_object('plan', new.plan, 'months', new.period_months, 'amount', new.amount, 'payment_id', new.id));
  elsif new.status is distinct from old.status then
    perform public.log_product_event(
      case new.status::text
        when 'paid'     then 'payment_succeeded'
        when 'failed'   then 'payment_failed'
        when 'dropped'  then 'payment_dropped'
        when 'refunded' then 'payment_refunded'
        else 'payment_' || new.status::text end,
      new.org_id, new.created_by,
      jsonb_build_object('plan', new.plan, 'months', new.period_months, 'amount', new.amount, 'payment_id', new.id));
  end if;
  return new;
exception when others then
  raise warning 'track_payment_event: %', sqlerrm;
  return new;
end $$;

drop trigger if exists payments_product_events on public.payments;
create trigger payments_product_events
  after insert or update of status on public.payments
  for each row execute function public.track_payment_event();

create or replace function public.track_subscription_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_product_event('subscription_activated', new.org_id, null,
      jsonb_build_object('plan', new.plan, 'period_end', new.current_period_end));
  elsif new.status is distinct from old.status then
    perform public.log_product_event('subscription_' || coalesce(new.status, 'unknown'), new.org_id, null,
      jsonb_build_object('plan', new.plan, 'from', old.status));
  elsif new.current_period_end > old.current_period_end then
    perform public.log_product_event(
      case when new.plan is distinct from old.plan then 'subscription_plan_changed' else 'subscription_renewed' end,
      new.org_id, null,
      jsonb_build_object('plan', new.plan, 'from_plan', old.plan, 'period_end', new.current_period_end));
  end if;
  return new;
exception when others then
  raise warning 'track_subscription_event: %', sqlerrm;
  return new;
end $$;

drop trigger if exists subscriptions_product_events on public.subscriptions;
create trigger subscriptions_product_events
  after insert or update on public.subscriptions
  for each row execute function public.track_subscription_event();

create or replace function public.track_org_created()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.log_product_event('workspace_created', new.id, auth.uid(),
    jsonb_build_object('plan', new.plan, 'industry', new.industry_slug));
  return new;
exception when others then
  raise warning 'track_org_created: %', sqlerrm;
  return new;
end $$;

drop trigger if exists organizations_product_events on public.organizations;
create trigger organizations_product_events
  after insert on public.organizations
  for each row execute function public.track_org_created();

create or replace function public.track_user_registered()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.log_product_event('user_registered', null, new.id, '{}'::jsonb);
  return new;
exception when others then
  raise warning 'track_user_registered: %', sqlerrm;
  return new;
end $$;

drop trigger if exists profiles_product_events on public.profiles;
create trigger profiles_product_events
  after insert on public.profiles
  for each row execute function public.track_user_registered();

-- Onboarding is complete when the workspace gets its pipeline: the app's own
-- definition (store.tsx: needsOnboarding = no stages). Logged once per org.
create or replace function public.track_onboarding_completed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.product_events
                  where org_id = new.org_id and event = 'onboarding_completed') then
    perform public.log_product_event('onboarding_completed', new.org_id, auth.uid(), '{}'::jsonb);
  end if;
  return new;
exception when others then
  raise warning 'track_onboarding_completed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists pipeline_stages_product_events on public.pipeline_stages;
create trigger pipeline_stages_product_events
  after insert on public.pipeline_stages
  for each row execute function public.track_onboarding_completed();

create or replace function public.track_api_key_created()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.log_product_event('api_key_created', new.org_id, new.created_by,
    jsonb_build_object('scopes', new.scopes, 'rotation', new.rotated_from is not null));
  return new;
exception when others then
  raise warning 'track_api_key_created: %', sqlerrm;
  return new;
end $$;

drop trigger if exists api_keys_product_events on public.api_keys;
create trigger api_keys_product_events
  after insert on public.api_keys
  for each row execute function public.track_api_key_created();

-- ── 4. Retention and erasure ────────────────────────────────────────────────
create or replace function public.purge_product_events()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.product_events where occurred_at < now() - interval '13 months';
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.purge_product_events() from public, anon, authenticated;

-- A DPDP erasure request for one person. Super admin only, and audited.
create or replace function public.forget_user_analytics(p_user uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_super_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  delete from public.product_events where user_id = p_user;
  get diagnostics n = row_count;
  perform public.log_admin_action('forget_user_analytics', null, jsonb_build_object('user_id', p_user, 'rows', n));
  return n;
end $$;

revoke all on function public.forget_user_analytics(uuid) from public, anon;
grant execute on function public.forget_user_analytics(uuid) to authenticated;

-- ── 5. The dashboard's single read ──────────────────────────────────────────
-- Platform-wide, so super admin only. Funnel steps that have a source of truth
-- in a real table are counted from that table, not from events, so the
-- dashboard is right about history from before this migration. Steps that only
-- exist as browser events say so via `client_events_since`.
create or replace function public.analytics_overview(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  d      integer := greatest(1, least(coalesce(p_days, 30), 400));
  since  timestamptz := now() - make_interval(days => d);
  out    jsonb;
begin
  if not public.is_super_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  with
  ev as (select * from public.product_events where occurred_at >= since),
  sess as (
    select event, count(distinct coalesce(session_id, user_id::text, id::text)) as n
      from ev where source = 'client' group by event
  ),
  orgs as (select id, created_at from public.organizations where created_at >= since),
  pays as (select * from public.payments where created_at >= since)
  select jsonb_build_object(
    'days', d,
    'client_events_since', (select min(occurred_at) from public.product_events where source = 'client'),
    'funnel', jsonb_build_array(
      jsonb_build_object('step', 'Visited landing page',     'count', coalesce((select n from sess where event = 'landing_view'), 0),         'basis', 'browser sessions'),
      jsonb_build_object('step', 'Viewed pricing',           'count', coalesce((select n from sess where event = 'pricing_view'), 0),         'basis', 'browser sessions'),
      jsonb_build_object('step', 'Requested sign-in link',   'count', coalesce((select n from sess where event = 'login_link_requested'), 0), 'basis', 'browser sessions'),
      jsonb_build_object('step', 'Created a workspace',      'count', (select count(*) from orgs),                                           'basis', 'organizations table'),
      -- Not "has a pipeline": create_organisation seeds the pipeline at once,
      -- so that step always equalled the one above it. A first real record is
      -- the first moment the product has done something for them.
      jsonb_build_object('step', 'Captured a first record',  'count', (select count(*) from orgs o where exists (select 1 from public.leads l where l.org_id = o.id)), 'basis', 'workspaces with any record'),
      jsonb_build_object('step', 'Opened checkout',          'count', (select count(distinct org_id) from pays),                             'basis', 'payments table'),
      jsonb_build_object('step', 'Paid',                     'count', (select count(distinct org_id) from pays where status = 'paid'),      'basis', 'verified payment webhook')
    ),
    'activation', jsonb_build_object(
      'new_workspaces',               (select count(*) from orgs),
      -- Same basis as the funnel step: any record ever, archived included.
      'with_a_record',                (select count(*) from orgs o where exists (select 1 from public.leads l where l.org_id = o.id)),
      'with_a_second_member',         (select count(*) from orgs o where (select count(*) from public.profiles p where p.org_id = o.id and p.status = 'active') > 1),
      'users_signed_in_in_period',    (select count(*) from auth.users u where u.last_sign_in_at >= since)
    ),
    'payments', jsonb_build_object(
      'started',   (select count(*) from pays),
      'paid',      (select count(*) from pays where status = 'paid'),
      'failed',    (select count(*) from pays where status = 'failed'),
      'dropped',   (select count(*) from pays where status = 'dropped'),
      'pending',   (select count(*) from pays where status = 'created'),
      'refunded',  (select count(*) from pays where status = 'refunded'),
      'revenue_inr', (select coalesce(sum(amount), 0) from pays where status = 'paid'),
      'abandoned', (select count(*) from pays p
                     where p.status in ('created', 'dropped', 'failed')
                       and p.created_at < now() - interval '1 hour'
                       and not exists (select 1 from public.payments q
                                        where q.org_id = p.org_id and q.status = 'paid' and q.created_at >= p.created_at))
    ),
    'api', jsonb_build_object(
      'active_keys',       (select count(*) from public.api_keys where revoked_at is null and (expires_at is null or expires_at > now())),
      'orgs_with_keys',    (select count(distinct org_id) from public.api_keys where revoked_at is null),
      'keys_used_in_period', (select count(*) from public.api_keys where last_used_at >= since),
      'total_calls',       (select coalesce(sum(use_count), 0) from public.api_keys)
    ),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('day', day, 'event', event, 'count', n) order by day, event)
        from (select date_trunc('day', occurred_at)::date as day, event, count(*) as n
                from ev
               where event in ('landing_view', 'pricing_view', 'login_link_requested', 'login_succeeded',
                               'workspace_created', 'checkout_started', 'payment_succeeded')
               group by 1, 2) x), '[]'::jsonb),
    'top_events', coalesce((
      select jsonb_agg(jsonb_build_object('event', event, 'source', source, 'count', n) order by n desc)
        from (select event, source, count(*) as n from ev group by 1, 2 order by 3 desc limit 25) x), '[]'::jsonb),
    'top_features', coalesce((
      select jsonb_agg(jsonb_build_object('route', route, 'users', users, 'views', n) order by users desc)
        from (select path as route, count(distinct user_id) as users, count(*) as n
                from ev where event = 'page_view' and path is not null
               group by 1 order by 2 desc limit 15) x), '[]'::jsonb)
  ) into out;

  return out;
end;
$$;

revoke all on function public.analytics_overview(integer) from public, anon;
grant execute on function public.analytics_overview(integer) to authenticated;

commit;

-- ── 6. Daily retention job (outside the transaction — cron.schedule commits) ─
select cron.unschedule('purge-product-events')
  where exists (select 1 from cron.job where jobname = 'purge-product-events');
select cron.schedule('purge-product-events', '25 3 * * *', $$select public.purge_product_events();$$);

-- Plain SQL, so its own cron success IS the work: map it into the heartbeat
-- sync the same way purge-archived is (see 20260924093000).
insert into public.cron_job_heartbeat_map (cron_jobname, job_name, note)
values ('purge-product-events', 'purge-product-events', 'plain SQL: select public.purge_product_events()')
on conflict (cron_jobname) do nothing;

insert into public.job_heartbeats (job_name, stale_after, last_status, last_detail, watch)
values ('purge-product-events', interval '48 hours', 'ok', 'seeded 13 Oct — awaiting first sync from cron.job_run_details', true)
on conflict (job_name) do update set stale_after = excluded.stale_after;

-- ▼▼▼ supabase/migrations/20261013110000_checkout_recovery.sql ▼▼▼
-- ════════════════════════════════════════════════════════════════════════════
-- Abandoned-checkout follow-up, for AbroBot CRM's own customers.
--
-- When a workspace admin opens Cashfree checkout and does not complete it, one
-- (optionally two) plain service emails remind them, with a link back to
-- Settings → Plan. The checkout_recovery edge function sends them; this file
-- holds the configuration, the send log, the suppression list, and the single
-- query that decides who is eligible.
--
-- SAFE BY DEFAULT: the feature ships DISABLED and in DRY-RUN mode. Nothing is
-- emailed until a platform super admin turns it on in the Platform screen.
--
-- Who can receive one — every condition must hold:
--   * the payment row is 'created', 'dropped' or 'failed' (statuses written
--     only by billing-checkout and the signature-verified webhook), at least
--     `first_delay_minutes` old and at most 7 days old;
--   * the SAME organisation has no paid payment since that checkout began,
--     and is not already on the plan it tried to buy or a higher one;
--   * it is that organisation's most recent unpaid checkout (one thread per
--     org, however many times they clicked Upgrade);
--   * the recipient is the admin who started the checkout, still an active
--     member, in a still-active workspace;
--   * the address is not on platform_email_suppressions (unsubscribed or
--     bounced), and has not received ANY recovery email in the last 20 hours;
--   * fewer than `max_attempts` live emails have gone for this checkout, and
--     the previous one is at least `repeat_after_hours` old.
--
-- Additions only.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── settings: exactly one row ───────────────────────────────────────────────
create table if not exists public.checkout_recovery_settings (
  id                  boolean primary key default true check (id),
  enabled             boolean not null default false,
  dry_run             boolean not null default true,
  first_delay_minutes integer not null default 120 check (first_delay_minutes between 15 and 10080),
  repeat_after_hours  integer not null default 48  check (repeat_after_hours between 12 and 336),
  max_attempts        integer not null default 2   check (max_attempts between 1 and 3),
  test_recipient      text check (test_recipient is null or test_recipient ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'),
  updated_at          timestamptz not null default now(),
  updated_by          uuid
);
insert into public.checkout_recovery_settings (id) values (true) on conflict (id) do nothing;

alter table public.checkout_recovery_settings enable row level security;
drop policy if exists checkout_recovery_settings_super on public.checkout_recovery_settings;
create policy checkout_recovery_settings_super on public.checkout_recovery_settings
  for all using (public.is_super_admin()) with check (public.is_super_admin());
grant select, update on public.checkout_recovery_settings to authenticated;
revoke insert, delete on public.checkout_recovery_settings from authenticated, anon;

create or replace function public.touch_checkout_recovery_settings()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  begin
    perform public.log_admin_action('checkout_recovery_settings', null,
      jsonb_build_object('enabled', new.enabled, 'dry_run', new.dry_run,
                         'first_delay_minutes', new.first_delay_minutes,
                         'repeat_after_hours', new.repeat_after_hours, 'max_attempts', new.max_attempts));
  exception when others then null; end;
  return new;
end $$;

drop trigger if exists checkout_recovery_settings_touch on public.checkout_recovery_settings;
create trigger checkout_recovery_settings_touch
  before update on public.checkout_recovery_settings
  for each row execute function public.touch_checkout_recovery_settings();

-- ── suppression list (platform mail, not tenants' nurture lists) ────────────
create table if not exists public.platform_email_suppressions (
  email      text primary key check (email = lower(email)),
  reason     text not null check (reason in ('unsubscribed', 'bounced', 'complained', 'manual')),
  source     text,
  created_at timestamptz not null default now()
);
alter table public.platform_email_suppressions enable row level security;
drop policy if exists platform_email_suppressions_super on public.platform_email_suppressions;
create policy platform_email_suppressions_super on public.platform_email_suppressions
  for all using (public.is_super_admin()) with check (public.is_super_admin());
grant select, insert, delete on public.platform_email_suppressions to authenticated;

-- ── the send log, which is also the dedupe ──────────────────────────────────
create table if not exists public.checkout_followups (
  id                  uuid primary key default gen_random_uuid(),
  payment_id          uuid not null references public.payments(id) on delete cascade,
  org_id              uuid not null references public.organizations(id) on delete cascade,
  recipient_email     text not null,
  attempt             integer not null,
  mode                text not null check (mode in ('live', 'dry_run', 'test')),
  status              text not null check (status in ('pending', 'sent', 'failed', 'would_send')),
  error               text,
  provider_message_id text,
  unsub_token         uuid not null default gen_random_uuid() unique,
  created_at          timestamptz not null default now()
);

-- Insert-before-send: the function claims (payment, attempt) by inserting a
-- 'pending' row FIRST and only then calls the provider. Two overlapping runs
-- cannot both claim it, so a customer cannot get the same email twice. A
-- 'failed' row does not hold the claim, so the next run retries.
create unique index if not exists checkout_followups_claim
  on public.checkout_followups (payment_id, attempt)
  where mode = 'live' and status in ('pending', 'sent');

create index if not exists checkout_followups_recent on public.checkout_followups (created_at desc);
create index if not exists checkout_followups_email on public.checkout_followups (lower(recipient_email), created_at desc);

alter table public.checkout_followups enable row level security;
drop policy if exists checkout_followups_super_read on public.checkout_followups;
create policy checkout_followups_super_read on public.checkout_followups
  for select using (public.is_super_admin());
revoke insert, update, delete on public.checkout_followups from authenticated, anon;

-- ── who is eligible right now ───────────────────────────────────────────────
create or replace function public.checkout_recovery_candidates(p_limit integer default 50)
returns table (
  payment_id uuid, order_id text, org_id uuid, org_name text, plan text, plan_label text, amount numeric,
  period_months integer, email text, full_name text, started_at timestamptz,
  attempt integer, last_sent_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with s as (select * from public.checkout_recovery_settings where id),
  latest as (
    -- One thread per organisation: only its newest unpaid checkout.
    select distinct on (p.org_id) p.*
      from public.payments p
     where p.status in ('created', 'dropped', 'failed')
       and p.created_at > now() - interval '7 days'
     order by p.org_id, p.created_at desc
  ),
  sent as (
    select f.payment_id, count(*) filter (where f.status = 'sent') as n,
           max(f.created_at) filter (where f.status = 'sent') as last_at,
           count(*) filter (where f.status = 'failed') as failures
      from public.checkout_followups f where f.mode = 'live' group by f.payment_id
  )
  select p.id, p.order_id, p.org_id, o.name, p.plan, coalesce(pl.label, p.plan), p.amount, p.period_months,
         lower(pr.email), pr.full_name, p.created_at,
         coalesce(sent.n, 0)::integer + 1, sent.last_at
    from latest p
    cross join s
    join public.organizations o on o.id = p.org_id and o.active
    -- The person who started the checkout, and only while they are still an
    -- active member of THIS workspace. No fallback to the address recorded on
    -- the order: someone who has left must not be chased about a plan for a
    -- company they no longer work for.
    join public.profiles pr on pr.id = p.created_by and pr.org_id = p.org_id and pr.status = 'active' 
    left join public.plan_limits pl on pl.plan = p.plan
    left join sent on sent.payment_id = p.id
   where p.created_at < now() - make_interval(mins => s.first_delay_minutes)
     and pr.email is not null
     and not exists (select 1 from public.payments q
                      where q.org_id = p.org_id and q.status = 'paid' and q.created_at >= p.created_at)
     -- Already on that plan or a higher one (e.g. upgraded by support): nothing
     -- to recover. 'expired' and 'free' are never "higher" — 'expired' carries
     -- the highest position in plan_limits, and without this a lapsed customer
     -- abandoning a renewal (the person most worth a reminder) was excluded.
     and (public.effective_plan(p.org_id) in ('expired', 'free')
          or coalesce((select cur.position from public.plan_limits cur
                        where cur.plan = public.effective_plan(p.org_id)), -1) < coalesce(pl.position, 2147483647))
     and not exists (select 1 from public.platform_email_suppressions x
                      where x.email = lower(pr.email))
     and coalesce(sent.n, 0) < s.max_attempts
     and coalesce(sent.failures, 0) < 3
     and (sent.last_at is null or sent.last_at < now() - make_interval(hours => s.repeat_after_hours))
     and not exists (select 1 from public.checkout_followups r
                      where r.mode = 'live' and r.status = 'sent'
                        and lower(r.recipient_email) = lower(pr.email)
                        and r.created_at > now() - interval '20 hours')
   order by p.created_at
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

revoke all on function public.checkout_recovery_candidates(integer) from public, anon, authenticated;

-- The same list for the Platform screen, behind a super-admin check.
create or replace function public.checkout_recovery_preview()
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return query select to_jsonb(c) from public.checkout_recovery_candidates(50) c;
end $$;

revoke all on function public.checkout_recovery_preview() from public, anon;
grant execute on function public.checkout_recovery_preview() to authenticated;

commit;

-- ── schedule: hourly. The function itself returns early while disabled. ─────
select cron.unschedule('abrobot-checkout-recovery')
  where exists (select 1 from cron.job where jobname = 'abrobot-checkout-recovery');
select cron.schedule('abrobot-checkout-recovery', '20 * * * *',
  $$select public.call_edge_function('checkout-recovery', '{"mode":"run"}'::jsonb)$$);

-- An edge-function job: it reports its own heartbeat (never via the cron map —
-- see the comment on cron_job_heartbeat_map).
insert into public.job_heartbeats (job_name, stale_after, last_status, last_detail, watch)
values ('checkout-recovery', interval '3 hours', 'ok', 'seeded 13 Oct — awaiting first run', true)
on conflict (job_name) do update set stale_after = excluded.stale_after;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFY — all three. Expect every row PASS.
-- ════════════════════════════════════════════════════════════════════════════
select 'history table exists' as check,
       case when to_regclass('public.api_key_events') is not null then 'PASS' else 'FAIL' end as result
union all
select 'browser cannot write history',
       case when has_table_privilege('authenticated', 'public.api_key_events', 'INSERT') then 'FAIL' else 'PASS' end
union all
select 'guard triggers installed',
       case when (select count(*) from pg_trigger
                   where tgname in ('api_keys_guard_update', 'api_keys_guard_insert') and not tgisinternal) = 2
            then 'PASS' else 'FAIL' end
union all
select 'history triggers installed',
       case when (select count(*) from pg_trigger
                   where tgname in ('api_keys_log_insert', 'api_keys_log_update') and not tgisinternal) = 2
            then 'PASS' else 'FAIL' end
union all
select 'rotate_api_key callable by signed-in users only',
       case when has_function_privilege('authenticated', 'public.rotate_api_key(uuid, integer)', 'EXECUTE')
             and not has_function_privilege('anon', 'public.rotate_api_key(uuid, integer)', 'EXECUTE')
            then 'PASS' else 'FAIL' end
union all
select 'revoke_api_key callable by signed-in users only',
       case when has_function_privilege('authenticated', 'public.revoke_api_key(uuid, text)', 'EXECUTE')
             and not has_function_privilege('anon', 'public.revoke_api_key(uuid, text)', 'EXECUTE')
            then 'PASS' else 'FAIL' end
union all
select 'resolve_api_key still service-only',
       case when has_function_privilege('authenticated', 'public.resolve_api_key(text)', 'EXECUTE')
              or has_function_privilege('anon', 'public.resolve_api_key(text)', 'EXECUTE')
            then 'FAIL' else 'PASS' end
union all
select 'events table, super-admin read only' as check,
       case when to_regclass('public.product_events') is not null
             and not has_table_privilege('authenticated', 'public.product_events', 'INSERT')
             and not has_table_privilege('anon', 'public.product_events', 'INSERT')
            then 'PASS' else 'FAIL' end as result
union all
select 'browser can call track_event',
       case when has_function_privilege('anon', 'public.track_event(text, text, text, jsonb)', 'EXECUTE')
            then 'PASS' else 'FAIL' end
union all
select 'browser cannot call the server writer',
       case when has_function_privilege('anon', 'public.log_product_event(text, uuid, uuid, jsonb)', 'EXECUTE')
              or has_function_privilege('authenticated', 'public.log_product_event(text, uuid, uuid, jsonb)', 'EXECUTE')
            then 'FAIL' else 'PASS' end
union all
select 'six source-of-truth triggers installed',
       case when (select count(*) from pg_trigger where not tgisinternal and tgname in
                   ('payments_product_events', 'subscriptions_product_events', 'organizations_product_events',
                    'profiles_product_events', 'pipeline_stages_product_events', 'api_keys_product_events')) = 6
            then 'PASS' else 'FAIL' end
union all
select 'track_event refuses unknown events',
       case when public.track_event('drop_table_users', null, null, '{}'::jsonb) = false then 'PASS' else 'FAIL' end
union all
select 'retention job scheduled',
       case when exists (select 1 from cron.job where jobname = 'purge-product-events') then 'PASS' else 'FAIL' end
union all
select 'ships disabled and in dry-run' as check,
       case when (select not enabled and dry_run from public.checkout_recovery_settings where id)
            then 'PASS' else 'CHECK — already switched on' end as result
union all
select 'candidate query runs',
       case when (select count(*) from public.checkout_recovery_candidates(5)) >= 0 then 'PASS' else 'FAIL' end
union all
select 'browser cannot write the send log',
       case when has_table_privilege('authenticated', 'public.checkout_followups', 'INSERT') then 'FAIL' else 'PASS' end
union all
select 'browser cannot call the raw candidate query',
       case when has_function_privilege('authenticated', 'public.checkout_recovery_candidates(integer)', 'EXECUTE')
            then 'FAIL' else 'PASS' end
union all
select 'scheduled hourly',
       case when exists (select 1 from cron.job where jobname = 'abrobot-checkout-recovery') then 'PASS' else 'FAIL' end;
