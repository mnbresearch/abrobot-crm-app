/**
 * whatsAppCredentialSource() — the word the Integrations status shows for
 * whose WhatsApp number a send would use. It must agree with the resolver
 * the sender actually uses, so it is tested against the same scenarios as
 * whatsapp-creds.test.cjs, including the cross-tenant refusal.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
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

// Bundled, not transformed: whatsapp.ts imports ./http.ts. Written to a temp
// dir so nothing lands in the repo. A bundling failure is a real failure.
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-src-")), "b.cjs");
es.buildSync({
  entryPoints: [path.join(__dirname, "whatsapp.ts")],
  bundle: true, format: "cjs", platform: "node", outfile: out, logLevel: "silent",
});
globalThis.Deno = { env: { get: () => "" } };   // read at import time
const { whatsAppCredentialSource: source } = require(out);

const PLATFORM = { token: "PLATFORM_TOKEN", phoneId: "111_platform" };

test("own token and phone id → own", () => {
  assert.strictEqual(source({ whatsapp_token: "T", whatsapp_phone_id: "222" }, PLATFORM), "own");
});

test("no token, no phone id, platform configured → platform", () => {
  assert.strictEqual(source({}, PLATFORM), "platform");
  assert.strictEqual(source({ whatsapp_token: "  ", whatsapp_phone_id: "" }, PLATFORM), "platform");
});

test("no token but the platform's own phone id → platform", () => {
  assert.strictEqual(source({ whatsapp_phone_id: "111_platform" }, PLATFORM), "platform");
});

test("no token and ANOTHER phone id → refused, never platform", () => {
  assert.strictEqual(source({ whatsapp_phone_id: "999_another_tenant" }, PLATFORM), "refused");
});

test("nothing anywhere → none; own token without phone id → none", () => {
  assert.strictEqual(source({}, { token: "", phoneId: "" }), "none");
  assert.strictEqual(source({ whatsapp_token: "T" }, PLATFORM), "none");
});

test("platform token without a platform phone id → refused", () => {
  assert.strictEqual(source({}, { token: "PLATFORM_TOKEN", phoneId: "" }), "refused");
});
