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

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFY — static only (the SQL editor has no JWT). Expect every row PASS.
-- The behavioural tests are in scripts/test-api-keys.sql.
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
            then 'FAIL' else 'PASS' end;
