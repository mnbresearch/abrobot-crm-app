/**
 * Native adapters for lead marketplaces and ad platforms.
 *
 * WHY THIS EXISTS
 * ───────────────
 * FEATURES.md described the capture URL as something "a customer can paste into
 * a capture form, Zapier, Meta lead ads, IndiaMART". The intake code had no
 * adapter for either named platform:
 *
 *   IndiaMART  posts SENDER_NAME / SENDER_MOBILE / QUERY_MESSAGE (upper case,
 *              usually wrapped in RESPONSE). extractLead read none of them, found
 *              no email or phone, and answered 422 — every IndiaMART enquiry lost.
 *   Meta       a Lead Ads webhook carries NO contact data at all: only a
 *              leadgen_id that has to be fetched from the Graph API with a page
 *              token and the leads_retrieval permission. A capture URL cannot
 *              receive Meta leads natively, however it is written.
 *
 * Google Ads lead forms (user_column_data[]), JustDial and TradeIndia were not
 * handled either. Each adapter below maps one provider's documented payload onto
 * the flat {name, email, phone, message} shape the existing intake path already
 * validates, normalises, dedupes and scores — so nothing downstream changes.
 *
 * Pure and dependency-free: unit-tested from Node in sources.test.cjs.
 */

export type Provider = "indiamart" | "justdial" | "tradeindia" | "google_ads" | "meta_ads";

export interface Adapted {
  provider: Provider;
  /** The flat shape extractLead understands. */
  flat: Record<string, unknown>;
  /** The provider's own id for the enquiry, for tracing a lead back. */
  externalId: string | null;
  /** Google Ads only: the key Google sends so the receiver can verify it. */
  googleKey?: string | null;
  /** Set when the payload is recognised but cannot be ingested here. */
  unsupported?: string;
}

// deno-lint-ignore no-explicit-any
type Any = any;

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());
const firstNonEmpty = (...vs: unknown[]): string => {
  for (const v of vs) { const s = str(v); if (s) return s; }
  return "";
};

/**
 * Parse a request body that may be JSON or form-encoded.
 *
 * The endpoint used to call JSON.parse unconditionally and answer
 * "400 invalid JSON" to anything else. That made the Twilio WhatsApp branch in
 * extractLead dead code — Twilio only ever sends application/x-www-form-urlencoded
 * — and rejected plain HTML <form> posts and the providers that post form data.
 *
 * JSON behaviour is unchanged: a JSON content type, or a body that starts with
 * `{`, is parsed exactly as before and still throws on malformed JSON.
 */
export function parseBody(text: string, contentType: string | null): unknown {
  const ct = (contentType ?? "").toLowerCase();
  const trimmed = text.trimStart();
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  // Body shape decides before content type: curl -d and many PHP posters send
  // a JSON string labelled application/x-www-form-urlencoded, and that has
  // always been parsed as JSON here.
  if (looksJson) return JSON.parse(text);
  if (ct.includes("application/x-www-form-urlencoded") || (!ct.includes("json") && text.includes("="))) {
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text)) out[k] = v;
    return out;
  }
  return JSON.parse(text);
}

/** Lines of "Label: value" for details that have no column of their own. */
function details(pairs: [string, unknown][]): string {
  return pairs.map(([k, v]) => [k, str(v)]).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n");
}

function meta(body: Any): Adapted | null {
  const ch = body?.entry?.[0]?.changes?.[0];
  // Distinct from the WhatsApp Cloud API payload, which shares the entry/changes
  // envelope but carries field "messages". Only "leadgen" is a Lead Ads event.
  if (body?.object !== "page" || ch?.field !== "leadgen") return null;
  return {
    provider: "meta_ads",
    flat: {},
    externalId: str(ch?.value?.leadgen_id) || null,
    unsupported:
      "Meta Lead Ads webhooks contain no contact details — only a leadgen_id that must be " +
      "fetched from Meta's Graph API with a page token. Connect Meta through Zapier " +
      "(Facebook Lead Ads → Webhooks by Zapier → POST to this URL) instead.",
  };
}

