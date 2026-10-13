/**
 * Tests for the public API's request validation (api-validate.ts) and for the
 * OpenAPI document staying in step with the routes the API actually serves.
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
function load(file) {
  const js = es.transformSync(fs.readFileSync(path.join(__dirname, file), "utf8"), { loader: "ts", format: "cjs" }).code;
  const m = { exports: {} };
  new Function("module", "exports", "require", js)(m, m.exports, (s) => { throw new Error("unexpected import " + s); });
  return m.exports;
}
const V = load("api-validate.ts");
const { openapiSpec } = load("openapi.ts");

// Stand-in for capture.ts normPhone: accepts 10-digit Indian mobiles only.
const norm = (raw) => (typeof raw === "string" && /^[6-9]\d{9}$/.test(raw.replace(/\D/g, "").slice(-10))
  ? "+91" + raw.replace(/\D/g, "").slice(-10) : null);

test("PATCH: a valid update is normalised", () => {
  const r = V.validateLeadPatch({
    name: "  Asha ", email: "Asha@Example.COM", phone: "98765 43210", score: 80,
    tags: ["hot", "hot", " mba "], next_follow_up_at: "2026-11-01T10:00:00+05:30",
    assigned_to: "8b0c2a4e-1111-4222-8333-944455556666", org_id: "ignored",
  }, norm);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.patch.name, "Asha");
  assert.strictEqual(r.patch.email, "asha@example.com", "lower-cased so it dedupes against widget captures");
  assert.strictEqual(r.patch.phone, "+919876543210");
  assert.deepStrictEqual(r.patch.tags, ["hot", "mba"]);
  assert.strictEqual(r.patch.next_follow_up_at, "2026-11-01T04:30:00.000Z");
  assert.strictEqual(r.assignTo, "8b0c2a4e-1111-4222-8333-944455556666", "the route must check membership");
  assert.ok(!("org_id" in r.patch), "org_id can never be patched");
});

test("PATCH: each bad field is reported, nothing is written", () => {
  const r = V.validateLeadPatch({
    name: "", email: "not-an-email", phone: "12", score: 500, assigned_to: "bob",
    tags: "hot", custom: [1], next_follow_up_at: "tomorrow", stage_key: "",
  }, norm);
  assert.strictEqual(r.errors.length, 9, r.errors.join("\n"));
  assert.deepStrictEqual(r.patch, {});
});

test("PATCH: score must be an integer 0..100", () => {
  for (const bad of [-1, 101, 50.5, "80"]) {
    assert.ok(V.validateLeadPatch({ score: bad }, norm).errors.length, `score ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(V.validateLeadPatch({ score: 0 }, norm).patch.score, 0);
});

test("PATCH: nulls clear fields that may be cleared", () => {
  const r = V.validateLeadPatch({ email: null, phone: null, assigned_to: null, next_follow_up_at: null }, norm);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.patch, { email: null, phone: null, assigned_to: null, next_follow_up_at: null });
});

test("PATCH: oversized custom and too many tags are refused", () => {
  assert.ok(V.validateLeadPatch({ custom: { blob: "x".repeat(9000) } }, norm).errors.length);
  assert.ok(V.validateLeadPatch({ tags: Array.from({ length: 31 }, (_, i) => "t" + i) }, norm).errors.length);
});

test("PATCH: a non-object body is refused", () => {
  for (const b of [null, [], "x", 3]) assert.ok(V.validateLeadPatch(b, norm).errors.length);
});

test("POST: create validation", () => {
  assert.deepStrictEqual(V.validateLeadCreate({ name: "A", email: "a@b.co" }), []);
  assert.ok(V.validateLeadCreate({ email: "nope" }).length);
  assert.ok(V.validateLeadCreate({ phone: 98765 }).length);
  assert.ok(V.validateLeadCreate({ custom: "x" }).length);
  assert.ok(V.validateLeadCreate([]).length);
});

test("pagination is clamped and NaN-safe", () => {
  assert.deepStrictEqual(V.pageParams(null, null), { limit: 50, offset: 0 });
  assert.deepStrictEqual(V.pageParams("1000", "-5"), { limit: 200, offset: 0 });
  assert.deepStrictEqual(V.pageParams("abc", "xyz"), { limit: 50, offset: 0 },
    "the old code produced NaN here and PostgREST answered with its own error");
  assert.deepStrictEqual(V.pageParams("10.7", "20.2"), { limit: 10, offset: 20 });
});

test("since must be a timestamp", () => {
  assert.strictEqual(V.validSince(null), null);
  assert.strictEqual(V.validSince("garbage"), false);
  assert.strictEqual(V.validSince("2026-10-01"), "2026-10-01T00:00:00.000Z");
});

test("OpenAPI documents exactly the routes the API serves", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "api", "index.ts"), "utf8");
  const served = new Set();
  for (const m of src.matchAll(/path === "(\/[a-z.]+)" && req\.method === "(GET|POST|PATCH)"/g)) {
    served.add(`${m[2]} ${m[1]}`);
  }
  // Regex routes: `const one = path.match(/^\/leads\/(...)$/i)` used as `one && req.method === "X"`.
  for (const m of src.matchAll(/const (\w+) = path\.match\(\/\^\\\/(\w+)\\\/\(\[0-9a-f-\]\{36\}\)\$\/i\)/g)) {
    for (const mm of src.matchAll(new RegExp(`\\b${m[1]} && req\\.method === "(GET|POST|PATCH)"`, "g"))) {
      served.add(`${mm[1]} /${m[2]}/{id}`);
    }
  }
  const spec = openapiSpec("https://example.test");
  const documented = new Set();
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const method of ["get", "post", "patch", "delete", "put"]) {
      if (item[method]) documented.add(`${method.toUpperCase()} ${p}`);
    }
  }
  assert.ok(served.size >= 9, `route scan found too few routes (${served.size}) — has the routing style changed?`);
  assert.deepStrictEqual([...served].sort(), [...documented].sort());
});

test("OpenAPI: every $ref resolves and every operation has an id", () => {
  const spec = openapiSpec("https://example.test");
  const refs = JSON.stringify(spec).match(/#\/components\/schemas\/\w+/g) || [];
  for (const r of refs) assert.ok(spec.components.schemas[r.split("/").pop()], "dangling " + r);
  const ids = [];
  for (const item of Object.values(spec.paths)) {
    for (const op of Object.values(item)) if (op && op.operationId) ids.push(op.operationId);
  }
  assert.strictEqual(new Set(ids).size, ids.length, "operationIds must be unique");
});
