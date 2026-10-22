// Svix webhook signature verification (Resend signs its webhooks with Svix),
// plus the pure parts of interpreting a Resend email event.
//
// Pure: no env reads, no network, no Deno globals. WebCrypto only, so the same
// code runs in the edge runtime and under Node 20+ in svix.test.cjs.
//
// Scheme (https://docs.svix.com/receiving/verifying-payloads/how-manual):
//   headers   svix-id, svix-timestamp (unix seconds), svix-signature
//   signature space-separated list of "<version>,<base64>"; only v1 is HMAC
//   secret    "whsec_<base64>" — the KEY is the base64-decoded bytes, not the
//             string
//   content   `${svix-id}.${svix-timestamp}.${rawBody}`
//   mac       base64(HMAC-SHA256(key, content))
//
// Properties that matter:
//   * the exact raw body is verified, never re-serialised JSON
//   * timestamp must be within ±5 minutes — a captured request cannot be
//     replayed later
//   * constant-time comparison of the MAC bytes
//   * any malformed input (secret, timestamp, header) fails closed

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export type SvixInput = {
  /** The configured secret, "whsec_<base64>" (a bare base64 key is accepted too). */
  secret: string | null | undefined;
  id: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  /** The request body exactly as received. */
  body: string;
  /** Override "now" (unix seconds) — for tests. */
  nowSeconds?: number;
  toleranceSeconds?: number;
};

export type SvixResult = { ok: true } | { ok: false; reason: string };

function b64decode(s: string): Uint8Array<ArrayBuffer> | null {
  if (!s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Constant-time over the bytes. Length is not secret (always 32 for v1). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifySvix(input: SvixInput): Promise<SvixResult> {
  const secret = (input.secret ?? "").trim();
  if (!secret) return { ok: false, reason: "secret not configured" };
  const key = b64decode(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  if (!key || key.length === 0) return { ok: false, reason: "secret is not valid base64" };

  const id = input.id ?? "";
  const ts = input.timestamp ?? "";
  const sigHeader = input.signature ?? "";
  if (!id || !ts || !sigHeader) return { ok: false, reason: "missing svix headers" };
  if (id.length > 256 || sigHeader.length > 4096) return { ok: false, reason: "oversized svix header" };

  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: "malformed svix-timestamp" };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(ts)) > tolerance) {
    return { ok: false, reason: `svix-timestamp outside the ${tolerance}s window` };
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`${id}.${ts}.${input.body}`)),
  );

  // Check every v1 entry without exiting early, so timing does not reveal
  // which (if any) of several signatures matched.
  let matched = false;
  for (const part of sigHeader.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    if (part.slice(0, comma) !== "v1") continue;
    const candidate = b64decode(part.slice(comma + 1));
    if (candidate && bytesEqual(mac, candidate)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

// ── Resend event interpretation ─────────────────────────────────────────────

export type SuppressionReason = "bounced" | "complained";

export type ResendAction =
  | { action: "suppress"; reason: SuppressionReason; recipients: string[] }
  | { action: "ignore"; why: string };

// Resend's bounce object is { type, subType, message } with type one of
// "Permanent" | "Transient" | "Undetermined" (SES vocabulary). Only clearly
// temporary bounces are skipped; anything unrecognised — including
// "Undetermined" or a missing field — is treated as hard, because mailing a
// dead address again is what damages sender reputation.
const SOFT_BOUNCE = new Set(["transient", "soft", "temporary"]);

export function isHardBounce(data: unknown): boolean {
  const d = (data && typeof data === "object") ? data as Record<string, unknown> : {};
  const bounce = (d.bounce && typeof d.bounce === "object") ? d.bounce as Record<string, unknown> : {};
  const raw = bounce.type ?? bounce.bounceType ?? d.bounce_type ?? d.bounceType;
  if (typeof raw !== "string" || !raw.trim()) return true;
  return !SOFT_BOUNCE.has(raw.trim().toLowerCase());
}

/** Lower-cased, de-duplicated plain addresses from data.to (array or string).
 *  Accepts "Name <a@b.com>" and drops anything that is not an address. */
export function recipientsOf(data: unknown): string[] {
  const d = (data && typeof data === "object") ? data as Record<string, unknown> : {};
  const list = Array.isArray(d.to) ? d.to : (typeof d.to === "string" ? d.to.split(",") : []);
  const out = new Set<string>();
  for (const v of list) {
    if (typeof v !== "string") continue;
    let s = v.trim();
    const angle = s.match(/<([^<>]+)>\s*$/);
    if (angle) s = angle[1].trim();
    s = s.toLowerCase();
    if (s.length > 320 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s)) continue;
    out.add(s);
  }
  return [...out];
}

export function classifyResendEvent(event: unknown): ResendAction {
  const e = (event && typeof event === "object") ? event as Record<string, unknown> : {};
  const type = typeof e.type === "string" ? e.type : "";
  let reason: SuppressionReason;
  if (type === "email.complained") {
    reason = "complained";
  } else if (type === "email.bounced") {
    if (!isHardBounce(e.data)) return { action: "ignore", why: "soft bounce" };
    reason = "bounced";
  } else {
    return { action: "ignore", why: `event type ${type || "(none)"} not handled` };
  }
  const recipients = recipientsOf(e.data);
  if (recipients.length === 0) return { action: "ignore", why: "no valid recipients" };
  return { action: "suppress", reason, recipients };
}
