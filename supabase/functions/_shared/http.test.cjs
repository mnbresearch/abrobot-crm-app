// Tests for the outbound-fetch deadline.
//
// Not a single outbound fetch in this codebase had a timeout: Groq, Meta,
// Telegram, Resend, Cashfree. A hung upstream held the function until the
// platform killed it and the caller got nothing back — no error, no partial
// result, no log line explaining the gap. It matters most in nurture, which
// loops up to 25 organisations x 100 leads, where one slow Resend call starves
// every tenant later in the run, on a schedule, so the same tenants starve
// every time.
//
// Three properties are worth a test each:
//   1. It actually aborts at the deadline, and reports WHICH host was slow —
//      a bare AbortError does not say that, which is the whole point of
//      TimeoutError.
//   2. It clears its timer. A 15-second default left pending would hold the
//      event loop open for 15s after every successful call.
//   3. A non-abort failure is passed through untouched, so a real network error
//      is not relabelled as a timeout.
//
// ⚠️ THIS SUITE CURRENTLY EXITS 1. Two assertions at the bottom are marked
// KNOWN FAILURE: `new TimeoutError(relativeUrl, ms)` throws
// `TypeError: Invalid URL` from `new URL(url).host`, so on a relative URL the
// diagnostic the class exists to produce is replaced by an unrelated error
// raised inside an error path. They are written as the CORRECT expected
// behaviour on purpose. Do not weaken them; fix http.ts.

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

// transformSync, not buildSync: http.ts imports nothing. It reaches `fetch`,
// `setTimeout`, `clearTimeout` and `AbortController` as globals at CALL time,
// which is what lets the fakes below be swapped in per test.
const src = fs.readFileSync(path.join(__dirname, 'http.ts'), 'utf8');
const js = es.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
const stubRequire = (spec) => { throw new Error('unexpected import: ' + spec); };
const m = { exports: {} };
new Function('module', 'exports', 'require', js)(m, m.exports, stubRequire);
const { fetchWithTimeout, TimeoutError } = m.exports;

if (typeof fetchWithTimeout !== 'function' || typeof TimeoutError !== 'function') {
  console.log('FAILED - http.ts does not export fetchWithTimeout and TimeoutError');
  process.exit(1);
}

// ── Fakes ────────────────────────────────────────────────────────────────────

// An upstream that never answers until it is aborted — a hung Resend or Groq.
// It REJECTS with a real AbortError shape rather than throwing synchronously,
// because that is what fetch does and the AbortError branch is under test.
function hangingFetch(record = {}) {
  return (url, init) => {
    record.url = url;
    record.init = init;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        reject(e);
      });
    });
  };
}

// Wrap a call so every timer it creates is recorded and can be checked. The
// real setTimeout/clearTimeout are restored even if the call rejects.
//
// The requested delay is recorded AT CREATION, not read off the handle
// afterwards: once a Timeout has been cleared, Node resets its `_idleTimeout`
// to -1, so inspecting the handle after the call reports -1 for every timer and
// the delay assertion below would fail for a reason that has nothing to do with
// the code under test.
async function withTimerSpy(fn) {
  const created = [], cleared = [], delays = [];
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (cb, ms, ...rest) => {
    const h = realSet(cb, ms, ...rest);
    created.push(h);
    delays.push(ms);
    return h;
  };
  globalThis.clearTimeout = (h) => { cleared.push(h); return realClear(h); };
  try {
    const outcome = await fn().then((value) => ({ value }), (error) => ({ error }));
    return { ...outcome, created, cleared, delays };
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

const realFetch = globalThis.fetch;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); failed++; }
  finally { globalThis.fetch = realFetch; }
}

