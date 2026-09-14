// Tests for the automation action executor.
//
// What these guard is the thing that went wrong twice: postgrest-js does NOT
// throw on a failed statement — it resolves with `{ data: null, error }`. Code
// written as `await supabase.from(...).update(...)` therefore looks correct,
// passes review, and silently records success for writes the database refused.
// Every assertion checking `ok === false` exists to stop that returning.
//
// The fake client mimics postgrest-js's shape: a thenable builder that RESOLVES
// with an error object rather than rejecting. It also CAPTURES every payload,
// because an earlier version of this file asserted only that "some write
// happened" — which an implementation writing the wrong value would have passed.

const path = require('path');

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

// ── Load run-actions.ts with its two dependencies stubbed ────────────────────
let telegramResult = { sent: true };
const telegramCalls = [];

const src = fs.readFileSync(path.join(__dirname, 'run-actions.ts'), 'utf8');
const js = es.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
const stubRequire = (spec) => {
  if (spec.includes('automations')) {
    return { conditionsPass: () => true, triggerFires: () => true, inCooldown: () => false };
  }
  if (spec.includes('notify')) {
    return {
      notifyNewLead: async (_db, _org, payload) => { telegramCalls.push(payload); return telegramResult; },
    };
  }
  throw new Error('unexpected import: ' + spec);
};
const m = { exports: {} };
new Function('module', 'exports', 'require', js)(m, m.exports, stubRequire);
const { executeActions } = m.exports;

// ── A fake postgrest client that records what it was asked to write ──────────
function fakeDb(failOn = {}, rpcData = {}) {
  const writes = [];   // { table, op, payload }
  const calls = [];
  const builder = (table, op, payload) => {
    const key = `${table}.${op}`;
    calls.push(key);                    // recorded at CALL time, not await time
    writes.push({ table, op, payload });
    const self = {
      eq() { return self; },
      then(resolve) {
        // `key in failOn`, not truthiness: the empty-message case is exactly
        // what one of these tests is for, and `failOn[key] ? …` would have
        // quietly turned it back into a success.
        const error = (key in failOn) ? { message: failOn[key] } : null;
        return Promise.resolve(resolve({ data: null, error }));
      },
    };
    return self;
  };
  return {
    calls, writes,
    lastWrite(table, op) {
      for (let i = writes.length - 1; i >= 0; i--) {
        if (writes[i].table === table && writes[i].op === op) return writes[i].payload;
      }
      return undefined;
    },
    from(table) {
      return {
        update: (p) => builder(table, 'update', p),
        insert: (p) => builder(table, 'insert', p),
      };
    },
    async rpc(name) {
      calls.push(`rpc:${name}`);
      if (`rpc:${name}` in failOn) return { data: null, error: { message: failOn[`rpc:${name}`] } };
      return { data: rpcData[name] ?? [], error: null };
    },
  };
}

const LEAD = { id: 'lead-1', name: 'Asha', email: 'a@b.com', phone: '+91', tags: ['vip'], score: 10 };
const rule = (...actions) => ({ id: 'a1', name: 'Rule', actions, cooldown_hours: 0 });
const NOW = new Date('2026-09-14T10:00:00.000Z');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); failed++; }
}

