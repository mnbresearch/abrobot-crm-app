// notifyOperator: platform-operator alerts. Must prefer the app_settings
// channel the SQL watchdog uses, fall back to secrets, never throw, and never
// leak the bot token in its reason.
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

const notifyJs = tr('notify.ts');
let env = {};
let fetchImpl = async () => ({ ok: true, text: async () => '' });
const sent = [];
function load() {
  const Deno = { env: { get: (k) => env[k] } };
  const http = { fetchWithTimeout: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return fetchImpl(url, init); } };
  const nm = { exports: {} };
  new Function('module', 'exports', 'Deno', 'require', notifyJs)(nm, nm.exports, Deno, (s) => { if (s.includes('http')) return http; throw new Error(s); });
  const m = { exports: {} };
  new Function('module', 'exports', 'Deno', 'require', tr('operator.ts'))(m, m.exports, Deno, (s) => {
    if (s.includes('http')) return http;
    if (s.includes('notify')) return nm.exports;
    throw new Error('unexpected import: ' + s);
  });
  return m.exports;
}
const db = (rows, error = null) => ({
  from: () => ({ select: () => ({ in: async () => ({ data: rows, error }) }) }),
});

let p = 0, f = 0;
const t = async (n, fn) => { try { await fn(); console.log('  ✓', n); p++; } catch (e) { console.log('  ✗', n, '—', e.message); f++; } };
const quiet = async (fn) => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; } };

(async () => {
  console.log('notifyOperator');
  await t('uses app_settings ops_telegram_* first', async () => {
    env = { TELEGRAM_BOT_TOKEN: 'envtok', OPERATOR_TELEGRAM_CHAT_ID: 'envchat' }; sent.length = 0;
    const r = await load().notifyOperator(db([{ key: 'ops_telegram_bot_token', value: ' 111:dbtok ' }, { key: 'ops_telegram_chat_id', value: '42' }]), 'hello');
    assert.deepStrictEqual(r, { sent: true });
    assert.ok(sent[0].url.includes('/bot111:dbtok/'), sent[0].url);
    assert.strictEqual(sent[0].body.chat_id, '42');
    assert.match(sent[0].body.text, /hello/);
  });
  await t('falls back to env secrets when app_settings has none', async () => {
    env = { TELEGRAM_BOT_TOKEN: 'envtok', OPERATOR_TELEGRAM_CHAT_ID: 'envchat' }; sent.length = 0;
    const r = await load().notifyOperator(db([]), 'x');
    assert.strictEqual(r.sent, true);
    assert.ok(sent[0].url.includes('/botenvtok/'));
  });
  await t('falls back to env when app_settings is unreadable', async () => {
    env = { TELEGRAM_BOT_TOKEN: 'envtok', OPERATOR_TELEGRAM_CHAT_ID: 'envchat' }; sent.length = 0;
    const r = await load().notifyOperator(db(null, { message: 'denied' }), 'x');
    assert.strictEqual(r.sent, true);
  });
  await t('not configured -> sent:false with a reason, no request', async () => {
    env = {}; sent.length = 0;
    const r = await quiet(() => load().notifyOperator(db([]), 'x'));
    assert.strictEqual(r.sent, false); assert.match(r.reason, /not_configured/);
    assert.strictEqual(sent.length, 0);
  });
  await t('a network throw never escapes and the token is scrubbed', async () => {
    env = { TELEGRAM_BOT_TOKEN: '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', OPERATOR_TELEGRAM_CHAT_ID: 'c' };
    fetchImpl = async (url) => { throw new TypeError('error sending request for url (' + url + ')'); };
    const r = await quiet(() => load().notifyOperator(db([]), 'x'));
    assert.strictEqual(r.sent, false);
    assert.ok(!r.reason.includes('AAAAAAAA'), 'token leaked: ' + r.reason);
    fetchImpl = async () => ({ ok: true, text: async () => '' });
  });
  await t('a telegram non-2xx is sent:false', async () => {
    env = { TELEGRAM_BOT_TOKEN: 't', OPERATOR_TELEGRAM_CHAT_ID: 'c' };
    fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'Forbidden: bot was blocked' });
    const r = await quiet(() => load().notifyOperator(db([]), 'x'));
    assert.strictEqual(r.sent, false); assert.match(r.reason, /403/);
    fetchImpl = async () => ({ ok: true, text: async () => '' });
  });
  await t('a throwing db client never escapes', async () => {
    env = {};
    const r = await quiet(() => load().notifyOperator({ from: () => { throw new Error('boom'); } }, 'x'));
    assert.strictEqual(r.sent, false);
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})();
