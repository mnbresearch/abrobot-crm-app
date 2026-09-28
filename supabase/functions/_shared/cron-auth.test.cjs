// Tests for the guard on the scheduled functions. This is the security suite.
//
// run-automations, nurture, system-health and summarize-chats are deployed
// --no-verify-jwt (pg_cron calls them over HTTP with no Supabase JWT) and each
// takes the target organisation from the request body. Before this guard,
// anyone who knew the URL could read every tenant's lead and rule names, email
// another customer's leads from our sending domain, list which credentials each
// org stores, and burn unmetered Groq completions on the shared key.
//
// Two specific things are asserted hardest here, because each has already been
// shipped wrong once in this codebase:
//
//  1. FAIL CLOSED when CRON_SECRET is unset. The tempting version,
//     `if (SECRET && header !== SECRET) reject`, leaves the endpoint wide open
//     in exactly the deployment state that is the default — no secret set.
//     app-signup shipped that bug and was unauthenticated in production. So
//     the unset-secret scenario below asserts denial for a request with no
//     header AND for one with a plausible-looking header, because the inverted
//     form passes the first of those and fails the second.
//
//  2. TRIM both sides. The Supabase dashboard's secret Value box is a
//     multi-line textarea, so a paste can carry a trailing newline that is
//     completely invisible in the UI. That happened on 14 September: the secret
//     was correct, one character longer than intended, and every scheduled call
//     came back 401 with nothing on screen to distinguish it from a wrong
//     value — a multi-day outage nobody could diagnose.
//
// And for requireCronOrMember, the invariant that makes the JWT path safe at
// all: org and role come from the TOKEN's profiles row, never from the request.
// A request that asserts its own org must be ignored, or the JWT path
// reintroduces the cross-tenant hole the secret was added to close.

const path = require('path');

// Resolved from this file's own location, never hardcoded. Two suites in this
// directory previously pinned an absolute sandbox path: on CI the path did not
// exist so the tests job went red on every push, and on a machine where it DID
// exist the suite reported PASS about a different copy of the repo than the one
// being built.
function loadEsbuild() {
  const candidates = [
    'esbuild',
    path.join(__dirname, '..', '..', '..', 'app', 'node_modules', 'esbuild'),
    path.join(__dirname, '..', '..', '..', 'node_modules', 'esbuild'),
    '/tmp/node_modules/esbuild',
  ];
  for (const c of candidates) {
    try {
      const mod = require(c);
      mod.transformSync('const a = 1;', { loader: 'ts' });
      return mod;
    } catch (_) { /* next */ }
  }
  console.log('SKIP ' + path.basename(__filename) + ' — no usable esbuild for this platform. Run `npm ci` in app/.');
  process.exit(0);
}

const es = loadEsbuild();
const fs = require('fs'), assert = require('assert');

// cron-auth.ts imports nothing, so transformSync is enough — but it reads
// Deno.env.get("CRON_SECRET") at MODULE SCOPE, into a `const`. That means the
// env is baked in at import time and cannot be changed afterwards, so every env
// scenario needs a fresh evaluation of the module rather than a fresh call.
//
// Compiling once and re-running the factory is the fresh-registry equivalent
// here: `new Function` gives a brand-new module scope each time, with no
// require.cache entry to invalidate.
const SRC = fs.readFileSync(path.join(__dirname, 'cron-auth.ts'), 'utf8');
const JS = es.transformSync(SRC, { loader: 'ts', format: 'cjs' }).code;

function loadWith(cronSecretEnvValue) {
  // Set Deno BEFORE evaluating, because the read happens during evaluation.
  // `undefined` for an unset secret, which is what Deno.env.get really returns
  // — not '' — so the `?? ""` in the module is actually exercised.
  globalThis.Deno = {
    env: { get: (k) => (k === 'CRON_SECRET' ? cronSecretEnvValue : undefined) },
  };
  const stubRequire = (spec) => { throw new Error('unexpected import: ' + spec); };
  const m = { exports: {} };
  new Function('module', 'exports', 'require', JS)(m, m.exports, stubRequire);
  if (typeof m.exports.requireCronSecret !== 'function' ||
      typeof m.exports.requireCronOrMember !== 'function') {
    console.log('FAILED - cron-auth.ts does not export both guards');
    process.exit(1);
  }
  return m.exports;
}