(async () => {
  console.log('http');

  // ── A successful response passes through ───────────────────────────────────
  await test('a successful response is returned as-is', async () => {
    const res = new Response('{"ok":true}', { status: 201, headers: { 'x-upstream': 'resend' } });
    globalThis.fetch = async () => res;
    const out = await fetchWithTimeout('https://api.resend.com/emails', { method: 'POST' });
    assert.strictEqual(out, res, 'the caller must get the very same Response, not a copy');
    assert.strictEqual(out.status, 201);
    assert.strictEqual(await out.text(), '{"ok":true}');
  });

  await test('a non-2xx response is returned, not thrown', async () => {
    // Every caller inspects res.ok itself (Resend 422s, Meta 400s carry the
    // useful detail in the body). Converting those to exceptions here would
    // discard the body.
    globalThis.fetch = async () => new Response('{"error":"invalid to"}', { status: 422 });
    const out = await fetchWithTimeout('https://api.resend.com/emails');
    assert.strictEqual(out.status, 422);
    assert.strictEqual(out.ok, false);
  });

  await test('the caller init is forwarded, with an abort signal added', async () => {
    let seen;
    globalThis.fetch = async (_u, init) => { seen = init; return new Response('ok'); };
    const headers = { authorization: 'Bearer k' };
    await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions',
      { method: 'POST', headers, body: '{}' });
    assert.strictEqual(seen.method, 'POST');
    assert.strictEqual(seen.headers, headers, 'headers must not be rewritten');
    assert.strictEqual(seen.body, '{}');
    assert.ok(seen.signal, 'no signal was attached, so there is no deadline at all');
    assert.strictEqual(seen.signal.aborted, false);
  });

  await test('it works with no init at all', async () => {
    globalThis.fetch = async (_u, init) => { assert.ok(init.signal); return new Response('ok'); };
    assert.strictEqual((await fetchWithTimeout('https://api.telegram.org/bot1/sendMessage')).status, 200);
  });

  // ── It aborts at the deadline ──────────────────────────────────────────────
  await test('a hung upstream is aborted at the deadline and reported as a TimeoutError', async () => {
    const record = {};
    globalThis.fetch = hangingFetch(record);
    const started = Date.now();
    const { value, error } = await withTimerSpy(() =>
      fetchWithTimeout('https://api.resend.com/emails', { method: 'POST' }, 40));
    const elapsed = Date.now() - started;

    assert.strictEqual(value, undefined, 'it must not resolve: ' + JSON.stringify(value));
    assert.ok(error, 'a hung upstream must reject, not hang the caller');
    assert.strictEqual(error.name, 'TimeoutError',
      'an AbortError on its own does not say what was slow — that is what this class is for');
    assert.ok(error instanceof TimeoutError, 'not a TimeoutError instance: ' + error.constructor.name);
    assert.ok(error instanceof Error);
    assert.match(error.message, /timed out after 40ms/);
    assert.match(error.message, /api\.resend\.com/, 'the message must name the slow host: ' + error.message);
    assert.ok(record.init.signal.aborted, 'the request must actually be aborted, not just abandoned');
    assert.ok(elapsed >= 35, 'aborted early, at ' + elapsed + 'ms');
    assert.ok(elapsed < 5000, 'took ' + elapsed + 'ms — the deadline did not fire');
  });

  await test('the deadline defaults to 15s', async () => {
    // Long enough for a slow LLM, short enough to leave budget for the rest of
    // a batch. Asserted through the timer rather than by waiting 15 seconds.
    globalThis.fetch = async () => new Response('ok');
    const { created, delays } = await withTimerSpy(() => fetchWithTimeout('https://api.groq.com/x'));
    assert.strictEqual(created.length, 1, 'expected exactly one timer');
    assert.strictEqual(delays[0], 15000, 'default deadline is ' + delays[0] + 'ms');
  });

  await test('an explicit deadline overrides the default', async () => {
    globalThis.fetch = async () => new Response('ok');
    const { delays } = await withTimerSpy(() => fetchWithTimeout('https://api.groq.com/x', {}, 3000));
    assert.deepStrictEqual(delays, [3000]);
  });

  // ── It clears its timer ────────────────────────────────────────────────────
  await test('the timer is cleared on the SUCCESS path, so the process can exit', async () => {
    // Without the `finally`, a 15-second timer stays pending after every
    // successful call. In a Deno edge function that keeps the isolate awake;
    // in this test process it would add 15s to the run.
    globalThis.fetch = async () => new Response('ok');
    const { created, cleared } = await withTimerSpy(() =>
      fetchWithTimeout('https://api.resend.com/emails'));
    assert.strictEqual(created.length, 1);
    assert.ok(cleared.includes(created[0]), 'the deadline timer was never cleared');
    if ('_destroyed' in created[0]) {
      assert.strictEqual(created[0]._destroyed, true, 'the timer handle is still live');
    }
  });

  await test('the timer is cleared on the TIMEOUT path too', async () => {
    globalThis.fetch = hangingFetch();
    const { created, cleared } = await withTimerSpy(() =>
      fetchWithTimeout('https://api.resend.com/emails', {}, 20));
    assert.strictEqual(created.length, 1);
    assert.ok(cleared.includes(created[0]), 'the fired timer must still be cleared');
  });

  await test('the timer is cleared when the upstream fails for some other reason', async () => {
    globalThis.fetch = async () => { throw new TypeError('network unreachable'); };
    const { created, cleared } = await withTimerSpy(() =>
      fetchWithTimeout('https://api.resend.com/emails'));
    assert.strictEqual(created.length, 1);
    assert.ok(cleared.includes(created[0]),
      'an error path that leaks the timer is the easiest one to miss');
  });

  // ── Other errors are not relabelled ───────────────────────────────────────
  await test('a non-abort error is rethrown unchanged, not turned into a timeout', async () => {
    // "timed out" in a log for a DNS failure sends whoever reads it looking at
    // the wrong thing entirely.
    const boom = new TypeError('getaddrinfo ENOTFOUND api.resend.com');
    globalThis.fetch = async () => { throw boom; };
    const { error } = await withTimerSpy(() => fetchWithTimeout('https://api.resend.com/emails'));
    assert.strictEqual(error, boom, 'the original error object must reach the caller');
    assert.notStrictEqual(error.name, 'TimeoutError');
  });

  await test('an AbortError from somewhere OTHER than the deadline still reports a timeout', async () => {
    // Documented, not ideal: the branch tests the error name, not whose signal
    // fired, so a caller-supplied signal that aborts is reported as a timeout.
    // No caller passes its own signal today. If one does, the branch needs
    // `ctrl.signal.aborted` as well.
    globalThis.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; return Promise.reject(e); };
    const { error } = await withTimerSpy(() => fetchWithTimeout('https://api.resend.com/emails', {}, 9999));
    assert.strictEqual(error.name, 'TimeoutError');
  });

  // ── TimeoutError on its own ───────────────────────────────────────────────
  await test('TimeoutError names the host and the budget, and not the path or query', async () => {
    // Deliberate: the URL can carry a bot token (api.telegram.org/bot<TOKEN>/…)
    // or an order id, and this message goes to logs.
    const e = new TimeoutError('https://api.telegram.org/bot12345:SECRET/sendMessage?chat_id=7', 15000);
    assert.strictEqual(e.name, 'TimeoutError');
    assert.match(e.message, /timed out after 15000ms/);
    assert.match(e.message, /api\.telegram\.org/);
    assert.ok(!/SECRET/.test(e.message), 'the token leaked into the message: ' + e.message);
    assert.ok(!/sendMessage/.test(e.message), 'the path leaked into the message: ' + e.message);
  });

  await test('TimeoutError keeps the port, which distinguishes a sandbox from production', async () => {
    assert.match(new TimeoutError('https://sandbox.cashfree.com:8443/pg/orders', 100).message,
      /sandbox\.cashfree\.com:8443/);
  });

  // ── KNOWN FAILURES — http.ts bug, not test bugs ───────────────────────────
  //
  // `new URL(url)` requires an ABSOLUTE url. On a relative one it throws
  // `TypeError: Invalid URL`, and it throws from inside the TimeoutError
  // CONSTRUCTOR — i.e. from inside an error path. The result is that the
  // timeout diagnostic this class exists to produce is replaced by an unrelated
  // TypeError, thrown while reporting a different failure, which is the worst
  // possible place to lose information: the caller is told the URL is invalid
  // when the real event was a slow upstream.
  //
  // Reachability: every current caller passes a literal https:// URL or builds
  // one from an absolute base (cashfree.ts's baseUrl() always returns a full
  // origin), so this is LATENT, not live. It becomes live the first time a URL
  // is assembled from a config value that can be blank.
  //
  // Both assertions below state the CORRECT behaviour. The fix is to make the
  // host lookup unable to fail, e.g.
  //   const host = URL.parse?.(url)?.host ?? url;
  // or a try/catch around it that falls back to the raw url. Deliberately NOT
  // doing that here — http.ts is not modified by this suite.
  await test('KNOWN FAILURE: new TimeoutError on a RELATIVE url does not throw', () => {
    const e = new TimeoutError('/relative-url', 100);
    assert.strictEqual(e.name, 'TimeoutError');
    assert.match(e.message, /timed out after 100ms/,
      'the timeout budget must survive even when the host cannot be parsed');
  });

  await test('KNOWN FAILURE: a timeout on a relative url reports the timeout, not "Invalid URL"', async () => {
    // The same defect as it actually reaches a caller: the deadline fires, the
    // AbortError branch builds a TimeoutError, and the constructor throws, so
    // what propagates is a TypeError about the URL rather than the timeout.
    globalThis.fetch = hangingFetch();
    const { error } = await withTimerSpy(() => fetchWithTimeout('/orders', { method: 'POST' }, 20));
    assert.ok(error, 'must still reject');
    assert.strictEqual(error.name, 'TimeoutError',
      'got ' + error.name + ': ' + error.message + ' — the timeout was masked by an error-path throw');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
