/**
 * Tests for the shared contact-extraction module.
 *
 * Every "must refuse" case below is a value this code ACTUALLY produced in
 * production before the fix, or a value traced out of the live regexes. They
 * are not hypotheticals:
 *
 *   - A live Toppers Hub record has a phone number stored as its name.
 *   - A live alert rendered a visitor's name as "ZZ" from "ZZ-TEST-ALERT".
 *   - "2024 - 2026" in a sentence about intake years normalised to a phone
 *     number and became a dedupe key.
 *
 * Paths are __dirname-relative. An earlier pair of test files in this repo
 * hardcoded an absolute sandbox path; on CI they errored, and where the path
 * happened to resolve they tested a DIFFERENT CHECKOUT and reported PASS.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// esbuild, not a hand-rolled regex strip.
//
// The first version of this file removed type annotations with a handful of
// `.replace()` calls. It worked until the module grew a `: boolean` return
// type, at which point the whole suite died with "Unexpected token ':'" — a
// test harness that breaks when the code under test is edited is worse than no
// harness, because the failure looks like the code rather than the tooling.
// stage.test.cjs already had this solved; this now uses the same loader.
function loadEsbuild() {
  const candidates = [
    "esbuild",
    path.join(__dirname, "..", "..", "..", "app", "node_modules", "esbuild"),
    path.join(__dirname, "..", "..", "..", "node_modules", "esbuild"),
    "/tmp/node_modules/esbuild",
  ];
  for (const c of candidates) {
    try {
      const mod = require(c);
      mod.transformSync("const a = 1;", { loader: "ts" });
      return mod;
    } catch (_) { /* next */ }
  }
  console.log("SKIP " + path.basename(__filename) + " — no usable esbuild for this platform.");
  process.exit(0);
}

const es = loadEsbuild();
// transformSync, not buildSync: capture.ts is deliberately dependency-free, so
// the test exercises the shipped source rather than a copy of it.
const src = fs.readFileSync(path.join(__dirname, "capture.ts"), "utf8");
const js = es.transformSync(src, { loader: "ts", format: "cjs" }).code;
const stubRequire = (spec) => { throw new Error("unexpected import: " + spec); };
const m = { exports: {} };
new Function("module", "exports", "require", js)(m, m.exports, stubRequire);
const { PHONE_RE, normPhone, grabName, displayName } = m.exports;

for (const [name, fn] of Object.entries({ normPhone, grabName, displayName })) {
  if (typeof fn !== "function") {
    console.log(`FAILED - capture.ts does not export ${name}`);
    process.exit(1);
  }
}

const phoneIn = (s) => { const m = s.match(PHONE_RE); return normPhone(m && m[0]); };

test("grabName keeps real names intact, whatever the script or punctuation", () => {
  const cases = [
    ["My name is ZZ-TEST-ALERT (safe to delete)", "ZZ-TEST-ALERT"],
    ["my name is Jean-Luc Picard", "Jean-Luc Picard"],
    ["my name is Ravi Kumar Sharma", "Ravi Kumar Sharma"],
    ["my name is O'Brien", "O'Brien"],
    ["my name is मृदुल नंदा", "मृदुल नंदा"],
    ["My name is Dr. Mehta", "Dr. Mehta"],
    ["name: Priya Sharma", "Priya Sharma"],
    ["name - Anil Gupta", "Anil Gupta"],
    ["I'm Ravi Kumar", "Ravi Kumar"],
    ["This is Priya", "Priya"],
  ];
  for (const [input, want] of cases) {
    assert.strictEqual(grabName(input), want, `grabName(${JSON.stringify(input)})`);
  }
});

test("grabName refuses sentences that are not introductions", () => {
  // Each of these produced a junk lead name in production.
  const cases = [
    "I'm looking for a Bachelors in Canada",
    "i am interested in your IELTS coaching",
    "this is urgent, please call me",
    "Could I take your name so I can pass this on?",
    "I am just asking about the fees",
    "I'm not sure which course suits me",
    "this is the third time I have written",
  ];
  for (const input of cases) {
    assert.strictEqual(grabName(input), null, `grabName should refuse ${JSON.stringify(input)}`);
  }
});

