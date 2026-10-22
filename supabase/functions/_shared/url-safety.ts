// Small, pure validators for values that end up in someone else's DOM.
//
// Every function here exists because a tenant-typed or visitor-supplied string
// was being rendered as a link, an image source or a CSS colour without being
// checked first:
//
//   * conversations.page_url came straight from the widget's POST body. Any
//     caller can send any string, and the CRM renders it as a link in
//     Conversations — so `javascript:…` stored there ran in an ADMIN's session
//     the moment they clicked "the page the visitor was on".
//   * booking_url / contact_url / logo_url come from Settings and are handed by
//     the public config endpoint to widget.js, which puts them in href= and
//     src= on the CUSTOMER's website. One bad value is script on their origin.
//   * widget_color is concatenated into a <style> block. A value containing
//     `}` closes the rule and starts the attacker's own stylesheet.
//
// Kept dependency-free so the Node test suite can load it with esbuild alone.

/** Characters that have no business in a URL a person typed or a browser sent. */
const UNSAFE_URL_CHARS = /[\s\u0000-\u001f\u007f<>"'`\\]/;

/**
 * Return `v` (trimmed) if it is an absolute http(s) URL of at most `max`
 * characters, else null.
 *
 * The scheme is checked TWICE on purpose. `new URL()` normalises — it strips
 * leading control characters and tabs inside the scheme ("java\tscript:" parses
 * as "javascript:") — so checking only the parsed protocol would approve a
 * string whose raw form a different parser reads differently. Requiring the
 * RAW string to start with http:// or https:// AND the parsed protocol to agree
 * leaves no gap between what we validated and what gets rendered.
 */
export function safeHttpUrl(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  if (UNSAFE_URL_CHARS.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
  } catch {
    return null;
  }
  return s;
}

/**
 * What may be stored in conversations.page_url.
 *
 * Mirrors the CHECK constraint on that column — null, the literal 'whatsapp',
 * or an http(s) URL — so a value refused here is one the database would have
 * refused anyway, and an insert never fails on a visitor's odd browser.
 * Anything else becomes null: losing the page a visitor was on is a small gap;
 * storing a script URL in a field the CRM renders as a link is not.
 */
export function safePageUrl(v: unknown): string | null {
  if (v === "whatsapp") return "whatsapp";
  return safeHttpUrl(v, 500);
}

/**
 * A six-digit hex colour, or null.
 *
 * Deliberately strict — no #abc shorthand, no rgb(), no names. The value is
 * interpolated into CSS and fed to arithmetic that assumes six hex digits
 * (widget.js shade()/onAccent()), so anything looser is either an injection
 * or a colour that silently renders as black.
 */
export function safeHexColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : null;
}

/** Anything with a case-insensitive get(), i.e. a Headers object or a stub. */
export interface HeaderBag {
  get(name: string): string | null;
}

/**
 * The client address to key a rate limit on.
 *
 * NOT the first X-Forwarded-For entry. That entry is whatever the client put
 * there — proxies append, they do not replace — so keying on it let one
 * script rotate a fake address per request and never hit the limit.
 *
 * Preference order is "set by infrastructure we sit behind, and overwritten if
 * the client sends it":
 *   1. cf-connecting-ip — Cloudflare fronts *.supabase.co and replaces this
 *      header with the address it actually accepted the connection from;
 *   2. x-real-ip        — set by the gateway in front of the function;
 *   3. the LAST X-Forwarded-For hop — the address the nearest proxy saw, which
 *      is the one hop a client cannot forge.
 *
 * Returns "unknown" when none is present, which collapses every such caller
 * into one bucket — the safe direction for a limiter to fail.
 */
export function clientIp(h: HeaderBag): string {
  const clean = (v: string | null | undefined) => (v ?? "").trim().slice(0, 64);
  const cf = clean(h.get("cf-connecting-ip"));
  if (cf) return cf;
  const real = clean(h.get("x-real-ip"));
  if (real) return real;
  const hops = (h.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const last = clean(hops[hops.length - 1]);
  return last || "unknown";
}
