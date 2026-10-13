import { supabase } from "./supabase";

/**
 * First-party product analytics — the browser half.
 *
 * Sends a small allow-listed event to track_event() (20261013100000), which
 * attaches the user and workspace from the JWT itself, strips query strings,
 * and drops unknown events and property keys server-side. Payments, checkouts,
 * signups and API keys are NOT tracked from here: they are recorded by database
 * triggers on the tables the server writes, because a browser can claim
 * anything.
 *
 * Privacy:
 *   - nothing is sent when Do Not Track or Global Privacy Control is on;
 *   - no cookie and no persistent id — a random per-tab id in sessionStorage,
 *     gone when the tab closes;
 *   - fire-and-forget: tracking can never slow down or break a screen.
 */

export type ClientEvent =
  | "landing_view" | "pricing_view" | "product_view" | "contact_view"
  | "login_view" | "login_link_requested" | "login_succeeded"
  | "page_view" | "feature_used"
  | "plan_selected" | "checkout_opened" | "checkout_returned";

type Props = Partial<Record<
  "plan" | "months" | "feature" | "route" | "referrer_host" | "utm_source" | "utm_medium" | "utm_campaign" | "result",
  string | number | boolean
>>;

/**
 * True when this page load is the return from a magic sign-in link.
 *
 * Captured once, at module evaluation — synchronously, before supabase-js has
 * exchanged the token and cleaned the URL. A plain "has a session" check would
 * count every page load of an already-signed-in user as a login.
 */
export const arrivedFromSignInLink: boolean = (() => {
  try { return /[#&]access_token=|[?&]code=|[?&]token_hash=/.test(location.href); } catch { return false; }
})();

function optedOut(): boolean {
  const n = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  const w = window as Window & { doNotTrack?: string };
  return n.globalPrivacyControl === true || n.doNotTrack === "1" || w.doNotTrack === "1" || n.msDoNotTrack === "1";
}

function sessionId(): string | null {
  try {
    let id = sessionStorage.getItem("ab_sid");
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
      sessionStorage.setItem("ab_sid", id);
    }
    return id;
  } catch {
    return null;   // storage blocked: still send, just without a session id
  }
}

/** Attribution that is useful and not personal: referring site and UTM tags. */
function attribution(): Props {
  const out: Props = {};
  try {
    const ref = document.referrer ? new URL(document.referrer).host : "";
    if (ref && ref !== location.host) out.referrer_host = ref;
    const q = new URLSearchParams(location.search);
    for (const k of ["utm_source", "utm_medium", "utm_campaign"] as const) {
      const v = q.get(k);
      if (v) out[k] = v.slice(0, 80);
    }
  } catch { /* ignore */ }
  return out;
}

export function track(event: ClientEvent, props: Props = {}): void {
  try {
    if (optedOut()) return;
    const withAttr = event === "landing_view" || event === "pricing_view" || event === "login_view"
      ? { ...attribution(), ...props } : props;
    void supabase.rpc("track_event", {
      p_event: event,
      p_session: sessionId(),
      // Record ids are replaced with :id — which screen, never which record.
      p_path: location.pathname.replace(/\/[0-9a-f-]{36}/gi, "/:id"),
      p_props: withAttr,
    }).then(() => undefined, () => undefined);
  } catch { /* never let analytics throw */ }
}

/** Once per tab, e.g. login_succeeded, so a token refresh is not a new login. */
export function trackOnce(event: ClientEvent, props: Props = {}): void {
  try {
    const k = "ab_once_" + event;
    if (sessionStorage.getItem(k)) return;
    sessionStorage.setItem(k, "1");
  } catch { /* fall through and send */ }
  track(event, props);
}
