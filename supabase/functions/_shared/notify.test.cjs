// Telegram new-lead alerts — the failure paths, not the happy one.
//
// Two bugs lived here, and both were the same shape: a fault that reported
// itself as a setting.
//
//   1. The agent_config read discarded `error`, so `cfg` was null and the next
//      line returned `reason: "disabled"` — the word for a deliberate customer
//      choice. run-actions only fails an automation when `reason === "error"`,
//      so every rule still recorded ok:true. A single broken read turned every
//      org's alerts off with a green board above it.
//
//   2. scrubToken's bare-token pattern was `[0-9]{8,10}:`, so an 11-digit bot
//      id matched only from its second digit and the "redaction" printed
//      `1<redacted>`. And the !r.ok branch returned Telegram's response body
//      unscrubbed — the one path that runs when Telegram is unhappy was the
//      one path that could hand out the token.
//
// Everything here fails against the pre-fix module.

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
const fs = require('fs');
const assert = require('assert');

// notify.ts reads Deno.env at import time and imports ./http.ts.
globalThis.Deno = { env: { get: () => '' } };

let fetchImpl = async () => ({ ok: true, status: 200, text: async () => '{}' });
const src = fs.readFileSync(path.join(__dirname, 'notify.ts'), 'utf8');
const js = es.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
const stubRequire = (spec) => {
  if (spec.includes('http')) return { fetchWithTimeout: (...a) => fetchImpl(...a) };
  throw new Error('unexpected import: ' + spec);
};
const m = { exports: {} };
new Function('module', 'exports', 'require', js)(m, m.exports, stubRequire);
const { notifyNewLead, scrubToken } = m.exports;

// A postgrest-shaped fake: RESOLVES with { data, error }, never throws.
function fakeDb(result) {
  const self = {
    from() { return self; },
    select() { return self; },
    eq() { return self; },
    single() { return Promise.resolve(result); },
    maybeSingle() { return Promise.resolve(result); },
  };
  return self;
}

let pass = 0, fail = 0;
const errs = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; errs.push(name + ': ' + e.message); console.log('  FAIL ' + name + ' — ' + e.message); }
}

const LEAD = { id: 'lead-1', name: 'Asha', email: 'a@b.com', phone: '+919876500000' };

