/**
 * Request validation for the public REST API.
 *
 * Pure and dependency-free so it is unit-tested from Node (api-validate.test.cjs).
 *
 * WHY THIS EXISTS
 * ───────────────
 * PATCH /leads/:id copied allow-listed fields straight from the body into the
 * update. The allow-list stopped a caller writing org_id, but nothing checked
 * what the allowed fields CONTAINED:
 *
 *   assigned_to  any uuid — including a user in another organisation, which
 *                put a cross-tenant id on the record and made it vanish from
 *                every counsellor's list in the owning org
 *   score        any value — 5000, -3, "hot"
 *   email/phone  stored as sent, so "Priya@X.com" no longer deduped against
 *                "priya@x.com" captured by the widget
 *   tags/custom  any shape and any size
 *
 * Postgres caught some of these as 500s that leaked the database's error text
 * to the integration. Each is now a 422 that says what is wrong.
 */

export const MAX_BODY_BYTES = 64 * 1024;
const MAX_CUSTOM_BYTES = 8 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PhoneNormaliser = (raw: unknown) => string | null;

export interface PatchResult {
  patch: Record<string, unknown>;
  errors: string[];
  /** Set when the caller asked to assign the record; the route must confirm membership. */
  assignTo?: string | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** Validate a PATCH /leads/:id body. Unknown fields are ignored, as before. */
export function validateLeadPatch(body: unknown, normPhone: PhoneNormaliser): PatchResult {
  const out: PatchResult = { patch: {}, errors: [] };
  if (!isPlainObject(body)) {
    out.errors.push("Body must be a JSON object");
    return out;
  }
  const b = body;

  if ("name" in b) {
    if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 200) {
      out.errors.push("name must be a non-empty string of at most 200 characters");
    } else out.patch.name = b.name.trim();
  }

  if ("email" in b) {
    if (b.email === null) out.patch.email = null;
    else if (typeof b.email !== "string" || !EMAIL_RE.test(b.email.trim()) || b.email.length > 254) {
      out.errors.push("email must be a valid address, or null");
    } else out.patch.email = b.email.trim().toLowerCase();
  }

  if ("phone" in b) {
    if (b.phone === null) out.patch.phone = null;
    else {
      const p = normPhone(b.phone);
      if (!p) out.errors.push("phone must be a valid number (with country code for non-Indian numbers), or null");
      else out.patch.phone = p;
    }
  }

  if ("stage_key" in b) {
    if (typeof b.stage_key !== "string" || !b.stage_key.trim() || b.stage_key.length > 64) {
      out.errors.push("stage_key must be a stage key string — GET /api/v1/stages lists them");
    } else out.patch.stage_key = b.stage_key.trim();
  }

  if ("score" in b) {
    if (typeof b.score !== "number" || !Number.isInteger(b.score) || b.score < 0 || b.score > 100) {
      out.errors.push("score must be an integer from 0 to 100");
    } else out.patch.score = b.score;
  }

  if ("assigned_to" in b) {
    if (b.assigned_to === null) { out.patch.assigned_to = null; out.assignTo = null; }
    else if (!isUuid(b.assigned_to)) out.errors.push("assigned_to must be a user id (uuid) or null");
    else { out.patch.assigned_to = b.assigned_to; out.assignTo = b.assigned_to; }
  }

  if ("tags" in b) {
    const t = b.tags;
    if (!Array.isArray(t) || t.length > 30 || !t.every((x) => typeof x === "string" && x.trim() && x.length <= 40)) {
      out.errors.push("tags must be an array of at most 30 non-empty strings, each at most 40 characters");
    } else out.patch.tags = [...new Set(t.map((x) => (x as string).trim()))];
  }

  if ("custom" in b) {
    if (!isPlainObject(b.custom)) out.errors.push("custom must be a JSON object");
    else if (JSON.stringify(b.custom).length > MAX_CUSTOM_BYTES) out.errors.push(`custom must be at most ${MAX_CUSTOM_BYTES} bytes`);
    else out.patch.custom = b.custom;
  }

  if ("next_follow_up_at" in b) {
    if (b.next_follow_up_at === null) out.patch.next_follow_up_at = null;
    else if (typeof b.next_follow_up_at !== "string" || Number.isNaN(Date.parse(b.next_follow_up_at))) {
      out.errors.push("next_follow_up_at must be an ISO 8601 timestamp, or null");
    } else out.patch.next_follow_up_at = new Date(b.next_follow_up_at).toISOString();
  }

  return out;
}

/** The parts of a POST /leads body that are checked before the existing intake logic runs. */
export function validateLeadCreate(body: unknown): string[] {
  if (!isPlainObject(body)) return ["Body must be a JSON object"];
  const errs: string[] = [];
  if ("name" in body && body.name !== null && (typeof body.name !== "string" || body.name.length > 200)) {
    errs.push("name must be a string of at most 200 characters");
  }
  if ("email" in body && body.email !== null && body.email !== undefined &&
      (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim()))) {
    errs.push("email must be a valid address");
  }
  if ("phone" in body && body.phone !== null && body.phone !== undefined && typeof body.phone !== "string") {
    errs.push("phone must be a string");
  }
  if ("custom" in body && body.custom !== undefined) {
    if (!isPlainObject(body.custom)) errs.push("custom must be a JSON object");
    else if (JSON.stringify(body.custom).length > MAX_CUSTOM_BYTES) errs.push(`custom must be at most ${MAX_CUSTOM_BYTES} bytes`);
  }
  return errs;
}

/** Clamp list pagination the same way on every route. NaN-safe. */
export function pageParams(limitRaw: string | null, offsetRaw: string | null): { limit: number; offset: number } {
  const l = Number(limitRaw ?? 50);
  const o = Number(offsetRaw ?? 0);
  return {
    limit: Number.isFinite(l) ? Math.min(Math.max(Math.trunc(l), 1), 200) : 50,
    offset: Number.isFinite(o) ? Math.max(Math.trunc(o), 0) : 0,
  };
}

/** `since` filters must be real timestamps, or PostgREST answers 400 with its own text. */
export function validSince(v: string | null): string | null | false {
  if (v === null || v === "") return null;
  return Number.isNaN(Date.parse(v)) ? false : new Date(v).toISOString();
}
