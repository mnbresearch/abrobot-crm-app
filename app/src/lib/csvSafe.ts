// Spreadsheet formula-injection guard for every CSV this app writes.
//
// A CSV cell that begins with = + - @ (or a tab / carriage return, which some
// readers strip before evaluating) is executed as a FORMULA by Excel, LibreOffice
// and Google Sheets. Records here are written by strangers — a website chat
// visitor types their own name — so "=HYPERLINK(...)" or a DDE payload in a name
// field would run on the machine of whichever admin opened the export. The
// standard defence (OWASP "CSV Injection") is to prefix such a cell with a
// single quote, which every spreadsheet treats as "this is text".
//
// One deliberate exception: a cell that is ONLY an optional sign followed by
// digits and spaces — "+919876543210", "+91 98765 43210", "-500". Those are not
// formulas in any reader (there is no function, reference or operator for a
// payload to hide in), and every phone number in the export is shaped exactly
// like that. Quoting them would put a stray ' in front of every phone number
// and break the file for re-import, for no protection gained.

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_SIGNED_NUMBER = /^[+-]?\d[\d ]*$/;

/** Neutralise a cell's text so a spreadsheet will never evaluate it. */
export function neutraliseFormula(s: string): string {
  if (!FORMULA_START.test(s)) return s;
  if (PLAIN_SIGNED_NUMBER.test(s)) return s;
  return "'" + s;
}

/** One CSV field: formula-neutralised, then quoted if it needs to be. */
export function csvCell(v: unknown): string {
  const s = neutraliseFormula(v === null || v === undefined ? "" : String(v));
  // \r matters as much as \n: Excel writes CRLF, and a bare CR inside an
  // unquoted field splits the row on some readers and not others.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
