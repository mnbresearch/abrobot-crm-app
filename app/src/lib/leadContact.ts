// Contact-field rules for records edited in the browser: email validation,
// phone normalisation, and turning a duplicate-key refusal into "here is the
// record that already has it".
//
// normPhone is a faithful port of supabase/functions/_shared/capture.ts
// normPhone — the SOURCE OF TRUTH, used by every capture path (widget,
// webhook, WhatsApp, API). Change that first, then mirror it here. The reason
// it must match: leads_org_phone_unique_idx (20260924092000) compares the raw
// column, so "+91 98765 43210" typed by hand and "+919876543210" captured by
// the widget are two different keys — the same person twice, with the unique
// index none the wiser. Storing the same canonical form everywhere is what
// makes the index mean something.

import { supabase } from "./supabase";

/** Same shape as _shared/api-validate.ts EMAIL_RE: something@something.tld. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

/**
 * Reject candidates whose digit GROUPING is not phone-shaped — "98 76 54 32 10"
 * is a list of scores, not a number. After an optional leading country-code
 * group of 1-3 digits, every remaining group must be 3 digits or longer.
 */
function groupingLooksLikeAPhone(raw: string): boolean {
  const groups = raw.replace(/[()+]/g, " ").split(/[\s-]+/).filter((g) => /\d/.test(g));
  if (groups.length <= 1) return true;
  const rest = groups[0].length <= 3 ? groups.slice(1) : groups;
  return rest.every((g) => g.length >= 3);
}

/**
 * Normalise to E.164, or refuse with null.
 *
 * Digits only, with a leading + when one was given. A bare 10-digit number
 * starting 6-9 is an Indian mobile and gets +91; 11-15 contiguous bare digits
 * already carry a country code. Anything else is refused — a stored value that
 * is not a phone number is a dedupe key that collides and a number a human rings.
 */
export function normPhone(p?: string | null): string | null {
  if (!p) return null;
  const raw = String(p);
  const hasPlus = /\+/.test(raw);
  let digits = raw.replace(/\D/g, "");

  if (!groupingLooksLikeAPhone(raw)) return null;

  // A single leading 0 is the Indian (and UK) trunk prefix: 09876543210.
  if (!hasPlus && digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);

  if (digits.length < 10 || digits.length > 15) return null;
  if (hasPlus) return "+" + digits;
  if (digits.length === 10) return /^[6-9]/.test(digits) ? "+91" + digits : null;
  if (/[\s\-()]/.test(raw.trim())) return null;
  return "+" + digits;
}

/** A Postgres unique-violation, as PostgREST reports it. */
export function isUniqueViolation(err: { code?: string } | null | undefined): boolean {
  return err?.code === "23505";
}

export interface ConflictingLead {
  id: string;
  name: string;
  field: "email" | "phone";
}

/** LIKE-escape so an address containing _ or % matches only itself. */
const likeLiteral = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/**
 * After a 23505 on leads, find the record that already holds the value, so the
 * message can link to it instead of only refusing.
 *
 * Which column collided is read from the index name in the error, falling back
 * to trying email then phone. Email is matched case-insensitively because the
 * unique index is on lower(email). `excludeId` is the record being edited,
 * which trivially "has" its own values.
 *
 * Returns null when the holder cannot be read — the caller still shows the
 * refusal, just without a link.
 */
export async function findConflictingLead(
  orgId: string,
  values: { email?: string | null; phone?: string | null },
  err?: { message?: string; details?: string } | null,
  excludeId?: string,
): Promise<ConflictingLead | null> {
  const text = `${err?.message ?? ""} ${err?.details ?? ""}`.toLowerCase();
  const order: ("email" | "phone")[] =
    text.includes("phone") ? ["phone", "email"] : ["email", "phone"];

  for (const field of order) {
    const v = values[field];
    if (!v) continue;
    let q = supabase.from("leads").select("id, name").eq("org_id", orgId);
    q = field === "email" ? q.ilike("email", likeLiteral(v.trim())) : q.eq("phone", v);
    if (excludeId) q = q.neq("id", excludeId);
    const { data, error } = await q.limit(1);
    if (error) {
      console.warn("duplicate lookup failed:", error.message);
      continue;
    }
    const row = (data as { id: string; name: string }[] | null)?.[0];
    if (row) return { id: row.id, name: row.name, field };
  }
  return null;
}
