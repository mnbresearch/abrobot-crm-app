-- AbroBot CRM — behavioural tests for the API key lifecycle.
--
-- Run the whole file in the Supabase SQL editor AFTER applying
-- 20261013090000_api_key_lifecycle.sql. The last statement is the report:
-- every row should say PASS.
--
-- ── What it does ────────────────────────────────────────────────────────────
-- Builds two throwaway organisations (A and B), an admin in each and an
-- ordinary member in A, then BECOMES those users for real — `set local role
-- authenticated` plus a JWT claim, which is exactly what PostgREST does for a
-- browser session — and exercises create, resolve, rotate (with and without
-- overlap), revoke, expiry, the guard rails, and cross-tenant access.
--
-- ── Safety ──────────────────────────────────────────────────────────────────
-- Everything runs inside one sub-block that ends by raising a sentinel error,
-- so PostgreSQL rolls ALL of it back: the probe users, orgs, keys and history
-- rows never persist, and nothing that already exists is modified. Results are
-- carried out of the rolled-back block in a variable and written to a TEMP
-- table, which disappears when the editor session ends.

create temp table if not exists _apikey_results (ord int, test text, verdict text, detail text);
truncate _apikey_results;

do $t$
declare
  r      jsonb := '[]'::jsonb;
  ua     uuid := gen_random_uuid();
  ub     uuid := gen_random_uuid();
  um     uuid := gen_random_uuid();
  oa     uuid;
  ob     uuid;
  res    jsonb;
  raw_a  text;  id_a  uuid;
  raw_a2 text;  id_a2 uuid;
  raw_a3 text;  id_a3 uuid;
  raw_b  text;  id_b  uuid;
  raw_x  text;  id_x  uuid;
  n      bigint;
  ok     boolean;
  msg    text;
  v_exp  timestamptz;
