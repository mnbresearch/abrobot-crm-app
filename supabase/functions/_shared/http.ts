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
    super(`timed out after ${ms}ms: ${new URL(url).host}`);
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
