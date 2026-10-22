/**
 * Tests for rotation.ts — the order nurture visits organisations in, so that
 * a run stopped by its send cap is followed by one that starts with the orgs
 * it never reached, rather than the same head of the list every time.
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
// Dependency-free module: transform, not bundle, and refuse any import so a
// future edit that adds one fails here instead of passing against a stub.
function loadTs(file) {
  const js = es.transformSync(fs.readFileSync(path.join(__dirname, file), "utf8"),
    { loader: "ts", format: "cjs" }).code;
  const m = { exports: {} };
  new Function("module", "exports", "require", js)(m, m.exports, (s) => { throw new Error("unexpected import " + s); });
  return m.exports;
}

const { rotateAfter } = loadTs("rotation.ts");
const ids = (xs) => xs.map((x) => x.id);
const orgs = ["c", "a", "e", "b", "d"].map((id) => ({ id }));

test("no resume point: sorted by id", () => {
  assert.deepStrictEqual(ids(rotateAfter(orgs, null)), ["a", "b", "c", "d", "e"]);
  assert.deepStrictEqual(ids(rotateAfter(orgs, "")), ["a", "b", "c", "d", "e"]);
});

test("resumes just after the last org that had a turn, wrapping round", () => {
  assert.deepStrictEqual(ids(rotateAfter(orgs, "b")), ["c", "d", "e", "a", "b"]);
});

test("the last org as the mark wraps to the start", () => {
  assert.deepStrictEqual(ids(rotateAfter(orgs, "e")), ["a", "b", "c", "d", "e"]);
});

test("a mark whose org has gone resumes at the next id — nobody skipped or repeated", () => {
  assert.deepStrictEqual(ids(rotateAfter(orgs, "bb")), ["c", "d", "e", "a", "b"]);
  assert.deepStrictEqual(ids(rotateAfter(orgs, "0")), ["a", "b", "c", "d", "e"]);
});

test("successive capped runs eventually give every org a turn", () => {
  // Each run reaches two orgs and records the second as its mark.
  let mark = null;
  const seen = new Set();
  for (let run = 0; run < 3; run++) {
    const order = rotateAfter(orgs, mark).slice(0, 2);
    order.forEach((o) => seen.add(o.id));
    mark = order[order.length - 1].id;
  }
  assert.strictEqual(seen.size, 5);
});

test("does not mutate its input", () => {
  const input = [{ id: "b" }, { id: "a" }];
  rotateAfter(input, "a");
  assert.deepStrictEqual(ids(input), ["b", "a"]);
});
