/**
 * Contact extraction and normalisation — ONE implementation for every path.
 *
 * WHY THIS MODULE EXISTS
 * ──────────────────────
 * There were three normalisers, and they disagreed:
 *
 *   chat-agent   `d.replace("+","").length < 8`   — counted digits correctly
 *   lead-webhook `digits.length < 8`              — counted the `+` as a digit,
 *                                                   so `+1234567` (7 digits) passed
 *   api          a third inline copy of the same logic
 *
 * A phone normalised one way on one path and another way on another path does
 * not dedupe against itself, which is how the same person ends up as two
 * records, counted twice against the plan and worked by two people. The CSV
 * import did not normalise at all, so a sheet of `9876543210` created a second
 * record for everyone the widget had already captured as `+919876543210`.
 *
 * Everything here is pure and has no Deno or Supabase dependency, so it is
 * directly unit-testable from Node — see capture.test.cjs.
 */

export const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

/** Anchored: for validating a whole string that should BE an address. */
export const EMAIL_ONLY = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Permissive CANDIDATE matcher. Validation happens in `normPhone`, because the
 * rule is far easier to state — and to test — as code than as one regex.
 *
 * The previous pattern, `/(?:\+?\d[\d\s\-()]{8,}\d)/`, matched any run of ten
 * or more digit/space/hyphen characters and so fabricated numbers out of
 * ordinary sentences. Measured against real prose:
 *
 *   "Looking at the 2024 - 2026 batch for my MBA"  ->  "2024 - 2026"
 *   "Order ref 1234-5678-90 please help"           ->  "1234-5678-90"
 *
 * The fabricated value then became the DEDUPE KEY, so two unrelated visitors
 * who both mentioned a year range merged into one lead.
 */
export const PHONE_RE = /(?<![\d])\+?\d[\d\s\-()]{7,20}\d(?![\d])/;

/**
 * Reject candidates whose digit GROUPING is not phone-shaped.
 *
 * "I scored 98 76 54 32 10 in mocks" has eighteen digit characters in a row of
 * two-digit groups and was being stored as +919876543210 — then used as the
 * dedupe key, merging that visitor into whoever genuinely owns that number.
 *
 * Real formatting is at most a short country code followed by groups of three
 * or more: "+91 98765 43210", "+1 415 555 0123", "9876543210". So: after an
 * optional leading country-code group of 1-3 digits, every remaining group must
 * be 3 digits or longer.
 */
function groupingLooksLikeAPhone(raw: string): boolean {
  // Only tokens CONTAINING DIGITS count. Splitting the whole string meant a
  // label came through as a group: "Ph: +1 415 555 0123" produced
  // ["Ph:","1","415",…], so "Ph:" was taken for the country code, "1" became a
  // one-digit body group, and a perfectly good US number was refused.
  const groups = raw.replace(/[()+]/g, " ").split(/[\s-]+/).filter((g) => /\d/.test(g));
  if (groups.length <= 1) return true;                 // one unbroken run
  const rest = groups[0].length <= 3 ? groups.slice(1) : groups;
  return rest.every((g) => g.length >= 3);
}

/**
 * Normalise to E.164, or refuse.
 *
 * Refusing is the point: a stored value that is not a phone number is a dedupe
 * key that collides and a number a human rings.
 *
 * CORRECTION — my first version of this rejected every international number
 * that arrived without a leading "+", returning null for 16315551181 (US),
 * 447911123406 (UK), 971501234567 (UAE) and 8613800138000 (CN). That is exactly
 * the shape Meta's WhatsApp Cloud API delivers `messages[0].from` in — digits
 * only, no plus — so the WhatsApp intake path would have discarded every
 * non-Indian enquiry with a 422, having previously handled them correctly.
 * A tightening that silently drops real traffic is worse than the loose rule it
 * replaced.
 */
