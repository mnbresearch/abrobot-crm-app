/**
 * Does widget.js refuse the same URLs and colours the server does?
 *
 * widget.js re-validates every config URL and the accent colour before they
 * reach href=, src= or a <style> block on the customer's site — defence in
 * depth against a stale cached copy talking to an older backend, and against
 * data-* attributes that never pass through the server. Two copies of one
 * rule drift, so this suite runs both copies over the same table and requires
 * them to agree, and checks that boot() actually applies them.
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

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const WIDGET = path.join(REPO_ROOT, "widget.js");
const src = fs.readFileSync(WIDGET, "utf8");

// Lift a top-level function out of the widget by its source, balancing
// braces. Throws rather than returning nothing: a rename must fail here, not
// leave the assertions below running against an empty stub.
function extract(name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + "() not found in widget.js — update this extractor, do not delete the test.");
  let depth = 0, i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}
const widget = new Function(extract("safeHttpUrl") + "\n" + extract("safeHexColor") +
  "\nreturn { safeHttpUrl: safeHttpUrl, safeHexColor: safeHexColor };")();
const server = loadTs("url-safety.ts");

const URL_CASES = [
  "https://example.com/book", " http://example.com/a?b=c ", "HTTPS://EXAMPLE.COM",
  "javascript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,x",
  "//evil.example", "/path", 'https://e.com/"onmouseover="x', "https://e.com/<b>",
  "https://e .com", "https://", "", null, undefined, 3, {},
  "https://example.com/" + "a".repeat(480), "https://example.com/" + "a".repeat(481),
];
const COLOUR_CASES = ["#2f3a4a", " #ABCDEF ", "#abc", "red", "#000000}body{x", "", null, 1];

test("widget and server agree on every URL", () => {
  for (const c of URL_CASES) {
    assert.strictEqual(widget.safeHttpUrl(c), server.safeHttpUrl(c), JSON.stringify(c));
  }
});

test("widget and server agree on every colour", () => {
  for (const c of COLOUR_CASES) {
    assert.strictEqual(widget.safeHexColor(c), server.safeHexColor(c), JSON.stringify(c));
  }
});

test("the widget never yields a non-http(s) link", () => {
  for (const c of URL_CASES) {
    const out = widget.safeHttpUrl(c);
    assert.ok(out === null || /^https?:\/\//i.test(out), JSON.stringify(c));
  }
});

test("boot() sanitises config before anything renders it", () => {
  const boot = extract("boot");
  for (const line of [
    "CFG.booking_url = safeHttpUrl(CFG.booking_url)",
    "CFG.contact_url = safeHttpUrl(CFG.contact_url)",
    "CFG.logo_url = safeHttpUrl(CFG.logo_url)",
    "CFG.widget_color = safeHexColor(CFG.widget_color)",
  ]) {
    assert.ok(boot.includes(line), "boot() should contain: " + line);
  }
  // And before the first use of the colour, not after.
  assert.ok(boot.indexOf("safeHexColor(CFG.widget_color)") < boot.indexOf("var C = "),
    "the colour must be validated before it is read into C");
});
