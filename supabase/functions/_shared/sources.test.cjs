/**
 * Tests for the marketplace / ad-platform adapters in sources.ts.
 *
 * Payloads follow each provider's published webhook format:
 *   IndiaMART  Lead Manager CRM Push API (SENDER_* / QUERY_* / UNIQUE_QUERY_ID)
 *   Google Ads lead form webhook (lead_id, user_column_data[], google_key)
 *   Meta       Lead Ads "leadgen" webhook (entry[].changes[].value.leadgen_id)
 *
 * JustDial and TradeIndia field names are from their commonly documented push
 * formats; confirm against the first live lead from each before relying on them.
 *
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
const js = es.transformSync(fs.readFileSync(path.join(__dirname, "sources.ts"), "utf8"),
  { loader: "ts", format: "cjs" }).code;
const m = { exports: {} };
new Function("module", "exports", "require", js)(m, m.exports, (s) => { throw new Error("unexpected import " + s); });
const { adaptPayload, parseBody } = m.exports;

test("IndiaMART push, wrapped in RESPONSE", () => {
  const a = adaptPayload({
    CODE: 200, STATUS: "SUCCESS",
    RESPONSE: {
      UNIQUE_QUERY_ID: "2564822112", QUERY_TYPE: "W",
      SENDER_NAME: "Rahul Verma", SENDER_MOBILE: "+91-9876543210",
      SENDER_EMAIL: "rahul@example.com", SUBJECT: "Requirement for steel pipes",
      SENDER_COMPANY: "Verma Traders", SENDER_CITY: "Ludhiana", SENDER_STATE: "Punjab",
      SENDER_COUNTRY_ISO: "IN", QUERY_PRODUCT_NAME: "MS Pipe", QUERY_MESSAGE: "Need 2 tonnes, quote please",
    },
  });
  assert.strictEqual(a.provider, "indiamart");
  assert.strictEqual(a.flat.name, "Rahul Verma");
  assert.strictEqual(a.flat.email, "rahul@example.com");
  assert.strictEqual(a.flat.phone, "+91-9876543210", "raw — normPhone runs later in extractLead");
  assert.strictEqual(a.externalId, "2564822112");
  for (const want of ["MS Pipe", "Need 2 tonnes", "Verma Traders", "Ludhiana, Punjab"]) {
    assert.ok(a.flat.message.includes(want), `message should include "${want}"`);
  }
  assert.ok(!("country" in a.flat),
    "the buyer's country must not go in `country` — extractLead maps that to target_country (study destination)");
});

test("IndiaMART flat payload, and fallback to the alternate mobile", () => {
  const a = adaptPayload({ SENDER_NAME: "Asha", SENDER_MOBILE: "", SENDER_MOBILE_ALT: "9811111111", QUERY_MESSAGE: "hi" });
  assert.strictEqual(a.provider, "indiamart");
  assert.strictEqual(a.flat.phone, "9811111111");
});

test("Google Ads lead form", () => {
  const a = adaptPayload({
    lead_id: "TeSter-123-ABCDEFGHIJKLMNOPQRSTUVWXYZ", api_version: "1.0",
    form_id: 40000000000, campaign_id: 50000000000, google_key: "secret-key",
    user_column_data: [
      { column_name: "Full Name", string_value: "Priya Sharma", column_id: "FULL_NAME" },
      { column_name: "User Email", string_value: "priya@example.com", column_id: "EMAIL" },
      { column_name: "User Phone", string_value: "+919876543210", column_id: "PHONE_NUMBER" },
      { column_name: "Which course?", string_value: "MBA", column_id: "QUESTION_1" },
    ],
  });
  assert.strictEqual(a.provider, "google_ads");
  assert.strictEqual(a.flat.name, "Priya Sharma");
  assert.strictEqual(a.flat.email, "priya@example.com");
  assert.strictEqual(a.flat.phone, "+919876543210");
  assert.strictEqual(a.googleKey, "secret-key");
  assert.ok(a.flat.message.includes("Which course?: MBA"), "custom questions must not be dropped");
});

test("Google Ads with first and last name instead of full name", () => {
  const a = adaptPayload({ user_column_data: [
    { column_id: "FIRST_NAME", string_value: "Ravi" }, { column_id: "LAST_NAME", string_value: "Kumar" },
    { column_id: "PHONE_NUMBER", string_value: "9876543210" },
  ] });
  assert.strictEqual(a.flat.name, "Ravi Kumar");
});

test("Meta Lead Ads is recognised and refused with guidance, not silently lost", () => {
  const a = adaptPayload({
    object: "page",
    entry: [{ id: "1", time: 1, changes: [{ field: "leadgen",
      value: { leadgen_id: "444444444", page_id: "1", form_id: "2", created_time: 1 } }] }],
  });
  assert.strictEqual(a.provider, "meta_ads");
  assert.ok(a.unsupported && /Zapier/.test(a.unsupported), "must tell the user what to do instead");
  assert.strictEqual(a.externalId, "444444444");
});

test("a WhatsApp Cloud API payload is NOT mistaken for Meta Lead Ads", () => {
  // Same entry/changes envelope, different field. The existing WhatsApp branch
  // in extractLead must keep receiving these.
  const a = adaptPayload({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { messages: [{ from: "919876543210", text: { body: "hi" } }] } }] }],
  });
  assert.strictEqual(a, null);
});

test("TradeIndia", () => {
  const a = adaptPayload({ rfi_id: "77", sender_name: "Kiran", sender_mobile: "9123456780",
    sender_email: "k@example.com", subject: "Bulk order", sender_city: "Surat" });
  assert.strictEqual(a.provider, "tradeindia");
  assert.strictEqual(a.flat.phone, "9123456780");
  assert.ok(a.flat.message.includes("Surat"));
});

test("JustDial with its own leadid", () => {
  const a = adaptPayload({ leadid: "JD123", prefix: "Mr", name: "Sunil", mobile: "9988776655",
    category: "Overseas Education Consultants", area: "Karol Bagh", city: "Delhi" });
  assert.strictEqual(a.provider, "justdial");
  assert.strictEqual(a.flat.name, "Mr Sunil");
  assert.strictEqual(a.flat.phone, "9988776655");
  assert.ok(a.flat.message.includes("Overseas Education Consultants"));
});

test("an ordinary website form with mobile + area is NOT classified as JustDial", () => {
  const form = { name: "Neha", mobile: "9876500000", area: "Andheri" };
  assert.strictEqual(adaptPayload(form, "website"), null,
    "no leadid and the key is not marked JustDial — this is a normal form");
  assert.strictEqual(adaptPayload(form, "justdial").provider, "justdial",
    "but if the capture key IS marked JustDial, trust it");
});

test("generic payloads fall through to the existing path untouched", () => {
  assert.strictEqual(adaptPayload({ name: "A", email: "a@b.co", phone: "9876543210" }), null);
  assert.strictEqual(adaptPayload(null), null);
  assert.strictEqual(adaptPayload([1, 2]), null);
});

test("parseBody: form-encoded, which used to be rejected as invalid JSON", () => {
  const twilio = parseBody("From=whatsapp%3A%2B919876543210&Body=Hello&ProfileName=Asha",
    "application/x-www-form-urlencoded");
  assert.strictEqual(twilio.From, "whatsapp:+919876543210",
    "Twilio only sends form-encoded — this is what revives the dead WhatsApp branch");
  assert.strictEqual(twilio.Body, "Hello");

  const htmlForm = parseBody("name=Ravi&mobile=9876543210", null);
  assert.strictEqual(htmlForm.mobile, "9876543210", "no content-type, key=value body → form");
});

test("parseBody: JSON labelled as form-encoded is still JSON (curl -d default)", () => {
  assert.deepStrictEqual(parseBody('{"name":"A","email":"a@b.com"}', "application/x-www-form-urlencoded"),
    { name: "A", email: "a@b.com" });
});

test("weak provider signals do not hijack a generic payload", () => {
  assert.strictEqual(adaptPayload({ leadid: "9", full_name: "Bob", phone_number: "9876543210" }), null,
    "leadid without JustDial's mobile field is a generic form");
  assert.strictEqual(adaptPayload({ sender_name: "Bob", email: "b@x.co" }), null,
    "a lone sender_name is not TradeIndia");
  assert.strictEqual(adaptPayload({ sender_name: "Bob", sender_mobile: "9876543210" }, "tradeindia").provider,
    "tradeindia", "but on a key marked TradeIndia it is");
});

test("parseBody: JSON behaviour is unchanged", () => {
  assert.deepStrictEqual(parseBody('{"a":1}', "application/json"), { a: 1 });
  assert.deepStrictEqual(parseBody('{"a":1}', null), { a: 1 });
  assert.throws(() => parseBody('{"a":', "application/json"), "malformed JSON must still be rejected");
  assert.throws(() => parseBody("{not json", null));
});