export function normPhone(p?: string | null): string | null {
  if (!p) return null;
  const raw = String(p);

  // A "+" ANYWHERE is a country-code signal. Testing only the trimmed start
  // missed "Ph: +1 415 555 0123" and "tel:+44...".
  const hasPlus = /\+/.test(raw);
  let digits = raw.replace(/\D/g, "");

  if (!groupingLooksLikeAPhone(raw)) return null;

  // A single leading 0 is the Indian (and UK) trunk prefix: 09876543210.
  if (!hasPlus && digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);

  // E.164 permits up to 15 digits, not 14. Minimum 10 keeps "2024 - 2026" out.
  if (digits.length < 10 || digits.length > 15) return null;

  if (hasPlus) return "+" + digits;

  // Bare 10 digits with no country code: this product is sold in India, where
  // every mobile number starts 6-9. A 10-digit run starting 1-5 is an order
  // reference, not a phone.
  if (digits.length === 10) return /^[6-9]/.test(digits) ? "+91" + digits : null;

  // 11-15 bare digits already carry a country code — US, UK, UAE, CN, NP all
  // arrive this way from Meta. But ONLY when the run is contiguous: Meta sends
  // "16315551181" with no separators, whereas "Intake 2025 2026 2027 please
  // advise" is three spaced four-digit groups that otherwise satisfied every
  // rule above and was stored as +202520262027. Humans do space out a 10-digit
  // Indian number ("98765 43210"), which is why this applies only above 10.
  if (/[\s\-()]/.test(raw.trim())) return null;
  return "+" + digits;
}

/**
 * Words that are never a first name, used to reject the weak triggers below.
 * Deliberately small: it only has to cover what actually follows "I'm" and
 * "this is" in enquiry text.
 */
const NOT_A_NAME = new Set([
  "looking", "interested", "trying", "wondering", "hoping", "planning", "just",
  "here", "urgent", "not", "sure", "from", "still", "also", "really", "very",
  "new", "currently", "actually", "about", "asking", "enquiring", "writing",
  // "This is Regarding Admission" reached the name column as "Regarding
  // Admission" — capitalised, so the case rule let it through, and absent from
  // this list, so cleanName let it through too.
  "regarding", "reaching", "contacting", "following", "calling", "messaging",
  "an", "one", "someone", "trying", "unable", "keen", "ready", "happy",
  "a", "an", "the", "my", "me", "we", "i", "is", "in", "to", "for", "of", "so",
]);

function cleanName(raw: string): string | null {
  // Cut at the first sentence break. `.` is inside the name class so that
  // "Dr. Mehta" survives, which also meant the capture ran on past the end of
  // the name: "my name is Priya. Also my budget is 5 lakh" yielded
  // "Priya. Also my budget". A period FOLLOWED BY WHITESPACE ends the name; a
  // period inside a word ("Dr.Mehta") does not.
  // `,;:!?` always end the name. A PERIOD is ambiguous: "Priya. Also my budget"
  // is a sentence break, "Dr. Mehta" and "R. K. Sharma" are not. The tell is
  // the token before it — a title or an initial is short, a name is not. So a
  // period only breaks when the word before it is longer than three letters.
  const TITLE = /(?:^|\s)(?:[\p{L}]{1,3}|dr|mr|mrs|ms|prof|shri|smt|capt)$/iu;
  let name = raw;
  const hard = name.search(/[,;:!?]\s/);
  if (hard > -1) name = name.slice(0, hard);
  for (let i = name.indexOf(". "); i > -1; i = name.indexOf(". ", i + 1)) {
    if (!TITLE.test(name.slice(0, i))) { name = name.slice(0, i); break; }
  }
  name = name.trim().replace(/\s+/g, " ").slice(0, 60);
  // A trailing period is an abbreviation only if something followed it; at the
  // very end of the capture it is sentence punctuation.
  name = name.replace(/[.,;:!?]+$/, "").trim();
  if (!name) return null;

  // Every word must be vetted, not just the first. "This is Regarding
  // Admission" passed because only "regarding" was checked against the list
  // and it was absent — the real tell is that no word is a plausible name.
  const words = name.split(" ");
  const firstWord = words[0].toLowerCase().replace(/[^\p{L}]/gu, "");
  if (!firstWord || NOT_A_NAME.has(firstWord)) return null;
  if (!/\p{L}/u.test(name)) return null;      // must contain a letter

  // A URL or an address is not a name. "my name is https://spam.example.com"
  // yielded "https".
  if (/^(https?|www|mailto|tel)$/i.test(firstWord)) return null;

  return name;
}

/**
 * Pull a self-introduced name out of free text.
 *
 * The previous pattern was
 *   /\b(?:my name is|i am|i'm|this is|name[:\-]?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i
 * and it was wrong for most real input. Measured:
 *
 *   "my name is O'Brien"                     -> "is"
 *   "my name is मृदुल नंदा"                   -> "is"
 *   "My name is ZZ-TEST-ALERT"               -> "ZZ"
 *   "my name is Ravi Kumar Sharma"           -> "Ravi Kumar"   (surname lost)
 *   "I'm looking for a Bachelors in Canada"  -> "looking for"
 *   "this is urgent, please call me"         -> "urgent"
 *
 * Three faults: `/i` made `[A-Z][a-z]+` match any letters so it stopped dead at
 * the first non-letter (hence "is" for every non-ASCII or apostrophe name); it
 * capped at two words; and the bare `name` alternative matched "...take your
 * name so I can...".
 *
 * Two tiers, because the triggers assert different amounts:
 *   STRONG  "my name is", "name:"      — accept any script, any capitalisation.
 *   WEAK    "i am", "i'm", "this is"   — usually the start of a sentence about
 *                                        something else, so require initial
 *                                        capitals AND reject known non-names.
 */
