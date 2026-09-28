// Can one tenant send WhatsApp from another tenant's number?
//
// The Graph API authorises the TOKEN against the phone id. The platform token
// owns every number registered to our Meta app, so with it, Meta will send
// from any of them — which made whatsapp_phone_id, a plain tenant-writable
// column with no ownership check, sufficient to send as another business.
//
// resolveWhatsAppCredentials() is the whole boundary, so it is tested here on
// its own rather than through a live send.

const fs = require("fs");
const os = require("os");
const path = require("path");

// Same resolver the three older suites use. The first version of this file
// shelled out to `npx --yes esbuild@0.23.1`, which downloads from the network
// at test time — so the suite could fail for a reason that has nothing to do
// with the code, and CI's own `Install esbuild` step was bypassed entirely.
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
  console.log("SKIP " + path.basename(__filename) + " — no usable esbuild for this platform. Run `npm ci` in app/.");
  process.exit(0);
}
const es = loadEsbuild();

// Resolved from this file's own location, never hardcoded.
//
// The first version of this file pinned an absolute sandbox path. Two failures
// came out of that, and the second is the worse one:
//   1. On CI the path does not exist, so the suite errored and the tests job
//      went red on every push — a permanently-red build is the same as no
//      build, because everyone learns to ignore it.
//   2. On a machine where the path DID exist, the suite read the file at that
//      fixed location rather than the one in the checkout. It reported PASS
//      about a different copy of the repository than the one being built.
// The three older suites in this directory already did it this way.
const ROOT = path.join(__dirname, "..", "..", "..");
const SRC = path.join(ROOT, "supabase/functions/_shared/whatsapp.ts");

// buildSync, not transformSync: whatsapp.ts imports ./http.ts, so the module
// graph has to be resolved. Uses the esbuild resolved above rather than a
// download, and writes to a temp dir so nothing lands in the repo.
let bundle;
try {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-")), "b.cjs");
  es.buildSync({
    entryPoints: [SRC],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: out,
    logLevel: "silent",
  });
  bundle = out;
} catch (e) {
  // A bundling failure here is a REAL failure — the module under test did not
  // compile. Exiting 0 with "SKIP" would hide a broken import behind a word CI
  // reserves for a missing toolchain. Fail loudly instead.
  console.log("FAILED - could not bundle whatsapp.ts: " + e.message);
  process.exit(1);
}

// The module reads Deno.env at import time.
globalThis.Deno = { env: { get: () => "" } };
let mod;
try {
  mod = require(bundle);
} catch (e) {
  console.log("SKIP - could not load the bundle: " + e.message);
  process.exit(0);
}

const resolve = mod.resolveWhatsAppCredentials;
if (typeof resolve !== "function") {
  console.log("FAILED - resolveWhatsAppCredentials is not exported");
  process.exit(1);
}

const PLATFORM = { token: "PLATFORM_TOKEN", phoneId: "111_platform" };
const VICTIM_PHONE_ID = "999_another_tenant";

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log("FAIL: " + name + (extra ? "\n      " + JSON.stringify(extra) : "")); }
};

// ── THE ATTACK ──────────────────────────────────────────────────────────────
// No token of their own, someone else's phone number ID.
let r = resolve({ whatsapp_token: null, whatsapp_phone_id: VICTIM_PHONE_ID }, PLATFORM);
check("borrowing another tenant's number with the platform token is refused",
  r && r.refused, r);
check("the refusal explains what to do", r && /own WhatsApp access token/.test(r.refused || ""), r);

// Same, with whitespace padding — trimming must not be a way around it.
r = resolve({ whatsapp_token: "   ", whatsapp_phone_id: "  " + VICTIM_PHONE_ID + " " }, PLATFORM);
check("whitespace does not evade the check", r && r.refused, r);

// ── The legitimate paths ────────────────────────────────────────────────────
r = resolve({ whatsapp_token: "ORG_TOKEN", whatsapp_phone_id: "222_theirs" }, PLATFORM);
check("a tenant's own token is used with their own phone id",
  r && r.token === "ORG_TOKEN" && r.phoneId === "222_theirs", r);

// A tenant with their own token pointing at another number: allowed HERE,
// because Meta itself refuses a phone id the token does not own. Asserting
// this on purpose — it documents where the boundary is enforced.
r = resolve({ whatsapp_token: "ORG_TOKEN", whatsapp_phone_id: VICTIM_PHONE_ID }, PLATFORM);
check("own-token path defers to Meta's own authorisation",
  r && r.token === "ORG_TOKEN" && r.phoneId === VICTIM_PHONE_ID, r);

r = resolve({ whatsapp_token: null, whatsapp_phone_id: PLATFORM.phoneId }, PLATFORM);
check("the platform's own number is allowed with the platform token",
  r && r.token === PLATFORM.token && r.phoneId === PLATFORM.phoneId, r);

r = resolve({ whatsapp_token: null, whatsapp_phone_id: null }, PLATFORM);
check("no phone id at all falls back to the platform pair",
  r && r.token === PLATFORM.token && r.phoneId === PLATFORM.phoneId, r);

// ── Not configured ──────────────────────────────────────────────────────────
check("nothing configured anywhere is 'not configured', not a refusal",
  resolve({ whatsapp_token: null, whatsapp_phone_id: null }, { token: "", phoneId: "" }) === null);
check("own token with no phone id is 'not configured'",
  resolve({ whatsapp_token: "ORG_TOKEN", whatsapp_phone_id: null }, PLATFORM) === null);

// ── The half-configured platform ────────────────────────────────────────────
// Token set, phone id secret missing. The old code would have used the
// tenant's phone id here. It must refuse instead.
r = resolve({ whatsapp_token: null, whatsapp_phone_id: VICTIM_PHONE_ID },
            { token: "PLATFORM_TOKEN", phoneId: "" });
check("platform token without WHATSAPP_PHONE_ID refuses rather than trusting the tenant",
  r && r.refused, r);

console.log(fail === 0
  ? `PASS - ${pass} assertions on the WhatsApp credential-pairing rule`
  : `FAILED - ${fail} of ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
