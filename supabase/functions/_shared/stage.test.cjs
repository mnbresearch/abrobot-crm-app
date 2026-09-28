// Tests for firstStageKey() — which stage a brand-new record lands in.
//
// The incident this module was written for, from its own header: lead-webhook
// and chat-agent inserted without setting stage_key, so the column default gave
// every new record 'new'. Only 2 of the 13 industry packs actually HAVE a stage
// keyed 'new' (study_abroad and general); the other eleven start at 'enquiry',
// or 'sourced' for recruitment. Pipeline.tsx builds its columns from
// pipeline_stages and drops any lead whose stage_key has no matching column, so
// for a hospital, a clinic, a law firm, a gym, every lead captured by the
// website widget or an inbound webhook was invisible on the board the customer
// works out of. The record existed, it was counted, it was billed; it just could
// not be seen where anyone would look for it.
//
// So the assertion that matters is not "returns a string" — it is "returns the
// FIRST stage of THIS org's pipeline, by position". The fake below therefore
// honours .eq()/.order()/.limit() itself and is fed rows in deliberately wrong
// order, so a query that forgot to sort, sorted descending, or leaked another
// tenant's stages fails here instead of passing on a coincidence.
//
// The fake also RESOLVES with { data: null, error } rather than throwing, which
// is what postgrest-js does. Code written as `await supabase.from(...)` looks
// correct and passes review while ignoring the error entirely; the error-path
// test below exists because of that.

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

// transformSync, not buildSync: stage.ts imports nothing.
const src = fs.readFileSync(path.join(__dirname, 'stage.ts'), 'utf8');
const js = es.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
const stubRequire = (spec) => { throw new Error('unexpected import: ' + spec); };
const m = { exports: {} };
new Function('module', 'exports', 'require', js)(m, m.exports, stubRequire);
const { firstStageKey } = m.exports;

if (typeof firstStageKey !== 'function') {
  console.log('FAILED - stage.ts does not export firstStageKey');
  process.exit(1);
}

// ── A fake postgrest client that records the query and applies it ─────────────
//
// It captures table, columns, filters, ordering and limit so a WRONG query
// fails, not just a missing one. `maybeSingle()` resolves — never rejects —
// with { data, error }, the shape postgrest-js really returns.
function fakeDb(rows, failure = null) {
  const q = { table: null, columns: null, filters: {}, order: null, limit: null, reads: 0 };
  const self = {
    select(c) { q.columns = c; return self; },
    eq(col, val) { q.filters[col] = val; return self; },
    order(col, opts) { q.order = { col, ascending: !opts || opts.ascending !== false }; return self; },
    limit(n) { q.limit = n; return self; },
    maybeSingle() {
      q.reads++;
      if (failure) return Promise.resolve({ data: null, error: failure });
      let out = rows.filter((r) =>
        Object.entries(q.filters).every(([k, v]) => r[k] === v));
      if (q.order) {
        const dir = q.order.ascending ? 1 : -1;
        out = out.slice().sort((a, b) => (a[q.order.col] - b[q.order.col]) * dir);
      }
      if (q.limit != null) out = out.slice(0, q.limit);
      // .select("key") — only the selected column comes back.
      return Promise.resolve({ data: out[0] ? { key: out[0].key } : null, error: null });
    },
  };
  return { query: q, from(table) { q.table = table; return self; } };
}

// Deliberately NOT in position order, and deliberately including a second
// tenant whose first stage sorts ahead of ours.
const CLINIC_STAGES = [
  { org_id: 'org-clinic', key: 'consulted', position: 2 },
  { org_id: 'org-clinic', key: 'enquiry', position: 1 },
  { org_id: 'org-clinic', key: 'treated', position: 3 },
  { org_id: 'org-other', key: 'someone-elses-first-stage', position: 0 },
];

// Capture console.error without losing it: the log line is the only signal the
// error path emits, so a test that cannot see it cannot assert it.
function captureErrors(fn) {
  const logged = [];
  const real = console.error;
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ value, logged }))
    .finally(() => { console.error = real; });
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); failed++; }
}