(async () => {
  console.log('run-actions');

  await test('a successful rule reports ok and lists every step', async () => {
    const r = await executeActions(fakeDb(), 'org-1', LEAD, rule(
      { action: 'set_score', value: 50 },
      { action: 'add_note', value: 'hello' },
    ), NOW);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.detail, null);
    assert.strictEqual(r.taken.length, 2);
  });

  // ── What is actually written ───────────────────────────────────────────────
  await test('set_stage writes the stage the rule asked for', async () => {
    const db = fakeDb();
    await executeActions(db, 'org-1', LEAD, rule({ action: 'set_stage', value: 'qualified' }), NOW);
    assert.strictEqual(db.lastWrite('leads', 'update').stage_key, 'qualified');
  });

  await test('set_score writes the number, and coerces junk to 0', async () => {
    const db = fakeDb();
    await executeActions(db, 'org-1', LEAD, rule({ action: 'set_score', value: '75' }), NOW);
    assert.strictEqual(db.lastWrite('leads', 'update').score, 75);
    const db2 = fakeDb();
    await executeActions(db2, 'org-1', LEAD, rule({ action: 'set_score', value: 'abc' }), NOW);
    assert.strictEqual(db2.lastWrite('leads', 'update').score, 0);
  });

  await test('set_follow_up schedules the right number of hours ahead', async () => {
    const db = fakeDb();
    await executeActions(db, 'org-1', LEAD, rule({ action: 'set_follow_up', value: 48 }), NOW);
    assert.strictEqual(db.lastWrite('leads', 'update').next_follow_up_at, '2026-09-16T10:00:00.000Z');
  });

  await test('set_follow_up defaults to 24 hours when the value is unusable', async () => {
    const db = fakeDb();
    await executeActions(db, 'org-1', LEAD, rule({ action: 'set_follow_up', value: null }), NOW);
    assert.strictEqual(db.lastWrite('leads', 'update').next_follow_up_at, '2026-09-15T10:00:00.000Z');
  });

  await test('add_tag appends without dropping the existing tags', async () => {
    const db = fakeDb();
    await executeActions(db, 'org-1', LEAD, rule({ action: 'add_tag', value: 'hot' }), NOW);
    assert.deepStrictEqual(db.lastWrite('leads', 'update').tags, ['vip', 'hot']);
  });

  await test('add_note writes the note text', async () => {
    const db = fakeDb();
    await executeActions(db, 'org-1', LEAD, rule({ action: 'add_note', value: 'called, no answer' }), NOW);
    assert.strictEqual(db.lastWrite('activities', 'insert').content, 'called, no answer');
  });

  await test('assign_to writes the id the rule named', async () => {
    const db = fakeDb();
    await executeActions(db, 'org-1', LEAD, rule({ action: 'assign_to', value: 'user-7' }), NOW);
    assert.strictEqual(db.lastWrite('leads', 'update').assigned_to, 'user-7');
  });

  // ── Errors are not swallowed ───────────────────────────────────────────────
  await test('a REJECTED write is reported, not swallowed', async () => {
    const db = fakeDb({ 'leads.update': 'new row violates check constraint' });
    const r = await executeActions(db, 'org-1', LEAD, rule({ action: 'set_score', value: 50 }), NOW);
    assert.strictEqual(r.ok, false, 'postgrest resolves with {error}; it must still fail the run');
    assert.match(r.detail, /check constraint/);
    assert.strictEqual(r.taken.length, 0, 'a refused write must not be listed as taken');
  });

  await test('assign_to surfaces the cross-org assignee guard', async () => {
    const db = fakeDb({ 'leads.update': 'Cannot assign this record to that user: they are not an active member of this organisation.' });
    const r = await executeActions(db, 'org-1', LEAD, rule({ action: 'assign_to', value: 'someone-elses-user' }), NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /not an active member/);
  });

  await test('an error with an EMPTY message still fails the run', async () => {
    // `??` would let '' through as "no failure". This is why the code uses `||`.
    const db = fakeDb({ 'leads.update': '' });
    const r = await executeActions(db, 'org-1', LEAD, rule({ action: 'set_score', value: 1 }), NOW);
    assert.strictEqual(r.ok, false);
    assert.ok(r.detail && r.detail.length > 0, 'an empty message must still produce a detail');
  });

  await test('a throw with no message still fails the run', async () => {
    const db = fakeDb();
    db.rpc = async () => { throw new Error(''); };
    const r = await executeActions(db, 'org-1', LEAD, rule({ action: 'assign_round_robin' }), NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /threw/);
  });

  // ── Fatal vs non-fatal ─────────────────────────────────────────────────────
  await test('a fatal failure ABORTS the remaining steps', async () => {
    const db = fakeDb({ 'leads.update': 'boom' });
    telegramCalls.length = 0;
    const r = await executeActions(db, 'org-1', LEAD, rule(
      { action: 'set_stage', value: 'qualified' },
      { action: 'notify_telegram' },
    ), NOW);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(telegramCalls.length, 0, 'must not announce a stage move that was refused');
  });

  await test('an unimplemented action does NOT abort the rest of the rule', async () => {
    // A customer whose rule is [send_email_template, set_stage] has been
    // getting the stage move for months. Shipping abort semantics must not
    // silently stop that.
    const db = fakeDb();
    const r = await executeActions(db, 'org-1', LEAD, rule(
      { action: 'send_email_template', value: 't1' },
      { action: 'set_stage', value: 'qualified' },
    ), NOW);
    assert.strictEqual(r.ok, false, 'still reported as a failure');
    assert.match(r.detail, /not wired/);
    assert.strictEqual(db.lastWrite('leads', 'update').stage_key, 'qualified',
      'the later step must still have run');
  });

  await test('an unknown action is refused, not recorded as done, and not fatal', async () => {
    const db = fakeDb();
    const r = await executeActions(db, 'org-1', LEAD, rule(
      { action: 'send_carrier_pigeon' },
      { action: 'set_score', value: 9 },
    ), NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /unknown action/);
    assert.strictEqual(r.taken.length, 1, 'only the step that really ran');
    assert.strictEqual(db.lastWrite('leads', 'update').score, 9);
  });

  await test('a failed timeline entry does NOT abort the rule', async () => {
    const db = fakeDb({ 'activities.insert': 'timeline write failed' });
    const r = await executeActions(db, 'org-1', LEAD, rule({ action: 'set_stage', value: 'qualified' }), NOW);
    assert.strictEqual(r.ok, true, 'the stage did move; a missing timeline row is not worth failing over');
  });

  // ── Round-robin ────────────────────────────────────────────────────────────
  await test('round-robin fails loudly when the RPC errors', async () => {
    const db = fakeDb({ 'rpc:org_assignment_load': 'function does not exist' });
    const r = await executeActions(db, 'org-1', LEAD, rule({ action: 'assign_round_robin' }), NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /assignment load/);
  });

  await test('round-robin assigns to the LIGHTEST-loaded member, by id', async () => {
    const db = fakeDb({}, { org_assignment_load: [
      { user_id: 'u-idle', open_leads: 2 }, { user_id: 'u-busy', open_leads: 40 },
    ] });
    const r = await executeActions(db, 'org-1', LEAD, rule({ action: 'assign_round_robin' }), NOW);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(db.lastWrite('leads', 'update').assigned_to, 'u-idle',
      'must pick the first (lightest) row, not the last');
  });

  await test('round-robin with nobody to assign to is a failure, not a silent no-op', async () => {
    const db = fakeDb({}, { org_assignment_load: [] });
    const r = await executeActions(db, 'org-1', LEAD, rule({ action: 'assign_round_robin' }), NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /no active member/);
  });

  await test('a shared context fetches the load ONCE and still rotates between leads', async () => {
    // The quadratic-cost fix. Three leads, two members starting level: the
    // assignments must alternate, and the RPC must be called exactly once.
    const db = fakeDb({}, { org_assignment_load: [
      { user_id: 'u-a', open_leads: 0 }, { user_id: 'u-b', open_leads: 0 },
    ] });
    const ctx = {};
    const picks = [];
    for (const id of ['l1', 'l2', 'l3']) {
      await executeActions(db, 'org-1', { ...LEAD, id }, rule({ action: 'assign_round_robin' }), NOW, ctx);
      picks.push(db.lastWrite('leads', 'update').assigned_to);
    }
    const rpcCalls = db.calls.filter((c) => c === 'rpc:org_assignment_load').length;
    assert.strictEqual(rpcCalls, 1, `expected 1 aggregation for 3 leads, got ${rpcCalls}`);
    assert.deepStrictEqual(picks, ['u-a', 'u-b', 'u-a'],
      'each pick must update the local counts so the next lead goes elsewhere');
  });

  // ── Telegram ───────────────────────────────────────────────────────────────
  await test('telegram not being configured is not a failure', async () => {
    telegramResult = { sent: false, reason: 'not_configured' };
    const r = await executeActions(fakeDb(), 'org-1', LEAD, rule({ action: 'notify_telegram' }), NOW);
    assert.strictEqual(r.ok, true, 'an org that never set up alerts has not failed');
    telegramResult = { sent: true };
  });

  await test('a real telegram send failure IS a failure', async () => {
    telegramResult = { sent: false, reason: 'error', detail: 'HTTP 401' };
    const r = await executeActions(fakeDb(), 'org-1', LEAD, rule({ action: 'notify_telegram' }), NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /401/);
    telegramResult = { sent: true };
  });

  await test('a telegram failure whose detail was scrubbed to empty still fails', async () => {
    // notify.ts strips the bot token out of error text and can return ''.
    telegramResult = { sent: false, reason: 'error', detail: '' };
    const r = await executeActions(fakeDb(), 'org-1', LEAD, rule({ action: 'notify_telegram' }), NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /telegram/i);
    telegramResult = { sent: true };
  });

  await test('add_tag does not rewrite tags when the tag is already present', async () => {
    const db = fakeDb();
    const r = await executeActions(db, 'org-1', LEAD, rule({ action: 'add_tag', value: 'vip' }), NOW);
    assert.strictEqual(r.ok, true);
    assert.ok(!db.calls.includes('leads.update'), 'no write when nothing changes');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
