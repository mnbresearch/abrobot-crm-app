/**
 * Tests for suppression.ts — the platform unsubscribe list every sender reads.
 *
 * The client is a stub that records what was asked, so these check the two
 * properties that matter without a database: every address is looked up (in
 * URL-safe groups), and an unreadable list is NEVER reported as an empty one.
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

const { normaliseEmail, chunk, loadSuppressed } = loadTs("suppression.ts");

// A minimal stand-in for supabase-js: from(table).select(cols).in(col, values)
// resolving to { data, error }. Records every call so the test can see them.
function stubClient({ onList = new Set(), failOnCall = -1 } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        select(cols) {
          return {
            in(col, values) {
              calls.push({ table, cols, col, values });
              if (calls.length - 1 === failOnCall) {
                return Promise.resolve({ data: null, error: { message: "permission denied" } });
              }
              return Promise.resolve({ data: values.filter((v) => onList.has(v)).map((email) => ({ email })), error: null });
            },
          };
        },
      };
    },
  };
}

test("normaliseEmail lower-cases and trims, and refuses non-strings", () => {
  assert.strictEqual(normaliseEmail("  Bob@Example.COM "), "bob@example.com");
  assert.strictEqual(normaliseEmail(null), "");
  assert.strictEqual(normaliseEmail(42), "");
});

test("chunk splits into fixed groups with a short tail", () => {
  assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepStrictEqual(chunk([], 100), []);
});

test("suppressed addresses are found case-insensitively", async () => {
  const sb = stubClient({ onList: new Set(["gone@example.com"]) });
  const r = await loadSuppressed(sb, ["Gone@Example.com", "stay@example.com", null, ""]);
  assert.strictEqual(r.error, null);
  assert.ok(r.suppressed.has("gone@example.com"));
  assert.ok(!r.suppressed.has("stay@example.com"));
  assert.strictEqual(sb.calls.length, 1);
  assert.strictEqual(sb.calls[0].table, "platform_email_suppressions");
  assert.deepStrictEqual(sb.calls[0].values, ["gone@example.com", "stay@example.com"],
    "lower-cased (the column's CHECK) and de-duplicated, blanks dropped");
});

test("a large batch is queried in groups, and every address is checked", async () => {
  const emails = Array.from({ length: 250 }, (_, i) => `u${i}@example.com`);
  const sb = stubClient({ onList: new Set(["u249@example.com", "u0@example.com"]) });
  const r = await loadSuppressed(sb, emails);
  assert.strictEqual(sb.calls.length, 3);
  assert.strictEqual(sb.calls.flatMap((c) => c.values).length, 250);
  assert.deepStrictEqual([...r.suppressed].sort(), ["u0@example.com", "u249@example.com"]);
});

test("an unreadable list FAILS CLOSED — never an empty set", async () => {
  const emails = Array.from({ length: 150 }, (_, i) => `u${i}@example.com`);
  // The SECOND group fails: a partial answer must not be returned as if whole.
  const r = await loadSuppressed(stubClient({ failOnCall: 1 }), emails);
  assert.strictEqual(r.suppressed, null);
  assert.match(r.error, /permission denied/);
});

test("no addresses means no query", async () => {
  const sb = stubClient();
  const r = await loadSuppressed(sb, []);
  assert.strictEqual(sb.calls.length, 0);
  assert.strictEqual(r.suppressed.size, 0);
});