begin
  begin
    -- ── fixtures, as the owner ─────────────────────────────────────────────
    insert into auth.users (id, email) values
      (ua, 'keytest-a@example.invalid'), (ub, 'keytest-b@example.invalid'), (um, 'keytest-m@example.invalid');

    insert into public.organizations (name, slug, active, plan, trial_started_at, trial_days, credits_total, credits_used)
    values ('Key Test A', 'zz-keytest-a', true, 'free', now(), 0, 0, 0) returning id into oa;
    insert into public.organizations (name, slug, active, plan, trial_started_at, trial_days, credits_total, credits_used)
    values ('Key Test B', 'zz-keytest-b', true, 'free', now(), 0, 0, 0) returning id into ob;

    perform set_config('app.profile_bootstrap', 'on', true);
    insert into public.profiles (id, org_id, role, status, email, full_name) values
      (ua, oa, 'org_admin',  'active', 'keytest-a@example.invalid', 'Key Test A'),
      (ub, ob, 'org_admin',  'active', 'keytest-b@example.invalid', 'Key Test B'),
      (um, oa, 'counsellor', 'active', 'keytest-m@example.invalid', 'Key Test M')
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role, status = excluded.status;

    -- ── 1. create, as admin A ──────────────────────────────────────────────
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    res := public.create_api_key('test key A', array['leads:read'], 30);
    raw_a := res->>'key'; id_a := (res->>'id')::uuid;
    execute 'reset role';

    r := r || jsonb_build_object('t', 'key has 256 bits of randomness (abk_live_ + 64 hex)',
                                 'ok', raw_a ~ '^abk_live_[0-9a-f]{64}$', 'd', left(raw_a, 17) || '…');

    select count(*) into n from public.api_keys
     where id = id_a and key_hash = encode(extensions.digest(raw_a, 'sha256'), 'hex') and key_prefix = left(raw_a, 17);
    r := r || jsonb_build_object('t', 'only the SHA-256 hash and display prefix are stored', 'ok', n = 1, 'd', n || ' row');

    select count(*) into n from public.api_keys k where k::text like '%' || raw_a || '%';
    r := r || jsonb_build_object('t', 'the raw key appears nowhere in the row', 'ok', n = 0, 'd', n || ' rows');

    select count(*) into n from public.resolve_api_key(raw_a) x where x.org_id = oa;
    r := r || jsonb_build_object('t', 'a valid key authenticates to its own org', 'ok', n = 1, 'd', n || ' row');

    select count(*) into n from public.api_key_events where key_id = id_a and event = 'created' and actor_id = ua;
    r := r || jsonb_build_object('t', 'creation is recorded with the actor', 'ok', n = 1, 'd', n || ' event');

    -- ── 2. an ordinary member cannot create keys ───────────────────────────
    perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    begin
      perform public.create_api_key('member key', array['leads:read'], null);
      ok := false; msg := 'created';
    exception when others then ok := true; msg := left(sqlerrm, 80); end;
    execute 'reset role';
    r := r || jsonb_build_object('t', 'a non-admin member cannot create a key', 'ok', ok, 'd', msg);

    -- ── 3. cross-tenant: admin A against org B's key ───────────────────────
    perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    res := public.create_api_key('test key B', array['leads:read','leads:write'], null);
    raw_b := res->>'key'; id_b := (res->>'id')::uuid;
    execute 'reset role';

    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    select count(*) into n from public.api_keys where id = id_b;
    r := r || jsonb_build_object('t', 'cross-tenant: A cannot see B''s key', 'ok', n = 0, 'd', n || ' rows');

    begin perform public.rotate_api_key(id_b, 0); ok := false; msg := 'rotated';
    exception when others then ok := true; msg := left(sqlerrm, 80); end;
    r := r || jsonb_build_object('t', 'cross-tenant: A cannot rotate B''s key', 'ok', ok, 'd', msg);

    begin perform public.revoke_api_key(id_b, 'attack'); ok := false; msg := 'revoked';
    exception when others then ok := true; msg := left(sqlerrm, 80); end;
    r := r || jsonb_build_object('t', 'cross-tenant: A cannot revoke B''s key via the function', 'ok', ok, 'd', msg);

    update public.api_keys set revoked_at = now() where id = id_b;
    get diagnostics n = row_count;
    r := r || jsonb_build_object('t', 'cross-tenant: A cannot revoke B''s key via UPDATE', 'ok', n = 0, 'd', n || ' rows');

    select count(*) into n from public.api_key_events where key_id = id_b;
    r := r || jsonb_build_object('t', 'cross-tenant: A cannot read B''s key history', 'ok', n = 0, 'd', n || ' rows');

    begin
      insert into public.api_key_events (key_id, org_id, event) values (id_a, oa, 'revoked');
      ok := false; msg := 'inserted';
    exception when others then ok := true; msg := left(sqlerrm, 80); end;
    r := r || jsonb_build_object('t', 'nobody can forge history from a browser session', 'ok', ok, 'd', msg);

    -- ── 4. guard rails on direct UPDATE, as A on A's own key ──────────────
    begin update public.api_keys set key_hash = 'x' where id = id_a; ok := false; msg := 'changed';
    exception when others then ok := true; msg := left(sqlerrm, 80); end;
    r := r || jsonb_build_object('t', 'key_hash cannot be rewritten', 'ok', ok, 'd', msg);

    begin update public.api_keys set expires_at = now() + interval '5 years' where id = id_a; ok := false; msg := 'extended';
    exception when others then ok := true; msg := left(sqlerrm, 80); end;
    r := r || jsonb_build_object('t', 'expiry cannot be extended', 'ok', ok, 'd', msg);

    begin update public.api_keys set scopes = array['admin:everything'] where id = id_a; ok := false; msg := 'accepted';
    exception when others then ok := true; msg := left(sqlerrm, 80); end;
    r := r || jsonb_build_object('t', 'an unknown scope is refused', 'ok', ok, 'd', msg);

    begin update public.api_keys set revoked_by = ub, revoke_reason = 'framed' where id = id_a; ok := false; msg := 'accepted';
    exception when others then ok := true; msg := left(sqlerrm, 80); end;
    r := r || jsonb_build_object('t', 'revocation details cannot be pre-set on a live key', 'ok', ok, 'd', msg);

    -- ── 5. rotation with a 60-minute overlap ───────────────────────────────
    res := public.rotate_api_key(id_a, 60);
    raw_a2 := res->>'key'; id_a2 := (res->>'id')::uuid;
    execute 'reset role';

    select count(*) into n from public.resolve_api_key(raw_a);
    r := r || jsonb_build_object('t', 'overlap: the OLD key still works during the overlap', 'ok', n = 1, 'd', n || ' row');
    select count(*) into n from public.resolve_api_key(raw_a2);
    r := r || jsonb_build_object('t', 'overlap: the NEW key works', 'ok', n = 1, 'd', n || ' row');

    select expires_at into v_exp from public.api_keys where id = id_a;
    r := r || jsonb_build_object('t', 'overlap: the old key now expires within 60 minutes',
                                 'ok', v_exp > now() and v_exp <= now() + interval '61 minutes', 'd', v_exp::text);

    select count(*) into n from public.api_keys where id = id_a2 and rotated_from = id_a and scopes = array['leads:read']
       and expires_at is not null;
    r := r || jsonb_build_object('t', 'rotation keeps scopes and keeps the key expiring', 'ok', n = 1, 'd', n || ' row');

    select count(*) into n from public.api_key_events where key_id = id_a and event = 'rotated' and actor_id = ua;
    r := r || jsonb_build_object('t', 'rotation is recorded', 'ok', n = 1, 'd', n || ' event');

    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    begin perform public.rotate_api_key(id_a, 0); ok := false; msg := 'rotated twice';
    exception when others then ok := true; msg := left(sqlerrm, 80); end;
    r := r || jsonb_build_object('t', 'a key cannot be rotated twice (no second live replacement)', 'ok', ok, 'd', msg);

    begin
      insert into public.api_keys (org_id, name, key_hash, key_prefix, scopes, rotated_from)
      values (oa, 'planted', md5(random()::text), 'abk_live_planted', array['leads:read'], id_b);
      ok := false; msg := 'inserted';
    exception when others then ok := true; msg := left(sqlerrm, 80); end;
    r := r || jsonb_build_object('t', 'rotated_from cannot point at another org''s key', 'ok', ok, 'd', msg);
    execute 'reset role';

    -- ── 6. rotation with no overlap ────────────────────────────────────────
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    res := public.rotate_api_key(id_a2, 0);
    raw_a3 := res->>'key'; id_a3 := (res->>'id')::uuid;
    execute 'reset role';

    select count(*) into n from public.resolve_api_key(raw_a2);
    r := r || jsonb_build_object('t', 'immediate rotation: the old key stops at once', 'ok', n = 0, 'd', n || ' rows');
    select count(*) into n from public.resolve_api_key(raw_a3);
    r := r || jsonb_build_object('t', 'immediate rotation: the new key works', 'ok', n = 1, 'd', n || ' row');

    -- ── 7. revoke, and revocation is one-way ───────────────────────────────
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    perform public.revoke_api_key(id_a3, 'test');
    begin update public.api_keys set revoked_at = null where id = id_a3; ok := false; msg := 'restored';
    exception when others then ok := true; msg := left(sqlerrm, 80); end;
    r := r || jsonb_build_object('t', 'a revoked key cannot be un-revoked', 'ok', ok, 'd', msg);
    execute 'reset role';

    select count(*) into n from public.resolve_api_key(raw_a3);
    r := r || jsonb_build_object('t', 'a revoked key is refused immediately', 'ok', n = 0, 'd', n || ' rows');

    select count(*) into n from public.api_key_events where key_id = id_a3 and event = 'revoked' and actor_id = ua
       and detail->>'reason' = 'test';
    r := r || jsonb_build_object('t', 'revocation is recorded with actor and reason', 'ok', n = 1, 'd', n || ' event');

    -- ── 8. an expired key ──────────────────────────────────────────────────
    raw_x := 'abk_live_' || encode(extensions.gen_random_bytes(32), 'hex');
    insert into public.api_keys (org_id, name, key_hash, key_prefix, scopes, expires_at, created_at)
    values (oa, 'expired', encode(extensions.digest(raw_x, 'sha256'), 'hex'), left(raw_x, 17),
            array['leads:read'], now() - interval '1 minute', now() - interval '2 days')
    returning id into id_x;

    select count(*) into n from public.resolve_api_key(raw_x);
    r := r || jsonb_build_object('t', 'an expired key is refused', 'ok', n = 0, 'd', n || ' rows');

    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    begin perform public.rotate_api_key(id_x, 0); ok := false; msg := 'rotated';
    exception when others then ok := true; msg := left(sqlerrm, 80); end;
    r := r || jsonb_build_object('t', 'an expired key cannot be rotated back to life', 'ok', ok, 'd', msg);
    execute 'reset role';

    -- ── 9. B's key was untouched by everything A tried ─────────────────────
    select count(*) into n from public.resolve_api_key(raw_b) x where x.org_id = ob;
    r := r || jsonb_build_object('t', 'B''s key still works after A''s attempts', 'ok', n = 1, 'd', n || ' row');

    -- Unwind everything above.
    raise exception using errcode = 'ZZ999', message = 'rollback';
  exception
    when sqlstate 'ZZ999' then null;
    when others then
      r := r || jsonb_build_object('t', 'the test itself', 'ok', false, 'd', sqlstate || ': ' || left(sqlerrm, 200));
  end;

  begin execute 'reset role'; exception when others then null; end;

  insert into _apikey_results
  select ord::int, e->>'t', case when (e->>'ok')::boolean then 'PASS' else 'FAIL' end, e->>'d'
    from jsonb_array_elements(r) with ordinality as x(e, ord);
end $t$;

select ord, test, verdict, detail from _apikey_results order by verdict = 'PASS', ord;