test("grabName does not pick the assistant's own name out of its greeting", () => {
  // The capture text used to include assistant turns, so a bot that introduces
  // itself ("Hi! I'm Riya") named the lead after itself.
  assert.strictEqual(grabName("Hi! I'm Riya, the assistant here."), "Riya",
    "the regex alone cannot tell — this is why chat-agent must pass visitor turns only");
});

test("normPhone refuses numbers fabricated from ordinary prose", () => {
  assert.strictEqual(phoneIn("Looking at the 2024 - 2026 batch for my MBA"), null);
  assert.strictEqual(phoneIn("Order ref 1234-5678-90 please help"), null);
  assert.strictEqual(phoneIn("My budget is 15,00,000 rupees for the course"), null);
  assert.strictEqual(phoneIn("Intake 2025 2026 2027 please advise"), null);
});

test("normPhone still accepts every real format we were getting right", () => {
  assert.strictEqual(phoneIn("call me on 9876543210"), "+919876543210");
  assert.strictEqual(phoneIn("my number is +91 98765 43210"), "+919876543210");
  assert.strictEqual(phoneIn("reach me at 919876543210"), "+919876543210");
  assert.strictEqual(phoneIn("ring +1 415 555 0123"), "+14155550123");
  assert.strictEqual(normPhone("+91-98765-43210"), "+919876543210");
  assert.strictEqual(normPhone("(+91) 98765 43210"), "+919876543210");
});

test("normPhone counts digits, not the plus sign", () => {
  // lead-webhook tested `digits.length < 8` on a string still containing "+",
  // so a 7-digit number passed as 8 characters.
  assert.strictEqual(normPhone("+1234567"), null, "7 digits must be refused");
  assert.strictEqual(normPhone("+123456789"), null, "9 digits must be refused");
  // NOT 15 — E.164 permits up to 15 digits and an earlier assertion here had it
  // wrong, which is why two tests in this file contradicted each other.
  assert.strictEqual(normPhone("+1234567890123456"), null, "16 digits must be refused");
});

test("displayName never puts a phone number or a blank in the name column", () => {
  // The live defect: a Toppers Hub record whose name is its own phone number.
  assert.strictEqual(displayName(null, null, "+918745821142"), "New enquiry");
  assert.strictEqual(displayName("+918745821142", null, "+918745821142"), "New enquiry");
  assert.strictEqual(displayName("   ", null, "+918745821142"), "New enquiry",
    "a whitespace-only name is truthy, so the old fallback never fired");
  assert.strictEqual(displayName("", "ravi@example.com", null), "ravi");
  assert.strictEqual(displayName("bob@x.com", null, "+919876543210"), "bob",
    "an email typed into the name field should become the name stem, not the address");
  assert.strictEqual(displayName("Ravi Kumar", "ravi@example.com", null), "Ravi Kumar");
});

test("international numbers arrive from Meta WITHOUT a plus and must still work", () => {
  // My first version of normPhone returned null for every one of these. Meta's
  // WhatsApp Cloud API delivers messages[0].from as digits only, so this would
  // have discarded every non-Indian WhatsApp enquiry with a 422 — a regression
  // on behaviour that previously worked.
  assert.strictEqual(normPhone("16315551181"), "+16315551181", "US");
  assert.strictEqual(normPhone("447911123406"), "+447911123406", "UK");
  assert.strictEqual(normPhone("971501234567"), "+971501234567", "UAE");
  assert.strictEqual(normPhone("8613800138000"), "+8613800138000", "China");
  assert.strictEqual(normPhone("9779801234567"), "+9779801234567", "Nepal");
  assert.strictEqual(normPhone("09876543210"), "+919876543210", "Indian trunk prefix");
  // E.164 allows 15 digits; 14 was wrong.
  assert.strictEqual(normPhone("+123456789012345"), "+123456789012345", "15 digits is legal");
  assert.strictEqual(normPhone("+1234567890123456"), null, "16 digits is not");
});

