/**
 * Tests for svix.ts — Svix signature verification (Resend webhooks) and the
 * Resend event classification used by resend-events.
 *
 * Expected signatures are computed independently here with node:crypto, so a
 * bug in svix.ts's WebCrypto path cannot also be baked into the expectation.
 *
 * Paths are __dirname-relative — see capture.test.cjs for why that matters.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

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
const js = es.transformSync(fs.readFileSync(path.join(__dirname, "svix.ts"), "utf8"),
  { loader: "ts", format: "cjs" }).code;
const m = { exports: {} };
new Function("module", "exports", "require", js)(m, m.exports, (s) => { throw new Error("unexpected import " + s); });
const { verifySvix, classifyResendEvent, isHardBounce, recipientsOf } = m.exports;

// ── a known vector, built here ──────────────────────────────────────────────
const KEY = Buffer.from("8f1c7a2b9e0d4c3f6a5b8e7d0c1f2a3b4c5d6e7f8091a2b3", "hex");
const SECRET = "whsec_" + KEY.toString("base64");
const ID = "msg_2abcDEFghiJKLmnoPQRstu";
const NOW = 1791993600; // 2026-10-14T00:00:00Z
const TS = String(NOW);
const BODY = JSON.stringify({
  type: "email.bounced",
  created_at: "2026-10-14T00:00:00.000Z",
  data: { email_id: "e1", to: ["Someone@Example.com"], bounce: { type: "Permanent", subType: "General" } },
});
const sign = (key, id, ts, body) =>
  nodeCrypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
const SIG = "v1," + sign(KEY, ID, TS, BODY);

const base = (o = {}) => ({ secret: SECRET, id: ID, timestamp: TS, signature: SIG, body: BODY, nowSeconds: NOW, ...o });

test("valid signature verifies", async () => {
  assert.deepStrictEqual(await verifySvix(base()), { ok: true });
});

test("Svix's published example vector verifies", async () => {
  // https://docs.svix.com/receiving/verifying-payloads/how-manual
  const r = await verifySvix({
    secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
    timestamp: "1614265330",
    signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    body: '{"test": 2432232314}',
    nowSeconds: 1614265330,
  });
  assert.deepStrictEqual(r, { ok: true });
});

test("secret without the whsec_ prefix is accepted", async () => {
  assert.strictEqual((await verifySvix(base({ secret: KEY.toString("base64") }))).ok, true);
});

test("matching signature anywhere in a space-separated list verifies", async () => {
  const other = "v1," + sign(Buffer.from("other-key-material-xxxxxxxx"), ID, TS, BODY);
  assert.strictEqual((await verifySvix(base({ signature: `v1a,zzz ${other} ${SIG}` }))).ok, true);
});

test("non-v1 version with the right MAC is not accepted", async () => {
  const r = await verifySvix(base({ signature: SIG.replace(/^v1,/, "v2,") }));
  assert.strictEqual(r.ok, false);
});

test("tampered body is rejected", async () => {
  const r = await verifySvix(base({ body: BODY.replace("Permanent", "Transient") }));
  assert.deepStrictEqual(r, { ok: false, reason: "signature mismatch" });
});

test("tampered id or timestamp is rejected", async () => {
  assert.strictEqual((await verifySvix(base({ id: ID + "x" }))).ok, false);
  assert.strictEqual((await verifySvix(base({ timestamp: String(NOW + 1), nowSeconds: NOW }))).ok, false);
});

test("wrong secret is rejected", async () => {
  const wrong = "whsec_" + Buffer.from("a-different-secret-entirely!").toString("base64");
  assert.strictEqual((await verifySvix(base({ secret: wrong }))).ok, false);
});

test("timestamp window is ±5 minutes", async () => {
  assert.strictEqual((await verifySvix(base({ nowSeconds: NOW + 300 }))).ok, true);
  assert.strictEqual((await verifySvix(base({ nowSeconds: NOW - 300 }))).ok, true);
  const old = await verifySvix(base({ nowSeconds: NOW + 301 }));
  assert.strictEqual(old.ok, false);
  assert.match(old.reason, /window/);
  assert.strictEqual((await verifySvix(base({ nowSeconds: NOW - 301 }))).ok, false, "future timestamp");
});

test("fails closed on missing or malformed input", async () => {
  for (const o of [
    { secret: undefined }, { secret: "" }, { secret: "whsec_" }, { secret: "whsec_!!!not-base64" },
    { id: null }, { timestamp: null }, { signature: null }, { signature: "" },
    { timestamp: "1791993600.5" }, { timestamp: "abc" }, { timestamp: "-1" },
    { signature: "v1," }, { signature: "v1,!!!" }, { signature: "garbage" },
  ]) {
    const r = await verifySvix(base(o));
    assert.strictEqual(r.ok, false, JSON.stringify(o));
  }
});

// ── Resend event classification ─────────────────────────────────────────────

test("hard bounce → suppress, recipients lower-cased", () => {
  assert.deepStrictEqual(classifyResendEvent(JSON.parse(BODY)),
    { action: "suppress", reason: "bounced", recipients: ["someone@example.com"] });
});

test("bounce type: Permanent/hard/unknown are hard; Transient/soft are not", () => {
  assert.strictEqual(isHardBounce({ bounce: { type: "Permanent" } }), true);
  assert.strictEqual(isHardBounce({ bounce: { type: "hard" } }), true);
  assert.strictEqual(isHardBounce({ bounce: { type: "Undetermined" } }), true);
  assert.strictEqual(isHardBounce({}), true, "missing type → hard");
  assert.strictEqual(isHardBounce({ bounce: {} }), true);
  assert.strictEqual(isHardBounce({ bounce: { type: "Transient" } }), false);
  assert.strictEqual(isHardBounce({ bounce: { type: "soft" } }), false);
  assert.strictEqual(isHardBounce({ bounce_type: "soft" }), false);
  const r = classifyResendEvent({ type: "email.bounced", data: { to: ["a@b.co"], bounce: { type: "Transient" } } });
  assert.strictEqual(r.action, "ignore");
});

test("complaint → suppress as complained", () => {
  assert.deepStrictEqual(
    classifyResendEvent({ type: "email.complained", data: { to: ["X@Y.org", "x@y.org", "Name <Z@Y.org>"] } }),
    { action: "suppress", reason: "complained", recipients: ["x@y.org", "z@y.org"] });
});

test("other event types and empty recipients are ignored", () => {
  for (const t of ["email.sent", "email.delivered", "email.opened", "email.delivery_delayed", "", undefined]) {
    assert.strictEqual(classifyResendEvent({ type: t, data: { to: ["a@b.co"] } }).action, "ignore", String(t));
  }
  assert.strictEqual(classifyResendEvent({ type: "email.complained", data: { to: [] } }).action, "ignore");
  assert.strictEqual(classifyResendEvent(null).action, "ignore");
});

test("recipientsOf drops non-addresses and accepts a string", () => {
  assert.deepStrictEqual(recipientsOf({ to: ["not-an-email", 42, null, " ok@ex.com "] }), ["ok@ex.com"]);
  assert.deepStrictEqual(recipientsOf({ to: "A@ex.com, b@ex.com" }), ["a@ex.com", "b@ex.com"]);
  assert.deepStrictEqual(recipientsOf({}), []);
});
