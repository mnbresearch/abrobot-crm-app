// Merge-token substitution for the browser — a faithful port of
// supabase/functions/_shared/template.ts (applyTemplate + firstName), which is
// the SOURCE OF TRUTH. Change that file first, then mirror the change here.
//
// Why a port rather than an import: the app's tsconfig includes only `src`,
// and Vite's dev server refuses to serve files outside the app root, so a
// direct `import "../../supabase/functions/..."` would build in CI and break
// `npm run dev`. The function is pure string work with no Deno APIs, so a copy
// is safe; the cost is keeping two copies in step.
//
// Why it has to match exactly: LeadDetail's previews used a hand-rolled subset
// that knew five tokens. {{email}}, {{phone}}, {{intake}} and every
// {{custom.*}} field went out LITERALLY in WhatsApp (whatsapp-send does no
// substitution of its own), and in email the preview showed "{{email}}" while
// send-campaign substituted it — so the person approved one message and the
// customer received another.

export interface Mergeable {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  target_country?: string | null;
  course?: string | null;
  course_level?: string | null;
  intake?: string | null;
  custom?: Record<string, unknown> | null;
}

/** Best available first name. Falls back through the email local part, then
 *  "there" — never an empty greeting, and never a bare number, because
 *  "Hi 9876543210," is worse than no name at all. */
export function firstName(name?: string | null, email?: string | null): string {
  const n = (name || "").trim().split(/\s+/)[0];
  if (n && !/^[\d+\-() ]+$/.test(n)) return n;
  const e = (email || "").trim().split("@")[0].replace(/[._\-+].*$/, "");
  if (e && !/^\d+$/.test(e)) return e.charAt(0).toUpperCase() + e.slice(1);
  return "there";
}

/**
 * Substitute {{token}} in `body`.
 *
 * Unknown tokens are left ALONE rather than blanked. A stray {{discount}} in
 * the output is visibly a mistake someone can fix; a sentence silently missing
 * its object reads as fluent nonsense and ships.
 */
export function applyTemplate(body: string, lead: Mergeable, brand: string): string {
  const values: Record<string, string> = {
    name: (lead.name ?? "").trim(),
    first_name: firstName(lead.name, lead.email),
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    country: lead.target_country ?? "",
    course: lead.course ?? lead.course_level ?? "",
    intake: lead.intake ?? "",
    brand,
  };

  return body.replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi, (whole, rawKey: string) => {
    const key = rawKey.toLowerCase();

    // custom.<field> reaches the industry pack's own fields, so a dental
    // clinic can write {{custom.treatment}} without us knowing what that is.
    if (key.startsWith("custom.")) {
      const v = (lead.custom ?? {})[rawKey.slice(7)];
      return v === null || v === undefined || v === "" ? whole : String(v);
    }

    const v = values[key];
    // A known token with no value for this record: drop it. {{course}} on a
    // record with no course should leave a gap, not print "{{course}}".
    if (key in values) return v;
    return whole;
  });
}