test("a plus anywhere counts as a country-code signal", () => {
  assert.strictEqual(normPhone("Ph: +1 415 555 0123"), "+14155550123");
  assert.strictEqual(normPhone("tel:+447911123406"), "+447911123406");
});

test("digit grouping that is not phone-shaped is refused", () => {
  // Eighteen digits in two-digit groups was stored as a real mobile number and
  // then used as the dedupe key.
  assert.strictEqual(phoneIn("I scored 98 76 54 32 10 in mocks"), null);
  assert.strictEqual(phoneIn("marks were 91 82 73 64 55 60"), null);
  // ...while genuine groupings still pass.
  assert.strictEqual(normPhone("+91 98765 43210"), "+919876543210");
  assert.strictEqual(normPhone("+1 415 555 0123"), "+14155550123");
  assert.strictEqual(normPhone("98765-43210"), "+919876543210");
});

test("grabName stops at a connective instead of running into the next clause", () => {
  // Caught by a LIVE Telegram alert after deploying: the real sentence
  // "my name is Jean-Luc Picard and my email is ..." stored the name as
  // "Jean-Luc Picard and my". There is no punctuation before "and", so the
  // sentence splitter could not help and the four-word allowance ran on.
  assert.strictEqual(
    grabName("my name is Jean-Luc Picard and my email is zz@example.invalid"),
    "Jean-Luc Picard");
  assert.strictEqual(grabName("my name is Priya and I want to study in Canada"), "Priya");
  assert.strictEqual(grabName("my name is Ravi my phone is 9876543210"), "Ravi");
  assert.strictEqual(grabName("name: Anil Gupta email anil@x.com"), "Anil Gupta");
});

test("name particles are NOT treated as connectives", () => {
  // Truncating these would be the same class of error in the other direction.
  assert.strictEqual(grabName("my name is Jean van der Berg"), "Jean van der Berg");
  assert.strictEqual(grabName("my name is Maria de Souza"), "Maria de Souza");
});

test("grabName does not match a trigger buried inside another word", () => {
  // "[Tt]his is" matched inside "Mathis is"; "[Ii] ?am" inside "Miriam".
  assert.strictEqual(grabName("my friend Miriam Sharma referred me"), null);
  assert.strictEqual(grabName("Hi, Miriam Sharma here"), null);
});

test("grabName stops at the end of the name, not the end of the sentence", () => {
  assert.strictEqual(grabName("my name is Priya. Also my budget is 5 lakh"), "Priya");
  assert.strictEqual(grabName("my name is Ravi, I want to study in Canada"), "Ravi");
  assert.strictEqual(grabName("This is Regarding Admission"), null);
  assert.strictEqual(grabName("my name is https://spam.example.com"), null);
  // The abbreviation case must survive the sentence-splitting.
  assert.strictEqual(grabName("My name is Dr. Mehta"), "Dr. Mehta");
});

test("displayName never returns an empty string or throws on a non-string", () => {
  assert.strictEqual(displayName("", "@x.com", null), "New enquiry",
    "'@x.com'.split('@')[0] is '' — the guard must be on the result");
  assert.strictEqual(displayName("", 12345, null), "New enquiry",
    "a mis-mapped integration can deliver a number; .split would have thrown");
  assert.strictEqual(displayName("", { a: 1 }, null), "New enquiry");
  assert.strictEqual(displayName(null, null, null), "New enquiry");
});

test("the extraction is anchored enough not to match inside other text", () => {
  // An email address contains digits and dots; it must not also yield a phone.
  assert.strictEqual(phoneIn("write to ravi.1234567890@example.com"), null,
    "digits inside an email address must not be read as a phone number");
});
