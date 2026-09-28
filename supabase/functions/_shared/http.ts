// One fetch with a deadline, for every outbound call we make.
//
// Not a single outbound fetch in this codebase had a timeout: Groq, Meta,
// Telegram, Resend, Cashfree. A hung upstream held the function until the
// platform killed it, and the caller got nothing back — no error, no partial
// result, no log line explaining the gap.
//
// It matters most in nurture, which loops up to 25 organisations x 100 leads:
// one slow Resend call there starves every tenant later in the run, and the
// run repeats on a schedule, so the same tenants starve every time.

export class TimeoutError extends Error {
  constructor(url: string, ms: number) {
    // `new URL(url).host` THROWS on a relative url, and this constructor only
    // ever runs on the error path — so a slow upstream behind a relative url
    // surfaced as `TypeError: Invalid URL` and the caller was told its url was
    // malformed when the real event was a timeout. An error type whose own
    // constructor can fail replaces the diagnosis with a red herring at
    // exactly the moment someone is trying to diagnose something.
    //
    // Latent today — every current caller passes an absolute url — and it
    // goes live the first time one is assembled from a config value that can
    // be blank. Host only, never the full url: query strings carry tokens.
    let where = url;
    try {
      where = new URL(url).host;
    } catch {
      // Keep the raw string; a relative path is still the most useful thing
      // we can say about which request timed out.
    }
    super(`timed out after ${ms}ms: ${where}`);
    this.name = "TimeoutError";
  }
}

/** fetch with an AbortController deadline. Default 15s — long enough for a
 *  slow LLM, short enough to leave budget for the rest of a batch. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms = 15_000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    // AbortError is not informative on its own — it does not say what was slow.
    if ((e as Error).name === "AbortError") throw new TimeoutError(url, ms);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
