// Tests for the pure amount/currency reconciliation shared by billing-webhook
// and checkout-recovery's lost-webhook reconciler, and for fetchOrder failing
// closed when CASHFREE_ENV is unset (it used to query the SANDBOX about
// production orders).
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
const js = es.transformSync(fs.readFileSync(path.join(__dirname, 'cashfree.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;

let env = {};
let fetchCalls = [];
function load() {
  const Deno = { env: { get: (k) => env[k] } };
  const stubRequire = (spec) => {
    if (spec.includes('http')) return { fetchWithTimeout: async (url) => {
      fetchCalls.push(url);
      return { ok: true, json: async () => ({ order_status: 'PAID', order_amount: 999 }) };
    } };
    throw new Error('unexpected import: ' + spec);
  };
  const m = { exports: {} };
  new Function('module', 'exports', 'Deno', 'require', js)(m, m.exports, Deno, stubRequire);
  return m.exports;
}

let p = 0, f = 0;
const t = async (n, fn) => { try { await fn(); console.log('  ✓', n); p++; } catch (e) { console.log('  ✗', n, '—', e.message); f++; } };

(async () => {
  console.log('cashfree reconcile / fetchOrder');
  const { reconcile, toAmount } = load();
  const row = { amount: '49990.00', currency: 'INR' };

  await t('exact amount reconciles', () => {
    const r = reconcile({ order_amount: 49990, order_currency: 'INR' }, null, row);
    assert.deepStrictEqual(r, { ok: true, absent: false });
  });
  await t('underpaid is refused', () => {
    const r = reconcile({ order_amount: 4999, order_currency: 'INR' }, null, row);
    assert.strictEqual(r.ok, false); assert.match(r.reason, /underpaid/);
  });
  await t('payment_amount lower than order_amount is what counts', () => {
    const r = reconcile({ order_amount: 49990 }, { payment_amount: 4999 }, row);
    assert.strictEqual(r.ok, false);
  });
  await t('currency mismatch is refused', () => {
    const r = reconcile({ order_amount: 49990, order_currency: 'USD' }, null, row);
    assert.strictEqual(r.ok, false); assert.match(r.reason, /currency/);
  });
  await t('one paisa of float noise is tolerated', () => {
    assert.strictEqual(reconcile({ order_amount: 49989.995, order_currency: 'INR' }, null, row).ok, true);
  });
  await t('no amount in payload is reported as absent, not ok-and-present', () => {
    assert.deepStrictEqual(reconcile({}, null, row), { ok: true, absent: true });
  });
  await t('toAmount handles strings and blanks', () => {
    assert.strictEqual(toAmount('49990.00'), 49990);
    assert.strictEqual(toAmount(''), null);
    assert.strictEqual(toAmount('x'), null);
  });

  await t('fetchOrder with CASHFREE_ENV unset makes NO request and returns null', async () => {
    env = { CASHFREE_APP_ID: 'a', CASHFREE_SECRET_KEY: 's' }; fetchCalls = [];
    const err = console.error; console.error = () => {};
    try {
      const r = await load().fetchOrder('abcrm_x_1');
      assert.strictEqual(r, null);
      assert.strictEqual(fetchCalls.length, 0, 'must not fall back to sandbox: ' + fetchCalls.join(','));
    } finally { console.error = err; }
  });
  await t('fetchOrder in production asks the production host', async () => {
    env = { CASHFREE_APP_ID: 'a', CASHFREE_SECRET_KEY: 's', CASHFREE_ENV: 'production' }; fetchCalls = [];
    const r = await load().fetchOrder('abcrm_x_1');
    assert.strictEqual(r.order_status, 'PAID');
    assert.ok(fetchCalls[0].startsWith('https://api.cashfree.com/pg/orders/'), fetchCalls[0]);
  });
  await t('fetchOrder in sandbox asks the sandbox host', async () => {
    env = { CASHFREE_APP_ID: 'a', CASHFREE_SECRET_KEY: 's', CASHFREE_ENV: 'sandbox' }; fetchCalls = [];
    await load().fetchOrder('o');
    assert.ok(fetchCalls[0].startsWith('https://sandbox.cashfree.com/pg/orders/'), fetchCalls[0]);
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})();