function googleAds(body: Any): Adapted | null {
  if (!Array.isArray(body?.user_column_data)) return null;
  const col: Record<string, string> = {};
  const other: [string, unknown][] = [];
  for (const c of body.user_column_data) {
    const id = str(c?.column_id).toUpperCase();
    const v = str(c?.string_value);
    if (!id || !v) continue;
    col[id] = v;
    if (!["FULL_NAME", "FIRST_NAME", "LAST_NAME", "EMAIL", "WORK_EMAIL", "PHONE_NUMBER", "WORK_PHONE"].includes(id)) {
      other.push([str(c?.column_name) || id.replace(/_/g, " ").toLowerCase(), v]);
    }
  }
  const name = col.FULL_NAME || [col.FIRST_NAME, col.LAST_NAME].filter(Boolean).join(" ");
  return {
    provider: "google_ads",
    flat: {
      name,
      email: col.EMAIL || col.WORK_EMAIL || null,
      phone: col.PHONE_NUMBER || col.WORK_PHONE || null,
      message: details([["Google Ads lead form", body.form_id ? `form ${body.form_id}` : ""], ...other,
        ["Campaign", body.campaign_id]]),
    },
    externalId: str(body.lead_id) || null,
    googleKey: str(body.google_key) || null,
  };
}

function indiaMart(body: Any): Adapted | null {
  // Push API wraps the lead in RESPONSE; some relays send it flat. The Pull API
  // returns an array — take the first if one is ever forwarded here.
  let r = body?.RESPONSE ?? body;
  if (Array.isArray(r)) r = r[0];
  if (!r || typeof r !== "object") return null;
  if (!("SENDER_MOBILE" in r || "SENDER_NAME" in r || "UNIQUE_QUERY_ID" in r)) return null;
  return {
    provider: "indiamart",
    flat: {
      name: str(r.SENDER_NAME),
      email: firstNonEmpty(r.SENDER_EMAIL, r.SENDER_EMAIL_ALT) || null,
      phone: firstNonEmpty(r.SENDER_MOBILE, r.SENDER_MOBILE_ALT, r.SENDER_PHONE, r.SENDER_PHONE_ALT) || null,
      message: details([
        ["Subject", r.SUBJECT],
        ["Product", r.QUERY_PRODUCT_NAME],
        ["Message", r.QUERY_MESSAGE],
        ["Company", r.SENDER_COMPANY],
        ["City", [str(r.SENDER_CITY), str(r.SENDER_STATE)].filter(Boolean).join(", ")],
        ["Enquiry type", r.QUERY_TYPE],
        // In the message, NOT `country`: extractLead maps `country` onto
        // target_country, which in this product means the study DESTINATION.
        // A buyer's own country stored there would read as their intended one.
        ["Buyer country", r.SENDER_COUNTRY_ISO],
      ]),
    },
    externalId: str(r.UNIQUE_QUERY_ID) || null,
  };
}

function tradeIndia(body: Any, hint: string): Adapted | null {
  // Lower-case sender_* fields. Checked AFTER IndiaMART, whose fields are
  // upper case, so the two cannot be confused.
  // A lone sender_name is not distinctive enough; require TradeIndia's own
  // rfi_id with a sender field, or a key explicitly marked TradeIndia.
  if (!body) return null;
  const hasSender = "sender_mobile" in body || "sender_name" in body;
  if (!(hint === "tradeindia" ? hasSender || "rfi_id" in body : "rfi_id" in body && hasSender)) return null;
  return {
    provider: "tradeindia",
    flat: {
      name: str(body.sender_name),
      email: str(body.sender_email) || null,
      phone: firstNonEmpty(body.sender_mobile, body.sender_other_mobiles) || null,
      message: details([
        ["Subject", body.subject],
        ["Product", body.product_name],
        ["Message", body.message],
        ["Company", body.sender_co],
        ["City", body.sender_city],
      ]),
    },
    externalId: str(body.rfi_id) || null,
  };
}

function justDial(body: Any, hint: string): Adapted | null {
  // `leadid` is JustDial's own field and distinctive. `mobile` + `area` alone is
  // NOT — plenty of ordinary Indian website forms post exactly those — so without
  // a leadid this only fires when the capture key itself is marked as JustDial.
  if (!body || !(("leadid" in body && "mobile" in body) || (hint === "justdial" && "mobile" in body))) return null;
  const name = [str(body.prefix), str(body.name)].filter(Boolean).join(" ");
  return {
    provider: "justdial",
    flat: {
      name,
      email: str(body.email) || null,
      phone: firstNonEmpty(body.mobile, body.phone) || null,
      message: details([
        ["Category", body.category],
        ["Area", [str(body.area), str(body.city)].filter(Boolean).join(", ")],
        ["Company", body.company],
        ["Enquiry", body.leadtype],
      ]),
    },
    externalId: str(body.leadid) || null,
  };
}

/**
 * Recognise a provider payload and adapt it, or return null so the existing
 * generic path handles it exactly as before. Order matters: Meta before the
 * generic envelope checks, IndiaMART (upper case) before TradeIndia (lower case).
 */
export function adaptPayload(body: unknown, hint = ""): Adapted | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return meta(body) ?? googleAds(body) ?? indiaMart(body) ?? tradeIndia(body, hint) ?? justDial(body, hint);
}
