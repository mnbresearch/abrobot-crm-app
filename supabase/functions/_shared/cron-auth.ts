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
  /** Set when the caller was a signed-in user rather than the scheduler. */
  orgId?: string;
  userId?: string;
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

/**
 * Cron secret OR a signed-in member of the org being acted on.
 *
 * Adding the cron secret closed four endpoints that anyone could hit — but two
 * of them also back buttons in the CRM: "▶ Test run" on Automations and
 * "✨ AI summary" on Conversations. The browser sends the user's JWT and
 * cannot send a server-side secret, so both buttons became permanent red
 * toasts the moment the secret went in. That was my regression.
 *
 * A scheduler and a logged-in admin are both legitimate callers; they just
 * prove it differently. The important part is that the JWT path derives the
 * org from the TOKEN, never from the request body — otherwise it would
 * reintroduce exactly the cross-tenant hole the secret was added to close.
 */
export async function requireCronOrMember(
  req: Request,
  corsHeaders: HeadersInit,
  // deno-lint-ignore no-explicit-any
  admin: any,
  opts: { adminOnly?: boolean } = {},
): Promise<CronAuthResult> {
  const deny = (msg: string, status = 401) => ({
    ok: false,
    response: new Response(JSON.stringify({ error: msg }), { status, headers: corsHeaders }),
  });

  // 1. The scheduler.
  const provided = req.headers.get("x-cron-secret") ?? "";
  if (provided && CRON_SECRET && safeEqual(provided, CRON_SECRET)) {
    return { ok: true };
  }

  // 2. A signed-in member.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return deny("unauthorized");

  const { data: userData, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !userData?.user) return deny("invalid session");

  const { data: profile } = await admin
    .from("profiles")
    .select("org_id, status, role")
    .eq("id", userData.user.id)
    .single();

  if (!profile || profile.status !== "active" || !profile.org_id) {
    return deny("not an active member", 403);
  }
  if (opts.adminOnly && !["org_admin", "super_admin"].includes(profile.role)) {
    return deny("admins only", 403);
  }

  return { ok: true, orgId: profile.org_id, userId: userData.user.id };
}