const SECRET = 'a3f1'.repeat(16);                 // 64 hex chars, like `openssl rand -hex 32`
const WRONG_SAME_LENGTH = 'b3f1'.repeat(16);      // same length: exercises the compare, not the length check
const CORS = { 'access-control-allow-origin': '*' };

const req = (headers = {}, url = 'https://fn.example/run-automations', body) =>
  new Request(url, body === undefined
    ? { headers }
    : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// ── A fake admin client. Resolves, never throws. ──────────────────────────────
//
// `auth.getUser` and the profiles read both resolve with { data, error } the way
// supabase-js does. The token and the filter are captured so "the profiles row
// was looked up by the TOKEN's user id" is provable, rather than assumed from
// the returned org happening to look right.
function fakeAdmin({ user, userError = null, profile = null, profileErr = null } = {}) {
  const seen = { getUserToken: null, getUserCalls: 0, table: null, columns: null, filters: {}, profileReads: 0 };
  const row = {
    select(c) { seen.columns = c; return row; },
    eq(k, v) { seen.filters[k] = v; return row; },
    maybeSingle() {
      seen.profileReads++;
      return Promise.resolve(profileErr ? { data: null, error: profileErr } : { data: profile, error: null });
    },
  };
  return {
    seen,
    auth: {
      getUser(t) {
        seen.getUserToken = t;
        seen.getUserCalls++;
        return Promise.resolve(userError ? { data: null, error: userError } : { data: { user }, error: null });
      },
    },
    from(table) { seen.table = table; return row; },
  };
}

const USER = { id: 'user-123' };
const ACTIVE_MEMBER = { org_id: 'org-real', status: 'active', role: 'member' };

// Silence (but keep) the module's own console.error so the run stays readable,
// and so the "not configured" path can be asserted to actually log.
function quietErrors(fn) {
  const logged = [];
  const real = console.error;
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  return Promise.resolve().then(fn).then((value) => ({ value, logged }))
    .finally(() => { console.error = real; });
}

const bodyOf = (res) => res.json();

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); failed++; }
}