export function grabName(t: string): string | null {
  if (!t) return null;

  // \p{M} is NOT optional here. Indic scripts write vowels as combining marks:
  // "मृदुल" is म + ृ + द + ु + ल, and ृ/ु are \p{Mn}, not \p{L}. A class of
  // [\p{L}...] alone matched exactly one character and returned "म" — the same
  // shape of bug as the original `[A-Z][a-z]+`, just one layer down. Caught by
  // the Devanagari case in capture.test.cjs.
  const P = `[\\p{L}\\p{M}][\\p{L}\\p{M}'’.\\-]*`;
  const NAME = `(${P}(?:\\s+${P}){0,3})`;

  const strong = t.match(new RegExp(`(?:my name is|name\\s*[:\\-])\\s+${NAME}`, "iu"));
  if (strong) { const n = cleanName(strong[1]); if (n) return n; }

  // Case-SENSITIVE on the name: "I'm looking for" has a lowercase 'l' and is
  // rejected; "I'm Ravi Kumar" is kept. Scripts without case (Devanagari, Tamil,
  // Arabic) have no \p{Lu}, so they can only ever match via the STRONG trigger
  // above — which is the right trade: the weak triggers need capitalisation to
  // be safe, and a script without capitals cannot supply it.
  // \b before the trigger is load-bearing: without it "[Tt]his is" matched
  // INSIDE "Mathis is", and "[Ii] ?am" inside "Miriam", so
  // "my friend Miriam Sharma referred me" produced the name "Sharma".
  const UP = `[\\p{Lu}][\\p{L}\\p{M}'’.\\-]*`;
  const weak = t.match(new RegExp(
    `(?:\\b[Ii] ?am|\\b[Ii]['’]m|\\b[Tt]his is)\\s+(${UP}(?:\\s+${UP}){0,3})`, "u"));
  if (weak) { const n = cleanName(weak[1]); if (n) return n; }

  return null;
}

/**
 * The display name for a record when the visitor never gave one.
 *
 * `name = email?.split("@")[0] ?? phone ?? "Unknown lead"` put the PHONE NUMBER
 * in the name column — which is how a live Toppers Hub record ended up reading
 * `👤 +918745821142` with the same digits repeated on the phone line, in the
 * CRM and in every Telegram alert.
 *
 * The phone and the email already have their own columns and the alert prints
 * them on their own lines, so repeating one as the name adds nothing and reads
 * as a bug. A plain label is strictly better.
 */
export function displayName(rawName: unknown, email: unknown, phone: unknown): string {
  // A whitespace-only name was truthy, so the old `!name` fallback never fired
  // and the alert rendered "👤 <b>   </b>".
  const n = String(rawName ?? "").trim();

  if (n && !EMAIL_ONLY.test(n) && !/^\+?[\d\s\-()]+$/.test(n)) return n.slice(0, 200);

  // An address typed into the name box is still the best name we have — its
  // local part is usually the person. Taking it from `n` as well as from
  // `email` matters because the two are not always the same field: a form that
  // posts only `name: "bob@x.com"` leaves `email` null, and returning
  // "New enquiry" there would discard the only identifying thing we were given.
  // `email` is deliberately typed `unknown`: lead-webhook calls this with the
  // RAW body value, which a mis-mapped Zapier step can deliver as a number or a
  // nested object — `email.split is not a function` was an unhandled 500.
  const e = typeof email === "string" ? email.trim() : "";

  // `.split("@")[0]` on "@x.com" is the empty string, so the guard has to be on
  // the RESULT, not on the input. Returning "" put a blank name in the CRM and
  // rendered "👤 <b></b>" in the alert — the same defect one layer down.
  const stem = (s: string) => s.split("@")[0].trim().slice(0, 200);
  if (EMAIL_ONLY.test(n) && stem(n)) return stem(n);
  if (e && stem(e)) return stem(e);

  // Deliberately NOT the phone number. Putting it here is what produced the
  // live record reading "👤 +918745821142" with the same digits on the phone
  // line directly below — the number already has its own column.
  return "New enquiry";
}
