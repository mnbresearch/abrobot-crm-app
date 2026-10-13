/**
 * The Content-Security-Policy in _headers must allow every origin the app
 * actually loads code from or talks to.
 *
 * Why this exists: the first CSP (4 October 2026) was enumerated from
 * app/index.html only. Settings.tsx injects the Cashfree SDK at runtime, so the
 * policy blocked it and the Upgrade button could not take a payment from that
 * deploy on. Nothing failed loudly — a CSP violation is a console line in the
 * customer's browser. This test makes the same omission fail the build.
 *
 * Heuristic, deliberately simple: any https:// origin in app/src that appears
 * on a line which loads or calls something (script src, fetch, sdk, frame) must
 * be matched by script-src, connect-src or frame-src.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function cspDirectives() {
  const line = fs.readFileSync(path.join(root, "_headers"), "utf8")
    .split("\n").find((l) => /^\s*Content-Security-Policy:/.test(l));
  assert.ok(line, "_headers must carry a Content-Security-Policy");
  const out = {};
  for (const part of line.replace(/^\s*Content-Security-Policy:\s*/, "").split(";")) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) out[name] = vals;
  }
  return out;
}

function allows(sources, origin) {
  const host = new URL(origin).host;
  return (sources || []).some((s) => {
    if (s === "https:") return true;
    if (!/^https:\/\//.test(s)) return false;
    const h = new URL(s).host;
    if (h.startsWith("*.")) return host.endsWith(h.slice(1));
    return h === host;
  });
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}

// Example and outbound-link origins: shown to users or navigated to, never
// loaded by the app itself.
const NOT_LOADED = new Set(["yoursite.com", "yoursystem.com", "wa.me", "crm.mnbresearch.com"]);

test("CSP allows every runtime script / fetch / frame origin used by the app", () => {
  const csp = cspDirectives();
  const missing = [];
  for (const file of walk(path.join(root, "app", "src")).filter((f) => /\.(t|j)sx?$/.test(f))) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((l, i) => {
      const ctx = (lines[i - 1] || "") + "\n" + l;
      if (!/script|fetch\(|\.src\b|sdk|iframe|frame/i.test(ctx)) return;
      for (const m of l.matchAll(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi)) {
        const origin = m[0];
        if (NOT_LOADED.has(new URL(origin).host)) continue;
        if (!(allows(csp["script-src"], origin) || allows(csp["connect-src"], origin) || allows(csp["frame-src"], origin))) {
          missing.push(`${path.relative(root, file)}:${i + 1} ${origin}`);
        }
      }
    });
  }
  assert.deepStrictEqual(missing, [], "origins the CSP would block:\n" + missing.join("\n"));
});

test("the Cashfree checkout path specifically is allowed end to end", () => {
  const csp = cspDirectives();
  assert.ok(allows(csp["script-src"], "https://sdk.cashfree.com"), "SDK script");
  assert.ok(allows(csp["connect-src"], "https://api.cashfree.com"), "SDK API calls");
  assert.ok(allows(csp["form-action"], "https://payments.cashfree.com"), "redirect checkout form post");
  assert.ok(allows(csp["frame-src"], "https://payments.cashfree.com"), "modal checkout frame");
});

test("the policy still locks down what it was added to lock down", () => {
  const csp = cspDirectives();
  assert.deepStrictEqual(csp["frame-ancestors"], ["'none'"]);
  assert.deepStrictEqual(csp["object-src"], ["'none'"]);
  assert.ok(!csp["script-src"].includes("https:"), "script-src must not allow any https origin");
  assert.ok(!csp["connect-src"].includes("https:"), "connect-src must not allow any https origin");
});
