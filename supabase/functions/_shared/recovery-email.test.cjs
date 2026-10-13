/**
 * Tests for the abandoned-checkout reminder copy (recovery-email.ts).
 * Paths are __dirname-relative — see capture.test.cjs for why that matters.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function loadEsbuild() {
  for (const c of [
    "esbuild",
    path.join(__dirname, "..", "..", "..", "app", "node_modules", "esbuild"),
    path.join(__dirname, "..", "..", "..", "node_modules", "esbuild"),
    "/tmp/node_modules/esbuild",
  ]) {
    try { const m = require(c); m.transformSync("const a = 1;", { loader: "ts" }); return m; } catch (_) { /* next */ }
  }
  console.log("SKIP " + path.basename(__filename) + " — no usable esbuild for this platform.");
  process.exit(0);
}
const es = loadEsbuild();
const js = es.transformSync(fs.readFileSync(path.join(__dirname, "recovery-email.ts"), "utf8"),
  { loader: "ts", format: "cjs" }).code;
const m = { exports: {} };
new Function("module", "exports", "require", js)(m, m.exports, (s) => { throw new Error("unexpected import " + s); });
const { buildRecoveryEmail } = m.exports;

const base = {
  firstName: "Priya Sharma", orgName: "Bright Futures", planLabel: "Growth", amountInr: 2999, months: 1,
  startedAt: "2026-10-12T06:30:00Z", attempt: 1,
  settingsUrl: "https://crm.mnbresearch.com/settings?tab=usage",
  unsubUrl: "https://x.supabase.co/functions/v1/checkout-recovery?unsub=abc",
};

test("first reminder: honest copy, first name, price, links", () => {
  const e = buildRecoveryEmail(base);
  assert.strictEqual(e.subject, "Your Growth upgrade didn't complete");
  assert.ok(e.html.includes("Hi Priya,"));
  assert.ok(e.html.includes("₹2,999"), "Indian digit grouping");
  assert.ok(/haven't received a completed payment/i.test(e.text), "says what we actually know");
  assert.ok(/money left your account/i.test(e.text), "tells them what to do if they WERE debited");
  assert.ok(!/payment failed|you were charged|nothing was charged/i.test(e.text), "must not claim what we do not know");
  assert.ok(e.html.includes(base.settingsUrl) && e.html.includes(base.unsubUrl));
  assert.ok(e.text.includes(base.unsubUrl), "plain-text part carries the opt-out too");
});

test("second reminder has a different subject", () => {
  assert.strictEqual(buildRecoveryEmail({ ...base, attempt: 2 }).subject, "Still want Growth for Bright Futures?");
});

test("customer-chosen names cannot inject markup or headers", () => {
  const e = buildRecoveryEmail({ ...base, attempt: 2, orgName: 'Evil <img src=x onerror=alert(1)>\r\nBcc: a@b.c', firstName: "<b>" });
  assert.ok(!e.html.includes("<img"), "org name is escaped");
  assert.ok(!e.html.includes("Hi <b>"), "first name is escaped");
  assert.ok(!/[\r\n]/.test(e.subject), "no newline may reach the Subject header");
});

test("missing name and amount degrade gracefully", () => {
  const e = buildRecoveryEmail({ ...base, firstName: null, amountInr: null, months: 12 });
  assert.ok(e.html.includes("Hi there,"));
  assert.ok(!e.html.includes("₹"), "no price when unknown");
});
