// Shared guard for the scheduled functions.
//
// run-automations, nurture, system-health and summarize-chats are all deployed
// --no-verify-jwt (pg_cron calls them over HTTP and carries no Supabase JWT),
// and each takes the target organisation from the request body. Together that
// meant anyone on the internet could:
//
//   POST /run-automations {"dry_run":true}          -> lead names and rule
//                                                      names for EVERY tenant
//   POST /nurture         {"org":"someone-else"}    -> email 200 of another
//                                                      customer's leads from
//                                                      your sending domain
//   GET  /system-health                             -> every org's status,
//                                                      including which
//                                                      credentials each stores
//   POST /summarize-chats {...150 duplicate ids}    -> 19 Groq completions per
//                                                      request, unmetered, on
//                                                      the shared key
//
// A shared secret in a header fixes all four. It is not sophisticated — it is
// a bearer token — but the threat here is "reachable by anyone who knows the
// URL", and a header the caller must know closes exactly that.
//
// ── Setup ───────────────────────────────────────────────────────────────────
//   openssl rand -hex 32
//   Supabase dashboard -> Edge Functions -> Secrets -> CRON_SECRET
//   Then re-run 20260903140000_cron_secret.sql so pg_cron sends the header.

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

/** Constant-time compare, so the response time cannot be used to guess the secret. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface CronAuthResult {
  ok: boolean;
  /** A ready-to-return 401 when ok is false. */
  response?: Response;
}

/**
 * Fails CLOSED when CRON_SECRET is unset.
 *
 * The tempting alternative — `if (SECRET && header !== SECRET) reject` — leaves
 * the endpoint wide open whenever the secret is missing, which is the
 * deployment default. app-signup shipped exactly that bug and was
 * unauthenticated in production as a result. Better to break the cron loudly
 * (system-health will show it) than to be silently open.
 */
export function requireCronSecret(req: Request, corsHeaders: HeadersInit): CronAuthResult {
  const deny = (msg: string) => ({
    ok: false,
    response: new Response(JSON.stringify({ error: msg }), {
      status: 401,
      headers: corsHeaders,
    }),
  });

  if (!CRON_SECRET) {
    console.error(
      "CRON_SECRET is not set. Refusing every request rather than running " +
      "unauthenticated. Set it in Edge Function secrets.",
    );
    return deny("not configured");
  }

  const provided = req.headers.get("x-cron-secret") ?? "";
  if (!provided || !safeEqual(provided, CRON_SECRET)) {
    return deny("unauthorized");
  }

  return { ok: true };
}
