// Tests for merge-token substitution and the plain-text -> HTML step.
//
// template.ts exists because substitution was implemented once in the browser
// (LeadDetail's WhatsApp modal) and nowhere on the server, so the tokens the
// Templates screen documents worked in one place and rendered literally in the
// other. The module's own header records the shape of the complaint: a customer
// would preview "Hi {{first_name}}" and receive exactly that. The first block of
// tests below is that incident, from both sides — a token we know must be
// substituted, and a token we do NOT know must stay visible rather than being
// blanked, because a stray {{discount}} is a mistake someone can see and fix
// while a sentence missing its object reads as fluent nonsense and ships.
//
// The last block is the ordering rule, and it is the one worth being careful
// about: applyTemplate() inserts LEAD-SUPPLIED text, and lead names arrive from
// unauthenticated intake paths (the website widget, inbound webhooks). So the
// escape has to happen AFTER substitution. Composed the other way round the
// escape runs over the template the tenant wrote and the attacker's value is
// spliced in afterwards, untouched. Both orders are asserted here so the safe
// one is pinned and the unsafe one is documented as unsafe.

const path = require('path');

// Resolved from this file's own location, never hardcoded. Two suites in this
// directory previously pinned an absolute sandbox path: on CI the path did not
// exist so the tests job went red on every push, and on a machine where it DID
// exist the suite reported PASS about a different copy of the repository than
// the one being built.
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

// transformSync, not buildSync: template.ts imports nothing, so there is no
// module graph to resolve and no temp outfile to clean up.
const src = fs.readFileSync(path.join(__dirname, 'template.ts'), 'utf8');
const js = es.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
const stubRequire = (spec) => { throw new Error('unexpected import: ' + spec); };
const m = { exports: {} };
new Function('module', 'exports', 'require', js)(m, m.exports, stubRequire);
const { firstName, applyTemplate, escapeHtml, textToHtml } = m.exports;

for (const [name, fn] of Object.entries({ firstName, applyTemplate, escapeHtml, textToHtml })) {
  if (typeof fn !== 'function') {
    // A rename must fail loudly here rather than leave the assertions below
    // running against `undefined` and reporting a green suite.
    console.log('FAILED - template.ts does not export ' + name);
    process.exit(1);
  }
}

const BRAND = 'Abrobot';
const LEAD = {
  name: 'Asha Devi',
  email: 'asha.devi@example.com',
  phone: '+919876543210',
  target_country: 'Canada',
  course: 'MSc Data Science',
  intake: 'Jan 2027',
  custom: { treatment: 'Root canal' },
};

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); failed++; }
}

