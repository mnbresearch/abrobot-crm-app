// One implementation of merge-token substitution, shared by every sender.
//
// It was previously implemented once in the browser (LeadDetail's WhatsApp
// modal) and nowhere on the server, so the tokens the Templates screen
// documents worked in one place and rendered literally in another. A customer
// would preview "Hi {{first_name}}" and receive exactly that.

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
  const e = (email || "").split("@")[0].replace(/[._\-+].*$/, "");
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
export function applyTemplate(
  body: string,
  lead: Mergeable,
  brand: string,
): string {
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

/** Escape for interpolation into HTML email bodies. */
export function escapeHtml(s: string): string {
  return (s || "").replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
}

/** Plain text (what the tenant wrote) → simple, safe HTML. Paragraphs from
 *  blank lines, <br> from single newlines, bare URLs linkified. Deliberately
 *  not a markdown renderer: the Templates editor is a plain textarea, so
 *  supporting syntax it does not advertise would surprise people. */
export function textToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((para) => {
      const withLinks = para.replace(
        /(https?:\/\/[^\s<]+)/g,
        (u) => `<a href="${u}" style="color:#b45309">${u}</a>`,
      );
      return `<p style="margin:0 0 14px">${withLinks.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}
