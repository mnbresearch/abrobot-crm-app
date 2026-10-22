// The platform-wide email suppression list, read by every sender.
//
// public.platform_email_suppressions (20261013110000) holds addresses that
// asked us to stop, bounced or complained. It was read by exactly one sender —
// checkout recovery — while nurture, send-campaign and app-signup mailed from
// the same verified domain without looking. An unsubscribe that only some of
// our mail honours is not an unsubscribe, and the complaint it produces lands
// on the shared sending reputation every tenant depends on.
//
// Dependency-free (the client is passed in) so the Node suite can test it.

/** Lower-cased, trimmed; "" for anything that is not a usable string. */
export function normaliseEmail(e: unknown): string {
  return typeof e === "string" ? e.trim().toLowerCase() : "";
}

/** Split into fixed-size groups. `.in()` puts every value in the query string,
 *  and a 2,000-recipient campaign in one request overruns URL limits. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type SuppressionLookup =
  | { suppressed: Set<string>; error: null }
  | { suppressed: null; error: string };

const CHUNK = 100;

/**
 * Which of `emails` are suppressed. One query per hundred addresses.
 *
 * Returns `{ suppressed: null, error }` when the list could not be read, and
 * every caller treats that as "send nothing". The alternative — an unreadable
 * list read as an empty one — mails exactly the people who asked us not to,
 * and that is the failure here with legal weight.
 */
// deno-lint-ignore no-explicit-any
export async function loadSuppressed(sb: any, emails: unknown[]): Promise<SuppressionLookup> {
  const wanted = [...new Set(emails.map(normaliseEmail).filter(Boolean))];
  const suppressed = new Set<string>();
  for (const group of chunk(wanted, CHUNK)) {
    const { data, error } = await sb.from("platform_email_suppressions")
      .select("email").in("email", group);
    if (error) return { suppressed: null, error: error.message ?? String(error) };
    for (const row of (data ?? []) as { email: string }[]) {
      suppressed.add(normaliseEmail(row.email));
    }
  }
  return { suppressed, error: null };
}