(async () => {
  console.log('template');

  // ── firstName ──────────────────────────────────────────────────────────────
  await test('firstName takes the first word of a full name', () => {
    assert.strictEqual(firstName('Asha Devi', 'asha@example.com'), 'Asha');
  });

  await test('firstName falls back to the email local part, capitalised', () => {
    assert.strictEqual(firstName(null, 'asha.devi@example.com'), 'Asha');
    assert.strictEqual(firstName('', 'ravi_kumar@example.com'), 'Ravi');
    assert.strictEqual(firstName('   ', 'sam+tag@example.com'), 'Sam');
  });

  await test('a PHONE-SHAPED name falls back to "there", not to the digits', () => {
    // "Hi 9876543210," is worse than no name at all, and the widget's name
    // field is free text that people fill with whatever they like — a phone
    // number is the single most common thing that lands in it.
    assert.strictEqual(firstName('9876543210', null), 'there');
    assert.strictEqual(firstName('+91 98765-43210', null), 'there');
    assert.strictEqual(firstName('(044) 2345 6789', null), 'there');
  });

  await test('an all-digits email local part also falls back to "there"', () => {
    assert.strictEqual(firstName(null, '9876543210@example.com'), 'there');
  });

  await test('firstName never returns an empty greeting', () => {
    // The docblock's promise: "never an empty greeting". Every path must
    // produce something printable, because the caller writes "Hi {{first_name}},".
    for (const [n, e] of [[null, null], ['', ''], [undefined, undefined], ['', null]]) {
      const r = firstName(n, e);
      assert.ok(r && r.trim().length > 0, `firstName(${JSON.stringify(n)}, ${JSON.stringify(e)}) = ${JSON.stringify(r)}`);
    }
    assert.strictEqual(firstName(null, null), 'there');
  });

  // KNOWN FAILURE — template.ts bug, not a test bug. Do not weaken this.
  //
  // A WHITESPACE-ONLY email defeats the "never an empty greeting" guarantee.
  // The name branch trims before testing for emptiness; the email branch does
  // not, so `e` is "   ", which is truthy and is not all digits, and firstName
  // returns "   ". The rendered line is "Hi   ," — the exact output the
  // "there" fallback exists to prevent.
  //
  // Reachability: lead-webhook validates email against EMAIL_RE and nulls a
  // blank one, so that path is safe today. The other writers of leads.email
  // (CSV import, chat-agent, manual entry) do not all go through that check,
  // so this is latent rather than live.
  //
  // Fix is one word in template.ts — trim the local part before testing it:
  //   const e = (email || "").trim().split("@")[0].replace(/[._\-+].*$/, "");
  await test('KNOWN FAILURE: a whitespace-only email falls back to "there"', () => {
    assert.strictEqual(firstName(null, '   '), 'there');
    assert.strictEqual(firstName('   ', '   '), 'there');
  });

  // ── applyTemplate: the documented incident ─────────────────────────────────
  await test('a known token is substituted, not printed literally', () => {
    // The whole reason this module exists. The customer previewed
    // "Hi {{first_name}}" and the recipient got that string verbatim.
    assert.strictEqual(applyTemplate('Hi {{first_name}}', LEAD, BRAND), 'Hi Asha');
  });

  await test('an UNKNOWN token is left visible rather than blanked', () => {
    // "Hi {{discount}}" stays. A visible token is a mistake someone can fix;
    // silently deleting it produces a sentence that reads fine and is wrong.
    assert.strictEqual(applyTemplate('Hi {{discount}}', LEAD, BRAND), 'Hi {{discount}}');
    assert.strictEqual(
      applyTemplate('Use code {{promo_code}} before {{intake}}', LEAD, BRAND),
      'Use code {{promo_code}} before Jan 2027',
    );
  });

  await test('a KNOWN but empty token collapses to nothing, leaving a gap', () => {
    // The other half of the same decision: {{course}} on a record with no
    // course must leave a gap, not print "{{course}}" at the customer.
    const bare = { name: 'Asha', email: 'a@example.com' };
    assert.strictEqual(applyTemplate('Course: {{course}}.', bare, BRAND), 'Course: .');
    assert.strictEqual(applyTemplate('[{{country}}]', bare, BRAND), '[]');
    assert.strictEqual(applyTemplate('[{{intake}}]', bare, BRAND), '[]');
  });

  await test('an empty token is distinguishable from an unknown one', () => {
    // Asserted as a pair because collapsing both to "" — or both to the raw
    // token — is exactly the regression this design is guarding against.
    const bare = { name: 'Asha', email: 'a@example.com' };
    assert.strictEqual(applyTemplate('{{course}}|{{discount}}', bare, BRAND), '|{{discount}}');
  });

  await test('tokens are case- and space-insensitive', () => {
    // The Templates screen documents lowercase, but people type what they
    // remember, and a template that renders literally because someone wrote
    // "{{ First_Name }}" is the same customer-visible failure as before.
    assert.strictEqual(applyTemplate('Hi {{ FIRST_NAME }}', LEAD, BRAND), 'Hi Asha');
    assert.strictEqual(applyTemplate('Hi {{First_Name}}', LEAD, BRAND), 'Hi Asha');
    assert.strictEqual(applyTemplate('Hi {{  first_name  }}', LEAD, BRAND), 'Hi Asha');
    assert.strictEqual(applyTemplate('{{ BRAND }}', LEAD, BRAND), BRAND);
  });

  await test('every documented token resolves', () => {
    assert.strictEqual(
      applyTemplate('{{name}}/{{email}}/{{phone}}/{{country}}/{{course}}/{{intake}}/{{brand}}', LEAD, BRAND),
      'Asha Devi/asha.devi@example.com/+919876543210/Canada/MSc Data Science/Jan 2027/Abrobot',
    );
  });

  await test('course falls back to course_level', () => {
    const lead = { name: 'Asha', email: 'a@example.com', course_level: 'Postgraduate' };
    assert.strictEqual(applyTemplate('{{course}}', lead, BRAND), 'Postgraduate');
  });

  await test('custom.<field> reaches the industry pack fields, and an absent one stays visible', () => {
    // A dental clinic writes {{custom.treatment}} without us knowing what that
    // is; a typo must stay on screen for the same reason as any other unknown.
    assert.strictEqual(applyTemplate('{{custom.treatment}}', LEAD, BRAND), 'Root canal');
    assert.strictEqual(applyTemplate('{{custom.nope}}', LEAD, BRAND), '{{custom.nope}}');
    assert.strictEqual(applyTemplate('{{custom.treatment}}', { name: 'A' }, BRAND), '{{custom.treatment}}');
  });

  await test('repeated tokens are all substituted', () => {
    assert.strictEqual(applyTemplate('{{first_name}}, {{first_name}}', LEAD, BRAND), 'Asha, Asha');
  });

  // ── escapeHtml ─────────────────────────────────────────────────────────────
  await test('escapeHtml escapes & < > "', () => {
    assert.strictEqual(escapeHtml('<b>'), '&lt;b&gt;');
    assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
    assert.strictEqual(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
    assert.strictEqual(escapeHtml('<a href="x">1 & 2</a>'), '&lt;a href=&quot;x&quot;&gt;1 &amp; 2&lt;/a&gt;');
  });

  await test('escapeHtml is a single pass, so it cannot double-escape', () => {
    // If it re-scanned its own output, `&` -> `&amp;` -> `&amp;amp;` and every
    // ampersand in a template would grow on each call.
    assert.strictEqual(escapeHtml('&amp;'), '&amp;amp;');
    assert.strictEqual(escapeHtml(escapeHtml('&')), '&amp;amp;');
  });

  await test("escapeHtml does NOT escape ' — safe here, documented as a limit", () => {
    // Asserting the real behaviour rather than omitting the character, because
    // an untested character is how this stops being true by accident.
    //
    // It is safe for the one consumer that exists: textToHtml only ever emits
    // double-quoted attributes (style="…" and href="…"), and an apostrophe in
    // text content is inert. It becomes a hole the moment anyone interpolates
    // escapeHtml() output into a SINGLE-quoted attribute, so if that ever
    // happens, change template.ts to escape ' as &#39; and flip this
    // assertion — do not delete it.
    assert.strictEqual(escapeHtml("it's"), "it's");
    assert.strictEqual(escapeHtml("' onload='x"), "' onload='x");
  });

  await test('escapeHtml tolerates an empty string', () => {
    assert.strictEqual(escapeHtml(''), '');
  });

  // ── textToHtml ─────────────────────────────────────────────────────────────
  await test('textToHtml makes paragraphs from blank lines and <br> from single ones', () => {
    const html = textToHtml('one\ntwo\n\nthree');
    assert.strictEqual((html.match(/<p /g) || []).length, 2, html);
    assert.ok(html.includes('one<br>two'), html);
    assert.ok(html.includes('>three</p>'), html);
  });

  await test('textToHtml linkifies a bare URL and escapes the query string', () => {
    const html = textToHtml('See https://abrobot.ai/p?a=1&b=2 today');
    assert.ok(html.includes('<a href="https://abrobot.ai/p?a=1&amp;b=2"'), html);
    assert.ok(html.includes('today'), html);
  });

  await test('textToHtml escapes markup the tenant typed into the editor', () => {
    const html = textToHtml('<b>bold</b>');
    assert.ok(!/<b>/.test(html), 'tenant markup must not survive: ' + html);
    assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt;'), html);
  });

  // ── The ordering rule: escape AFTER substitution ───────────────────────────
  await test('a lead named <script> cannot inject into an email body', () => {
    // The lead name here is what an unauthenticated intake path accepts: the
    // website widget's name field and inbound webhooks both write it straight
    // to leads.name. textToHtml(applyTemplate(...)) must escape it.
    const attacker = { name: '<script>alert(document.domain)</script>', email: 'x@example.com' };
    const html = textToHtml(applyTemplate('Hi {{name}}, welcome.', attacker, BRAND));

    // textToHtml only ever emits <p>, <br> and <a>, so "no other tag appears"
    // is a complete statement about this output rather than a spot check.
    const tags = (html.match(/<\/?([a-z][a-z0-9]*)/gi) || []).map((s) => s.replace(/<\/?/, '').toLowerCase());
    const unexpected = tags.filter((t) => !['p', 'br', 'a'].includes(t));
    assert.deepStrictEqual(unexpected, [], 'unexpected tags in ' + html);
    assert.ok(!/<script/i.test(html), 'raw <script> reached the body: ' + html);
    assert.ok(html.includes('&lt;script&gt;'), 'the name must appear escaped, not dropped: ' + html);
  });

  await test('a quote-breakout payload in a lead name is escaped, attribute and all', () => {
    const attacker = { name: '" onmouseover="alert(1)', email: 'x@example.com' };
    const html = textToHtml(applyTemplate('Hi {{name}}', attacker, BRAND));
    assert.ok(!/\sonmouseover\s*=\s*"/i.test(html), 'a live handler attribute was emitted: ' + html);
    assert.ok(html.includes('&quot;'), html);
  });

  await test('a URL-shaped payload in a lead name cannot break out of href', () => {
    // The linkifier runs over ALREADY-ESCAPED text, so the quote it would need
    // to close href="…" is only ever present as &quot;.
    const attacker = { name: 'https://evil.example/"onmouseover="alert(1)', email: 'x@example.com' };
    const html = textToHtml(applyTemplate('{{name}}', attacker, BRAND));
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((mm) => mm[1]);
    assert.strictEqual(hrefs.length, 1, html);
    assert.ok(!/["'<>]/.test(hrefs[0]), 'href holds a raw quote: ' + hrefs[0]);
    assert.ok(!/\son\w+\s*=\s*"/i.test(html), 'a live handler attribute was emitted: ' + html);
  });

  await test('an attacker value in a custom.<field> is escaped too', () => {
    // custom is a free-form JSON column, so it is as reachable as name.
    const attacker = { name: 'A', email: 'x@example.com', custom: { treatment: '<img src=x onerror=alert(1)>' } };
    const html = textToHtml(applyTemplate('Re: {{custom.treatment}}', attacker, BRAND));
    assert.ok(!/<img/i.test(html), html);
    assert.ok(html.includes('&lt;img'), html);
  });

  await test('the COMPOSITION ORDER is load-bearing: escaping first is unsafe', () => {
    // Documenting the trap rather than only the happy path. Any caller that
    // renders the template to HTML and substitutes afterwards splices the
    // lead's value in raw. No caller does this today; this assertion is here so
    // that if one starts, the reason it is wrong is written down next to proof.
    const attacker = { name: '<script>alert(1)</script>', email: 'x@example.com' };
    const wrongWayRound = applyTemplate(textToHtml('Hi {{name}}'), attacker, BRAND);
    assert.ok(/<script>/.test(wrongWayRound),
      'if this no longer holds, escapeHtml/textToHtml changed — re-check the safe order above');

    const rightWayRound = textToHtml(applyTemplate('Hi {{name}}', attacker, BRAND));
    assert.ok(!/<script>/.test(rightWayRound));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