(async () => {
  // ── The swallowed read ────────────────────────────────────────────────────
  await t('a refused config read reports "error", never "disabled"', async () => {
    const db = fakeDb({ data: null, error: { message: 'permission denied for table agent_config' } });
    const r = await notifyNewLead(db, 'org-1', LEAD);
    assert.strictEqual(r.sent, false);
    assert.strictEqual(r.reason, 'error',
      'a read failure must not be reported as the customer having switched alerts off');
    assert.ok(/permission denied/.test(r.detail || ''), 'the detail must name the cause');
  });

  await t('run-actions would fail the automation on that reason', async () => {
    // run-actions only treats reason === "error" as a failure. This asserts the
    // contract between the two modules, which is where the bug actually bit.
    const db = fakeDb({ data: null, error: { message: 'boom' } });
    const r = await notifyNewLead(db, 'org-1', LEAD);
    assert.strictEqual(r.reason === 'error', true);
  });

  await t('a genuinely disabled org still reports "disabled"', async () => {
    const db = fakeDb({ data: { notify_new_leads: false }, error: null });
    const r = await notifyNewLead(db, 'org-1', LEAD);
    assert.strictEqual(r.reason, 'disabled', 'a real setting must not be reported as a fault');
  });

  await t('no config row at all is "disabled", not an error', async () => {
    // .maybeSingle() returns { data: null, error: null } for no row. An org
    // that has never opened Settings has not opted in, which is a choice.
    const db = fakeDb({ data: null, error: null });
    const r = await notifyNewLead(db, 'org-1', LEAD);
    assert.strictEqual(r.reason, 'disabled');
  });

  await t('alerts on but no chat id is "not_configured"', async () => {
    const db = fakeDb({ data: { notify_new_leads: true, telegram_bot_token: 'x', telegram_chat_id: '' }, error: null });
    const r = await notifyNewLead(db, 'org-1', LEAD);
    assert.strictEqual(r.reason, 'not_configured');
  });

  // ── The token in the error body ───────────────────────────────────────────
  await t('a Telegram error body is scrubbed before it is returned', async () => {
    const token = '1234567890:AAH1234567890abcdefghijklmnopqrstuvw';
    fetchImpl = async () => ({
      ok: false, status: 401,
      text: async () => `{"description":"Unauthorized","url":"/bot${token}/sendMessage"}`,
    });
    const db = fakeDb({
      data: { notify_new_leads: true, telegram_bot_token: token, telegram_chat_id: '42' },
      error: null,
    });
    const r = await notifyNewLead(db, 'org-1', LEAD);
    assert.strictEqual(r.sent, false);
    assert.ok(!r.detail.includes(token), 'the bot token must not survive into the detail: ' + r.detail);
    assert.ok(r.detail.includes('401'), 'the status is still useful and must survive');
    fetchImpl = async () => ({ ok: true, status: 200, text: async () => '{}' });
  });

  await t('a successful send reports sent:true', async () => {
    const db = fakeDb({
      data: { notify_new_leads: true, telegram_bot_token: 'tok', telegram_chat_id: '42' },
      error: null,
    });
    const r = await notifyNewLead(db, 'org-1', LEAD);
    assert.strictEqual(r.sent, true);
  });

  // ── scrubToken ────────────────────────────────────────────────────────────
  await t('scrubs the url form', () => {
    const out = scrubToken('failed to fetch /bot1234567890:AAH-abcdefghijklmnopqrstuvwxyz123456/sendMessage');
    assert.ok(!/AAH-abc/.test(out), out);
    assert.ok(out.includes('<redacted>'), out);
  });

  await t('scrubs a bare 10-digit bot token', () => {
    const out = scrubToken('bad token 1234567890:AAH1234567890abcdefghijklmnopqrstu');
    assert.ok(!/AAH123/.test(out), out);
  });

  await t('scrubs an 11-digit bot id WITHOUT leaking its first digit', () => {
    // The pre-fix pattern was [0-9]{8,10}:, which matched from the SECOND
    // digit of an 11-digit id and printed "1<redacted>". Telegram ids are now
    // routinely 10-11 digits and still growing.
    const out = scrubToken('oops 12345678901:AAH1234567890abcdefghijklmnopqrstu here');
    assert.ok(!/AAH123/.test(out), out);
    assert.ok(!/\d<redacted>/.test(out), 'a leading digit leaked through the redaction: ' + out);
    assert.ok(out.includes('<redacted>'), out);
  });

  await t('scrubs a 12-digit bot id too', () => {
    const out = scrubToken('123456789012:AAH1234567890abcdefghijklmnopqrstu');
    assert.ok(!/\d<redacted>/.test(out), out);
  });

  // ── The prefixes that defeated my first attempt at this fix ──────────────
  //
  // A boundary class of [^0-9A-Za-z_-] looked like the tidy way to anchor the
  // match. It meant a token preceded by a letter, digit, `-` or `_` did not
  // match AT ALL, so `bot<id>:<token>` — a shape Telegram echoes in some error
  // bodies, and one the `/bot…` rule does not catch without the slash — printed
  // in full. The "fix" leaked more than the bug. These are the four cases that
  // distinguish the two patterns.
  for (const prefix of ['bot', 'X-', 'id_', 'ref9']) {
    await t(`scrubs a token prefixed by "${prefix}"`, () => {
      const token = '1234567890:AAH1234567890abcdefghijklmnopqrstu';
      const out = scrubToken(`${prefix}${token} tail`);
      assert.ok(!out.includes('AAH1234567890'), `token survived after "${prefix}": ${out}`);
      assert.ok(out.includes('<redacted>'), out);
    });
  }

  await t('scrubs a token at the very start of the string', () => {
    const out = scrubToken('1234567890:AAH1234567890abcdefghijklmnopqrstu');
    assert.ok(!out.includes('AAH'), out);
  });

  await t('leaves ordinary text alone', () => {
    assert.strictEqual(scrubToken('chat not found'), 'chat not found');
    assert.strictEqual(scrubToken(''), '');
    // A timestamp-like number followed by a short word must not be eaten.
    assert.strictEqual(scrubToken('at 12:30 today'), 'at 12:30 today');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) errs.forEach((e) => console.log('  - ' + e));
  process.exit(fail ? 1 : 0);
})();