(async () => {
  console.log('stage');

  // ── The configured case: the incident, inverted ────────────────────────────
  await test('a configured org gets pipeline_stages[0].key ordered by position', () => {
    const db = fakeDb(CLINIC_STAGES);
    return firstStageKey(db, 'org-clinic').then((key) => {
      assert.strictEqual(key, 'enquiry',
        'must be the lowest position, not the first row the table happened to return');
    });
  });

  await test('the query asks the right table, column, ordering and limit', () => {
    // Asserted explicitly because each one of these is a way to get 'enquiry'
    // here by luck on this fixture and the wrong stage in production.
    const db = fakeDb(CLINIC_STAGES);
    return firstStageKey(db, 'org-clinic').then(() => {
      assert.strictEqual(db.query.table, 'pipeline_stages');
      assert.strictEqual(db.query.columns, 'key');
      assert.deepStrictEqual(db.query.order, { col: 'position', ascending: true },
        'descending ordering would return the LAST stage — a lead created as "won"');
      assert.strictEqual(db.query.limit, 1);
      assert.strictEqual(db.query.reads, 1, 'one read per lead, not more');
    });
  });

  await test('stages are scoped to the org, so another tenant cannot set our first stage', () => {
    // org-other's stage sits at position 0, ahead of everything of ours. If the
    // org_id filter were dropped this returns 'someone-elses-first-stage' and
    // every new lead in the CRM lands in a column that does not exist.
    const db = fakeDb(CLINIC_STAGES);
    return firstStageKey(db, 'org-clinic').then((key) => {
      assert.strictEqual(db.query.filters.org_id, 'org-clinic');
      assert.notStrictEqual(key, 'someone-elses-first-stage');
    });
  });

  await test('a recruitment pack starts at "sourced", not "new"', () => {
    // One of the eleven packs that has no 'new' stage at all. This is the
    // customer-visible bug in its most literal form.
    const db = fakeDb([
      { org_id: 'org-rec', key: 'screening', position: 2 },
      { org_id: 'org-rec', key: 'sourced', position: 1 },
    ]);
    return firstStageKey(db, 'org-rec').then((key) => assert.strictEqual(key, 'sourced'));
  });

  await test('study_abroad and general, which do key their first stage "new", still get "new"', () => {
    const db = fakeDb([{ org_id: 'org-sa', key: 'new', position: 1 }]);
    return firstStageKey(db, 'org-sa').then((key) => assert.strictEqual(key, 'new'));
  });

  // ── The fallback ───────────────────────────────────────────────────────────
  await test('an org with no stages configured falls back to "new"', () => {
    // Org created but never onboarded: data is null with no error.
    const db = fakeDb([]);
    return firstStageKey(db, 'org-empty').then((key) => assert.strictEqual(key, 'new'));
  });

  // ── The RESOLVED error: returns the fallback, and only logs ────────────────
  await test('a resolved { data: null, error } returns the "new" fallback rather than throwing', () => {
    // postgrest-js resolves on failure. Falling back rather than throwing is
    // the deliberate choice recorded in stage.ts: a record in the wrong column
    // beats losing the lead.
    const db = fakeDb([], { message: 'permission denied for table pipeline_stages' });
    return captureErrors(() => firstStageKey(db, 'org-clinic')).then(({ value }) => {
      assert.strictEqual(value, 'new');
    });
  });

  await test('the error IS surfaced — via console.error, naming the org and the cause', () => {
    // This is the only place the failure is reported, so assert its content:
    // without the org id the line is not actionable in a multi-tenant log, and
    // without the message nobody can tell an RLS denial from a missing table.
    const db = fakeDb([], { message: 'permission denied for table pipeline_stages' });
    return captureErrors(() => firstStageKey(db, 'org-clinic')).then(({ logged }) => {
      assert.strictEqual(logged.length, 1, 'expected exactly one error line, got ' + logged.length);
      assert.match(logged[0], /firstStageKey/);
      assert.match(logged[0], /org-clinic/, 'the log line must name the org');
      assert.match(logged[0], /permission denied/, 'the log line must carry the postgrest message');
    });
  });

  await test('the CALLER cannot tell a failed lookup from a legitimate "new" pack', () => {
    // Deliberately asserting the limitation, because it is the one thing about
    // this function that could surprise someone reading a caller.
    //
    // firstStageKey returns a bare string. A failed lookup and a study_abroad
    // org whose first stage really is 'new' produce byte-identical results, so
    // lead-webhook and chat-agent cannot log, retry, alert or degrade
    // differently — the console.error above is the entire signal, and it is
    // visible only to whoever reads the function logs. If a caller ever needs
    // to act on the difference, firstStageKey has to return { key, error } (or
    // throw and let the caller decide); it cannot be recovered at the call site
    // as it stands.
    const failed = fakeDb([], { message: 'permission denied for table pipeline_stages' });
    const legit = fakeDb([{ org_id: 'org-sa', key: 'new', position: 1 }]);
    return captureErrors(() => firstStageKey(failed, 'org-clinic')).then(({ value: a }) =>
      firstStageKey(legit, 'org-sa').then((b) => {
        assert.strictEqual(a, b, 'documented: indistinguishable at the call site');
        assert.strictEqual(typeof a, 'string', 'no error channel in the return value');
      }));
  });

  await test('an error with an EMPTY message still logs and still falls back', () => {
    // `error.message` can be ''. A truthiness test on the message rather than
    // on `error` would send this down the success path and read `data?.key` off
    // a null row — returning 'new' by accident, with nothing logged at all.
    const db = fakeDb([], { message: '' });
    return captureErrors(() => firstStageKey(db, 'org-clinic')).then(({ value, logged }) => {
      assert.strictEqual(value, 'new');
      assert.strictEqual(logged.length, 1, 'an empty message must still produce a log line');
    });
  });

  await test('the error path never rejects', () => {
    // The two callers are unauthenticated intake paths. An exception there
    // loses the lead outright, which is strictly worse than the wrong column.
    const db = fakeDb([], { message: 'boom' });
    return captureErrors(() => firstStageKey(db, 'org-clinic').then(
      (v) => v,
      (e) => { throw new Error('firstStageKey rejected instead of falling back: ' + e.message); },
    )).then(({ value }) => assert.strictEqual(value, 'new'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
