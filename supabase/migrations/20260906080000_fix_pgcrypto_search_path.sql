-- AbroBot CRM — make the API and webhook functions able to find pgcrypto.
--
-- ── The failure ─────────────────────────────────────────────────────────────
-- `GET /api/v1/me` with a well-formed key returned:
--
--     500  {"error": "Could not verify the key"}
--
-- which is the edge function's message for "resolve_api_key raised", not for
-- "that key is unknown". A wrong key is supposed to be a 401.
--
-- Cause: `digest()`, `gen_random_bytes()` and `hmac()` belong to pgcrypto, and
-- Supabase installs pgcrypto into the `extensions` schema. Three functions in
-- 20260905090000 pin `set search_path = public` (correct instinct — an
-- unpinned search_path on a SECURITY DEFINER function is a privilege-escalation
-- hole) but pinning it that tightly also hides pgcrypto from them.
--
-- Why nothing caught it earlier: PostgreSQL does not resolve function calls
-- inside a plpgsql body at CREATE time, so all three were created without
-- complaint. The migration reported success, `api_keys` existed, and the
-- verification query — which only asked whether the table and functions
-- existed — passed. Existing and working are different things. This is the
-- same gap as the RLS "reads correctly vs behaves correctly" one, and the
-- lesson is the same: end the check by *calling* the thing.
--
-- Blast radius, all of it silent until used:
--   * resolve_api_key  — every API request fails with a 500
--   * create_api_key   — you cannot create a key at all
--   * fire_webhooks    — every outbound webhook signature fails, so no
--                        delivery is ever attempted
--
-- ── The fix ─────────────────────────────────────────────────────────────────
-- ALTER FUNCTION ... SET search_path changes only the setting. The bodies are
-- not retyped here, so there is no chance of them drifting from the migration
-- that defines them.
--
-- The schema is discovered rather than assumed: pgcrypto lives in `extensions`
-- on Supabase and in `public` on a plain PostgreSQL install, and hard-coding
-- either one breaks the other.

do $$
declare
  v_ext  text;
  v_path text;
begin
  select n.nspname into v_ext
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgcrypto';

  if v_ext is null then
    raise exception 'pgcrypto is not installed. Run: create extension pgcrypto with schema extensions;';
  end if;

  -- Keep public first so unqualified references still mean our own objects.
  v_path := case when v_ext = 'public' then 'public' else format('public, %I', v_ext) end;
  raise notice 'pgcrypto is in schema %; search_path -> %', v_ext, v_path;

  execute format('alter function public.resolve_api_key(text) set search_path = %s', v_path);
  execute format('alter function public.create_api_key(text, text[], integer) set search_path = %s', v_path);
  -- fire_webhooks also needs `net` for pg_net's http_post.
  execute format('alter function public.fire_webhooks(uuid, text, jsonb) set search_path = %s, net', v_path);

  -- webhook_endpoints.secret defaults to gen_random_bytes(). A column default
  -- is evaluated under the *session's* search_path, so it happens to work from
  -- the app today and would fail from anything with a narrower path. Qualify
  -- it so it does not depend on who is inserting.
  execute format(
    'alter table public.webhook_endpoints alter column secret set default encode(%I.gen_random_bytes(24), ''hex'')',
    v_ext);
end $$;

-- ── Prove it, rather than assume it ─────────────────────────────────────────
-- This is the step whose absence let the bug ship. A key of 'x' matches
-- nothing, so a working function returns zero rows; a broken one raises
-- "function digest(text, unknown) does not exist" and this migration fails
-- loudly instead of reporting success.
do $$
declare n int;
begin
  select count(*) into n from public.resolve_api_key('not-a-real-key');
  raise notice 'resolve_api_key executed cleanly and matched % row(s) — expected 0', n;
end $$;

-- Same for the signing path: hmac must resolve inside fire_webhooks' pinned
-- search_path. No endpoint matches a random org id, so nothing is sent.
do $$
declare n int;
begin
  select public.fire_webhooks(gen_random_uuid(), 'lead.created', '{}'::jsonb) into n;
  raise notice 'fire_webhooks executed cleanly, fired % (expected 0)', n;
end $$;