(async () => {
  console.log('cron-auth');

  // ══ requireCronSecret: CRON_SECRET UNSET — fail closed ═════════════════════
  {
    const { requireCronSecret } = loadWith(undefined);

    await test('UNSET secret: a request with NO header is denied', async () => {
      const { value: r, logged } = await quietErrors(() => requireCronSecret(req(), CORS));
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.response.status, 401);
      assert.deepStrictEqual(await bodyOf(r.response), { error: 'not configured' });
      assert.ok(logged.some((l) => /CRON_SECRET/.test(l)),
        'the missing secret must be logged — system-health is how anyone finds out');
    });

    await test('UNSET secret: a request with a PLAUSIBLE header is denied', async () => {
      // THE app-signup bug. `if (SECRET && header !== SECRET) reject` accepts
      // this request, and every other request, whenever the secret is missing —
      // which is the deployment default. A no-header test alone passes under
      // that inverted form, so this case is the one that catches it.
      const { value: r } = await quietErrors(() =>
        requireCronSecret(req({ 'x-cron-secret': SECRET }), CORS));
      assert.strictEqual(r.ok, false, 'with no secret configured, NOTHING may be authorised');
      assert.strictEqual(r.response.status, 401);
      assert.deepStrictEqual(await bodyOf(r.response), { error: 'not configured' });
    });

    await test('UNSET secret: every shape of request is denied', async () => {
      const shapes = [
        {},
        { 'x-cron-secret': '' },
        { 'x-cron-secret': '   ' },
        { 'x-cron-secret': WRONG_SAME_LENGTH },
        { 'x-cron-secret': 'undefined' },
        { 'x-cron-secret': 'null' },
        { authorization: 'Bearer ' + SECRET },
      ];
      for (const h of shapes) {
        const { value: r } = await quietErrors(() => requireCronSecret(req(h), CORS));
        assert.strictEqual(r.ok, false, 'allowed with headers ' + JSON.stringify(h));
      }
    });

    await test('UNSET secret: an empty-string env value is also treated as unset', async () => {
      // `Deno.env.get` returns '' for a secret created with an empty value, and
      // `''.trim()` is still falsy — so this must fail closed too, not compare
      // the caller's '' against the configured ''.
      const mod = loadWith('');
      const { value: r } = await quietErrors(() =>
        mod.requireCronSecret(req({ 'x-cron-secret': '' }), CORS));
      assert.strictEqual(r.ok, false, 'empty === empty must NOT be a successful compare');
    });

    await test('UNSET secret: the denial carries the CORS headers, so the browser sees the 401', async () => {
      const { value: r } = await quietErrors(() => requireCronSecret(req(), CORS));
      assert.strictEqual(r.response.headers.get('access-control-allow-origin'), '*');
    });
  }

  // ══ requireCronSecret: secret configured ═══════════════════════════════════
  {
    const { requireCronSecret } = loadWith(SECRET);

    await test('the exact secret is accepted', async () => {
      const r = requireCronSecret(req({ 'x-cron-secret': SECRET }), CORS);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.response, undefined);
    });

    await test('a secret with a TRAILING NEWLINE is accepted', async () => {
      // The 14 September outage. Both sides are trimmed precisely so an
      // invisible character pasted into a textarea cannot cost another
      // multi-day outage that looks identical to a wrong value.
      const r = requireCronSecret(req({ 'x-cron-secret': SECRET + '\n' }), CORS);
      assert.strictEqual(r.ok, true);
    });

    await test('a secret with SURROUNDING SPACES is accepted', async () => {
      assert.strictEqual(requireCronSecret(req({ 'x-cron-secret': '  ' + SECRET + '  ' }), CORS).ok, true);
      assert.strictEqual(requireCronSecret(req({ 'x-cron-secret': '\t' + SECRET + '\r\n' }), CORS).ok, true);
    });

    await test('the WRONG secret is denied, even at the same length', async () => {
      // Same length, so this reaches the byte compare rather than stopping at
      // the length guard — the compare itself is under test.
      const r = requireCronSecret(req({ 'x-cron-secret': WRONG_SAME_LENGTH }), CORS);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.response.status, 401);
      assert.deepStrictEqual(await bodyOf(r.response), { error: 'unauthorized' });
    });

    await test('a PREFIX of the secret is denied', async () => {
      // The length check must not be reachable as a shortcut to success.
      assert.strictEqual(requireCronSecret(req({ 'x-cron-secret': SECRET.slice(0, -1) }), CORS).ok, false);
      assert.strictEqual(requireCronSecret(req({ 'x-cron-secret': SECRET + 'x' }), CORS).ok, false);
      assert.strictEqual(requireCronSecret(req({ 'x-cron-secret': SECRET[0] }), CORS).ok, false);
    });

    await test('a missing or blank header is denied, and does not read as "trimmed to equal"', async () => {
      for (const h of [{}, { 'x-cron-secret': '' }, { 'x-cron-secret': '   \n' }]) {
        const r = requireCronSecret(req(h), CORS);
        assert.strictEqual(r.ok, false, 'allowed with headers ' + JSON.stringify(h));
        assert.deepStrictEqual(await bodyOf(r.response), { error: 'unauthorized' });
      }
    });

    await test('the secret is case-sensitive', async () => {
      assert.strictEqual(requireCronSecret(req({ 'x-cron-secret': SECRET.toUpperCase() }), CORS).ok, false);
    });

    await test('the secret is not accepted from Authorization or the query string', async () => {
      // Only the one header it documents. Accepting the secret anywhere else
      // widens where it can leak — query strings end up in access logs.
      assert.strictEqual(requireCronSecret(req({ authorization: 'Bearer ' + SECRET }), CORS).ok, false);
      assert.strictEqual(
        requireCronSecret(req({}, 'https://fn.example/run-automations?secret=' + SECRET), CORS).ok, false);
    });
  }

  // ══ requireCronOrMember ════════════════════════════════════════════════════
  //
  // Added because the secret broke two buttons in the CRM that legitimately hit
  // these endpoints — "▶ Test run" on Automations and "✨ AI summary" on
  // Conversations. The browser sends the user's JWT and cannot send a
  // server-side secret, so both became permanent red toasts.
  {
    const { requireCronOrMember } = loadWith(SECRET);

    await test('the scheduler path is accepted without touching the database', async () => {
      const admin = fakeAdmin();
      const r = await requireCronOrMember(req({ 'x-cron-secret': SECRET }), CORS, admin);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.orgId, undefined, 'the scheduler is not a member of any org');
      assert.strictEqual(admin.seen.getUserCalls, 0, 'no session lookup for a cron call');
      assert.strictEqual(admin.seen.profileReads, 0);
    });

    await test('the scheduler path also tolerates a trailing newline', async () => {
      const r = await requireCronOrMember(req({ 'x-cron-secret': SECRET + '\n' }), CORS, fakeAdmin());
      assert.strictEqual(r.ok, true);
    });

    await test('no credentials at all is 401', async () => {
      const r = await requireCronOrMember(req(), CORS, fakeAdmin());
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.response.status, 401);
      assert.deepStrictEqual(await bodyOf(r.response), { error: 'unauthorized' });
    });

    await test('an invalid session is 401 and never reaches profiles', async () => {
      const admin = fakeAdmin({ userError: { message: 'invalid JWT' } });
      const r = await requireCronOrMember(req({ authorization: 'Bearer nonsense' }), CORS, admin);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.response.status, 401);
      assert.deepStrictEqual(await bodyOf(r.response), { error: 'invalid session' });
      assert.strictEqual(admin.seen.profileReads, 0);
    });

    await test('a resolved getUser with no user is 401, not an allow', async () => {
      // supabase-js can resolve { data: { user: null }, error: null }.
      const admin = fakeAdmin({ user: null });
      const r = await requireCronOrMember(req({ authorization: 'Bearer stale' }), CORS, admin);
      assert.strictEqual(r.ok, false);
      assert.deepStrictEqual(await bodyOf(r.response), { error: 'invalid session' });
    });

    // ── THE cross-tenant invariant ───────────────────────────────────────────
    await test('orgId and role come from the PROFILES ROW, and a request-supplied org is ignored', async () => {
      // The whole reason the JWT path is safe. These endpoints take their org
      // from the body; if this path honoured that, adding the secret would have
      // closed the anonymous hole and left an authenticated one open — any
      // signed-in user of any tenant could act on any other tenant's org.
      const admin = fakeAdmin({ user: USER, profile: ACTIVE_MEMBER });
      const r = await requireCronOrMember(
        req({ authorization: 'Bearer good' },
            'https://fn.example/nurture?org=org-attacker',
            { org: 'org-attacker', org_id: 'org-attacker' }),
        CORS, admin);

      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.orgId, 'org-real', 'the body/query org must NOT win');
      assert.strictEqual(r.role, 'member');
      assert.strictEqual(r.userId, 'user-123');
      assert.strictEqual(admin.seen.table, 'profiles');
      assert.strictEqual(admin.seen.filters.id, 'user-123',
        'the profiles row must be keyed by the id the TOKEN resolved to');
      assert.ok(/org_id/.test(admin.seen.columns) && /status/.test(admin.seen.columns) &&
                /role/.test(admin.seen.columns), admin.seen.columns);
    });

    await test('the request body is never even read', async () => {
      // Stronger than "the returned org is right": if the guard does not
      // consume the body, it cannot be influenced by it, and the handler
      // downstream can still read it.
      const request = req({ authorization: 'Bearer good' }, 'https://fn.example/nurture',
        { org: 'org-attacker' });
      await requireCronOrMember(request, CORS, fakeAdmin({ user: USER, profile: ACTIVE_MEMBER }));
      assert.strictEqual(request.bodyUsed, false);
    });

    await test('a role asserted by the request is ignored', async () => {
      // `role` is returned, never accepted. It is derived from profiles so a
      // request cannot promote itself to super_admin.
      const admin = fakeAdmin({ user: USER, profile: ACTIVE_MEMBER });
      const r = await requireCronOrMember(
        req({ authorization: 'Bearer good', 'x-role': 'super_admin' },
            'https://fn.example/nurture?role=super_admin', { role: 'super_admin' }),
        CORS, admin);
      assert.strictEqual(r.role, 'member');
    });

    await test('the Bearer prefix is stripped before the token is used', async () => {
      const admin = fakeAdmin({ user: USER, profile: ACTIVE_MEMBER });
      await requireCronOrMember(req({ authorization: 'Bearer abc.def.ghi' }), CORS, admin);
      assert.strictEqual(admin.seen.getUserToken, 'abc.def.ghi');
    });

    // ── Membership state ─────────────────────────────────────────────────────
    await test('status !== "active" is 403', async () => {
      for (const status of ['invited', 'suspended', 'removed', '', null]) {
        const admin = fakeAdmin({ user: USER, profile: { ...ACTIVE_MEMBER, status } });
        const r = await requireCronOrMember(req({ authorization: 'Bearer good' }), CORS, admin);
        assert.strictEqual(r.ok, false, 'allowed with status ' + JSON.stringify(status));
        assert.strictEqual(r.response.status, 403, 'status ' + JSON.stringify(status));
        assert.deepStrictEqual(await bodyOf(r.response), { error: 'not an active member' });
      }
    });

    await test('an active profile with NO org is 403, not an undefined org downstream', async () => {
      const admin = fakeAdmin({ user: USER, profile: { org_id: null, status: 'active', role: 'org_admin' } });
      const r = await requireCronOrMember(req({ authorization: 'Bearer good' }), CORS, admin);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.response.status, 403);
    });

    await test('no profiles row at all is 403', async () => {
      const admin = fakeAdmin({ user: USER, profile: null });
      const r = await requireCronOrMember(req({ authorization: 'Bearer good' }), CORS, admin);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.response.status, 403);
    });

    // ── adminOnly ────────────────────────────────────────────────────────────
    await test('adminOnly rejects a plain member with 403', async () => {
      const admin = fakeAdmin({ user: USER, profile: ACTIVE_MEMBER });
      const r = await requireCronOrMember(req({ authorization: 'Bearer good' }), CORS, admin, { adminOnly: true });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.response.status, 403);
      assert.deepStrictEqual(await bodyOf(r.response), { error: 'admins only' });
    });

    await test('adminOnly accepts org_admin and super_admin', async () => {
      for (const role of ['org_admin', 'super_admin']) {
        const admin = fakeAdmin({ user: USER, profile: { ...ACTIVE_MEMBER, role } });
        const r = await requireCronOrMember(req({ authorization: 'Bearer good' }), CORS, admin, { adminOnly: true });
        assert.strictEqual(r.ok, true, role + ' was rejected');
        assert.strictEqual(r.role, role);
      }
    });

    await test('adminOnly rejects roles that merely look administrative', async () => {
      for (const role of ['admin', 'Org_Admin', 'owner', 'manager', null, undefined]) {
        const admin = fakeAdmin({ user: USER, profile: { ...ACTIVE_MEMBER, role } });
        const r = await requireCronOrMember(req({ authorization: 'Bearer good' }), CORS, admin, { adminOnly: true });
        assert.strictEqual(r.ok, false, 'allowed with role ' + JSON.stringify(role));
      }
    });

    await test('without adminOnly, a plain member is allowed — the "Test run" button', async () => {
      const admin = fakeAdmin({ user: USER, profile: ACTIVE_MEMBER });
      const r = await requireCronOrMember(req({ authorization: 'Bearer good' }), CORS, admin);
      assert.strictEqual(r.ok, true);
    });

    // ── The failed read must DENY ────────────────────────────────────────────
    await test('a profiles read that RESOLVES { data: null, error } denies with 503', async () => {
      // postgrest-js resolves on failure. An unchecked read leaves `profile`
      // null and lands in the `!profile` branch — right by luck, not design.
      // Checking it explicitly means a later edit to that branch cannot turn a
      // failed read into an allow, and 503 says "we could not verify" rather
      // than "you are not a member", so the caller knows to retry.
      const admin = fakeAdmin({ user: USER, profileErr: { message: 'permission denied for table profiles' } });
      const { value: r } = await quietErrors(() =>
        requireCronOrMember(req({ authorization: 'Bearer good' }), CORS, admin));
      assert.strictEqual(r.ok, false, 'a failed membership read must never allow');
      assert.strictEqual(r.response.status, 503);
      assert.deepStrictEqual(await bodyOf(r.response), { error: 'could not verify membership' });
      assert.strictEqual(r.orgId, undefined, 'no org may leak out of a failed read');
    });

    await test('a profiles read error with an EMPTY message still denies', async () => {
      // A truthiness test on `error.message` instead of on `error` would send
      // this down the success path.
      const admin = fakeAdmin({ user: USER, profileErr: { message: '' } });
      const { value: r } = await quietErrors(() =>
        requireCronOrMember(req({ authorization: 'Bearer good' }), CORS, admin));
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.response.status, 503);
    });

    await test('the failed read is logged as well as denied', async () => {
      const admin = fakeAdmin({ user: USER, profileErr: { message: 'connection reset' } });
      const { logged } = await quietErrors(() =>
        requireCronOrMember(req({ authorization: 'Bearer good' }), CORS, admin));
      assert.ok(logged.some((l) => /requireCronOrMember/.test(l) && /connection reset/.test(l)),
        'expected a diagnostic line, got: ' + JSON.stringify(logged));
    });

    await test('every denial is a real Response carrying the CORS headers', async () => {
      // These functions return r.response straight to the browser. A denial
      // without CORS shows up in the CRM as an opaque network error rather than
      // the 401/403 the UI knows how to explain.
      const cases = [
        [fakeAdmin(), {}, 401],
        [fakeAdmin({ userError: { message: 'x' } }), { authorization: 'Bearer x' }, 401],
        [fakeAdmin({ user: USER, profile: { ...ACTIVE_MEMBER, status: 'invited' } }), { authorization: 'Bearer x' }, 403],
        [fakeAdmin({ user: USER, profileErr: { message: 'x' } }), { authorization: 'Bearer x' }, 503],
      ];
      for (const [admin, headers, status] of cases) {
        const { value: r } = await quietErrors(() => requireCronOrMember(req(headers), CORS, admin));
        assert.ok(r.response instanceof Response, 'not a Response for ' + status);
        assert.strictEqual(r.response.status, status);
        assert.strictEqual(r.response.headers.get('access-control-allow-origin'), '*',
          'missing CORS on the ' + status);
      }
    });
  }

  // ══ requireCronOrMember with CRON_SECRET UNSET ═════════════════════════════
  {
    // Fresh module scope, fresh Deno stub: the secret is a module-level const.
    const { requireCronOrMember } = loadWith(undefined);

    await test('UNSET secret: the cron header alone authorises NOTHING here either', async () => {
      // `provided && CRON_SECRET && safeEqual(...)` — the CRON_SECRET term is
      // what makes this fail closed. Without it, '' === '' would authorise any
      // request that sent an empty header on an unconfigured deployment.
      const admin = fakeAdmin();
      const r = await requireCronOrMember(req({ 'x-cron-secret': SECRET }), CORS, admin);
      assert.strictEqual(r.ok, false, 'with no secret configured, the header must prove nothing');
      assert.strictEqual(r.response.status, 401);
      assert.deepStrictEqual(await bodyOf(r.response), { error: 'unauthorized' });
    });

    await test('UNSET secret: an empty cron header does not match the empty secret', async () => {
      const r = await requireCronOrMember(req({ 'x-cron-secret': '' }), CORS, fakeAdmin());
      assert.strictEqual(r.ok, false);
    });

    await test('UNSET secret: a genuine member is still served', async () => {
      // The CRM's buttons must keep working on a deployment that has not set
      // the secret yet — the JWT path is independent of it.
      const admin = fakeAdmin({ user: USER, profile: ACTIVE_MEMBER });
      const r = await requireCronOrMember(req({ authorization: 'Bearer good' }), CORS, admin);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.orgId, 'org-real');
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
