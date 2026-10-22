// Plan gate for automations: only the oldest N enabled rules run, N = the
// CURRENT plan's max_automations (plan_of). Before this, an org that expired
// or downgraded kept running every rule it had enabled while paying.
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
const tr = (f) => es.transformSync(fs.readFileSync(path.join(__dirname, f), 'utf8'), { loader: 'ts', format: 'cjs' }).code;

const autoMod = { exports: {} };
new Function('module', 'exports', tr('automations.ts'))(autoMod, autoMod.exports);
const { entitledRuleIds } = autoMod.exports;

const telegram = [];
const raMod = { exports: {} };
new Function('module', 'exports', 'require', tr('run-actions.ts'))(raMod, raMod.exports, (spec) => {
  if (spec.includes('automations')) return autoMod.exports;
  if (spec.includes('notify')) return { notifyNewLead: async (_d, _o, p) => { telegram.push(p); return { sent: true }; } };
  throw new Error('unexpected import: ' + spec);
});
const { loadEntitlement, filterEntitled, fireEventAutomations } = raMod.exports;

// Fake postgrest: automations select (event path + entitlement list),
// automation_runs select/insert, plan_of rpc.
function fakeDb({ plan, planErr, rules }) {
  const calls = [];
  const q = (table) => {
    const st = { table, filters: {}, limit: null };
    const self = {
      select() { return self; }, eq(k, v) { st.filters[k] = v; return self; }, gte() { return self; },
      order() { return self; }, limit(n) { st.limit = n; return self; },
      insert(p) { calls.push(['insert', table, p]); return Promise.resolve({ error: null }); },
      update() { return self; },
      then(res) {
        calls.push(['select', table, { ...st.filters }, st.limit]);
        if (table === 'automations') {
          let rows = rules.filter((r) => r.enabled && (!st.filters.trigger || r.trigger === st.filters.trigger));
          rows = rows.slice().sort((a, b) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.id < b.id ? -1 : 1));
          if (st.limit != null) rows = rows.slice(0, st.limit);
          return Promise.resolve(res({ data: rows, error: null }));
        }
        return Promise.resolve(res({ data: [], error: null }));
      },
    };
    return self;
  };
  return {
    calls,
    from: q,
    async rpc(name) {
      calls.push(['rpc', name]);
      if (name === 'plan_of') return planErr ? { data: null, error: { message: planErr } } : { data: plan, error: null };
      return { data: [], error: null };
    },
  };
}

const rule = (id, created_at, extra = {}) => ({
  id, org_id: 'o1', name: id, enabled: true, trigger: 'lead_created', trigger_value: null,
  conditions: [], actions: [{ action: 'add_note', value: 'x' }], cooldown_hours: 0, created_at, ...extra,
});
const RULES = [rule('c', '2026-03-01T00:00:00Z'), rule('a', '2026-01-01T00:00:00Z'), rule('b', '2026-02-01T00:00:00Z')];
const LEAD = { id: 'l1', name: 'L', stage_key: 'new' };

let p = 0, f = 0;
const t = async (n, fn) => { try { await fn(); console.log('  ✓', n); p++; } catch (e) { console.log('  ✗', n, '—', e.message); f++; } };
const quiet = async (fn) => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; } };

(async () => {
  console.log('automation plan gate');

  await t('entitledRuleIds: null limit = all rules', () => {
    assert.deepStrictEqual([...entitledRuleIds(RULES, null)].sort(), ['a', 'b', 'c']);
  });
  await t('entitledRuleIds: oldest N by created_at', () => {
    assert.deepStrictEqual([...entitledRuleIds(RULES, 2)].sort(), ['a', 'b']);
  });
  await t('entitledRuleIds: 0 and negative = none', () => {
    assert.strictEqual(entitledRuleIds(RULES, 0).size, 0);
    assert.strictEqual(entitledRuleIds(RULES, -1).size, 0);
  });
  await t('entitledRuleIds: ties broken by id, stable', () => {
    const same = [rule('z', '2026-01-01T00:00:00Z'), rule('y', '2026-01-01T00:00:00Z')];
    assert.deepStrictEqual([...entitledRuleIds(same, 1)], ['y']);
  });

  await t('loadEntitlement: unlimited plan returns ids=null', async () => {
    const e = await loadEntitlement(fakeDb({ plan: { plan: 'enterprise', max_automations: null }, rules: RULES }), 'o1');
    assert.strictEqual(e.ok, true); assert.strictEqual(e.ids, null);
  });
  await t('loadEntitlement: expired plan (0) allows nothing', async () => {
    const e = await loadEntitlement(fakeDb({ plan: { plan: 'expired', max_automations: 0 }, rules: RULES }), 'o1');
    assert.strictEqual(e.ok, true); assert.strictEqual(e.ids.size, 0);
    assert.deepStrictEqual(filterEntitled(RULES, e), []);
  });
  await t('loadEntitlement: rpc error fails closed', async () => {
    const e = await loadEntitlement(fakeDb({ planErr: 'boom', rules: RULES }), 'o1');
    assert.strictEqual(e.ok, false);
    assert.deepStrictEqual(filterEntitled(RULES, e), []);
  });
  await t('loadEntitlement: one-element array result is accepted', async () => {
    const e = await loadEntitlement(fakeDb({ plan: [{ max_automations: 2 }], rules: RULES }), 'o1');
    assert.deepStrictEqual([...e.ids].sort(), ['a', 'b']);
  });
  await t('loadEntitlement: cached per org — plan_of asked once', async () => {
    const db = fakeDb({ plan: { max_automations: 2 }, rules: RULES });
    const cache = new Map();
    await loadEntitlement(db, 'o1', cache); await loadEntitlement(db, 'o1', cache);
    assert.strictEqual(db.calls.filter((c) => c[0] === 'rpc' && c[1] === 'plan_of').length, 1);
  });

  await t('fireEventAutomations: starter-like limit runs only the oldest rules', async () => {
    const db = fakeDb({ plan: { max_automations: 2 }, rules: RULES });
    const r = await quiet(() => fireEventAutomations(db, 'o1', LEAD, 'lead_created', new Date('2026-10-14T00:00:00Z')));
    assert.strictEqual(r.fired, 2);
    const ran = db.calls.filter((c) => c[0] === 'insert' && c[1] === 'automation_runs').map((c) => c[2].automation_id).sort();
    assert.deepStrictEqual(ran, ['a', 'b']);
  });
  await t('fireEventAutomations: expired org fires nothing', async () => {
    const db = fakeDb({ plan: { max_automations: 0 }, rules: RULES });
    const r = await quiet(() => fireEventAutomations(db, 'o1', LEAD, 'lead_created'));
    assert.strictEqual(r.fired, 0);
    assert.ok(!db.calls.some((c) => c[0] === 'insert'), 'nothing may be written');
  });
  await t('fireEventAutomations: unreadable plan fires nothing', async () => {
    const db = fakeDb({ planErr: 'down', rules: RULES });
    const r = await quiet(() => fireEventAutomations(db, 'o1', LEAD, 'lead_created'));
    assert.strictEqual(r.fired, 0);
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})();
