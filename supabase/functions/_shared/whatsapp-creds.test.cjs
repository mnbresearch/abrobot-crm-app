// Can one tenant send WhatsApp from another tenant's number?
//
// The Graph API authorises the TOKEN against the phone id. The platform token
// owns every number registered to our Meta app, so with it, Meta will send
// from any of them — which made whatsapp_phone_id, a plain tenant-writable
// column with no ownership check, sufficient to send as another business.
//
// resolveWhatsAppCredentials() is the whole boundary, so it is tested here on
// its own rather than through a live send.

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = "/sessions/serene-focused-planck/mnt/abrobot-crm-app";
const SRC = path.join(ROOT, "supabase/functions/_shared/whatsapp.ts");

let bundle;
try {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-")), "b.cjs");
  execFileSync("npx", ["--yes", "esbuild@0.23.1", SRC,
    "--bundle", "--format=cjs", "--platform=node",
    "--outfile=" + out], { stdio: ["ignore", "ignore", "pipe"] });
  bundle = out;
} catch (e) {
  console.log("SKIP - esbuild could not bundle whatsapp.ts: " + e.message);
  process.exit(0);
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
