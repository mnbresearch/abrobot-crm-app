// AbroBot CRM — public REST API.
//
// Deploy:  supabase functions deploy api --no-verify-jwt
//   (--no-verify-jwt because callers authenticate with an AbroBot API key,
//    not a Supabase JWT. The key check below IS the authentication.)
//
// This is what "API & webhooks" on the Business plan actually means. Before
// this, that line on the pricing page described nothing — there was no way to
// read a record out of the CRM or push one in except the lead-capture webhook.
//
//   Authorization: Bearer abk_live_...
//
//   GET    /api/v1/leads?stage=&assigned=&since=&limit=&offset=&q=
//   GET    /api/v1/leads/:id
//   POST   /api/v1/leads
//   PATCH  /api/v1/leads/:id
//   GET    /api/v1/stages
//   GET    /api/v1/me            -- what this key can do; good for a health check
//
// Scopes: leads:read, leads:write, conversations:read, stages:read.
//
// Every query is filtered by the org resolved FROM THE KEY. The org is never
// taken from the request — a caller cannot ask for someone else's data because
// there is no parameter through which to ask.

import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Content-Type": "application/json",
};

const json = (b: unknown, s = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...CORS, ...extra } });

const err = (message: string, status: number, hint?: string) =>
  json(hint ? { error: message, hint } : { error: message }, status);

// Columns safe to return. Deliberately excludes `raw` — it holds the original
// webhook payload, which can contain anything the sender put in it, and is not
// ours to hand back out.
const LEAD_COLS =
  "id, name, email, phone, source, stage_key, score, assigned_to, tags, custom, " +
  "target_country, course, course_level, intake, budget_inr, " +
  "next_follow_up_at, last_contacted_at, created_at, updated_at";

interface Auth { orgId: string; keyId: string; scopes: string[] }

async function authenticate(req: Request): Promise<Auth | Response> {
  const header = req.headers.get("Authorization") ?? "";
  const raw = header.replace(/^Bearer\s+/i, "").trim();

  if (!raw) {
    return err("Missing API key", 401,
      "Send it as: Authorization: Bearer abk_live_...");
  }
  if (!raw.startsWith("abk_")) {
    return err("That does not look like an AbroBot API key", 401,
      "Keys start with abk_live_. Create one in Settings -> Integrations.");
  }

  const { data, error } = await admin.rpc("resolve_api_key", { p_raw: raw });
  if (error) {
    console.error("resolve_api_key failed:", error.message);
    return err("Could not verify the key", 500);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.org_id) {
    // Revoked, expired and never-existed are deliberately indistinguishable —
    // telling an attacker which one it was is free information.
    return err("Invalid or revoked API key", 401);
  }

  return { orgId: row.org_id, keyId: row.key_id, scopes: row.scopes ?? [] };
}

const can = (a: Auth, scope: string) => a.scopes.includes(scope);

function needScope(a: Auth, scope: string): Response | null {
  if (can(a, scope)) return null;
  return err(`This key does not have the "${scope}" scope`, 403,
    `It has: ${a.scopes.join(", ") || "none"}. Create a new key with the scope you need.`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  // Tolerate /api, /api/v1/... and the bare function path, so a customer who
  // forgets the version prefix gets their data rather than a 404.
  const path = url.pathname
    .replace(/^\/functions\/v1\/api/, "")
    .replace(/^\/api/, "")
    .replace(/^\/v1/, "")
    .replace(/\/+$/, "") || "/";

  try {
    // ── GET /me ────────────────────────────────────────────────────────────
    if (path === "/me" && req.method === "GET") {
      const { data: org } = await admin
        .from("organizations").select("name, slug, plan").eq("id", auth.orgId).single();
      return json({ org: org?.name, slug: org?.slug, plan: org?.plan, scopes: auth.scopes });
    }

    // ── GET /stages ────────────────────────────────────────────────────────
    if (path === "/stages" && req.method === "GET") {
      const bad = needScope(auth, "stages:read");
      if (bad) return bad;
      const { data, error } = await admin
        .from("pipeline_stages")
        .select("key, label, position, is_won, is_lost")
        .eq("org_id", auth.orgId).order("position");
      if (error) return err(error.message, 500);
      return json({ stages: data ?? [] });
    }

    // ── GET /conversations ─────────────────────────────────────────────────
    // `conversations:read` was a grantable scope that granted nothing: it
    // appeared in the key-creation UI and in API.md, and no endpoint honoured
    // it. A permission that does nothing is worse than a missing feature —
    // someone grants it, believes their integration is scoped correctly, and
    // finds out otherwise when they try to use it.
    if (path === "/conversations" && req.method === "GET") {
      const bad = needScope(auth, "conversations:read");
      if (bad) return bad;

      const p = url.searchParams;
      const limit = Math.min(Math.max(Number(p.get("limit") ?? 50), 1), 200);
      const offset = Math.max(Number(p.get("offset") ?? 0), 0);

      let q = admin.from("conversations")
        .select("id, lead_id, visitor_name, visitor_email, visitor_phone, page_url, message_count, created_at, last_message_at",
                { count: "exact" })
        .eq("org_id", auth.orgId);

      if (p.get("lead_id")) q = q.eq("lead_id", p.get("lead_id"));
      if (p.get("since"))   q = q.gte("last_message_at", p.get("since"));

      const { data, error, count } = await q
        .order("last_message_at", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) return err(error.message, 500);

      return json({
        conversations: data ?? [],
        pagination: { total: count ?? 0, limit, offset, has_more: (count ?? 0) > offset + limit },
      });
    }

    // ── GET /conversations/:id — the transcript ────────────────────────────
    const convo = path.match(/^\/conversations\/([0-9a-f-]{36})$/i);
    if (convo && req.method === "GET") {
      const bad = needScope(auth, "conversations:read");
      if (bad) return bad;

      // Fetch the conversation FIRST, scoped to the org. Querying messages by
      // conversation_id alone would return another tenant's transcript to
      // anyone who guessed a uuid — chat_messages carries no org_id of its
      // own, so this row is the only thing that establishes ownership.
      const { data: head, error: headErr } = await admin.from("conversations")
        .select("id, lead_id, visitor_name, visitor_email, visitor_phone, page_url, message_count, created_at, last_message_at")
        .eq("id", convo[1]).eq("org_id", auth.orgId).maybeSingle();
      if (headErr) return err(headErr.message, 500);
      if (!head) return err("No such conversation", 404);

      const { data: msgs, error: msgErr } = await admin.from("chat_messages")
        .select("id, role, content, created_at")
        .eq("conversation_id", head.id)
        .order("created_at")
        .limit(500);
      if (msgErr) return err(msgErr.message, 500);

      return json({ conversation: head, messages: msgs ?? [] });
    }

    // ── GET /leads ─────────────────────────────────────────────────────────
    if (path === "/leads" && req.method === "GET") {
      const bad = needScope(auth, "leads:read");
      if (bad) return bad;

      const p = url.searchParams;
      // Capped at 200. An unbounded limit is how one integration takes the
      // database down for every tenant on a shared free-tier project.
      const limit = Math.min(Math.max(Number(p.get("limit") ?? 50), 1), 200);
      const offset = Math.max(Number(p.get("offset") ?? 0), 0);

      let q = admin.from("leads").select(LEAD_COLS, { count: "exact" })
        .eq("org_id", auth.orgId);

      if (p.get("stage"))    q = q.eq("stage_key", p.get("stage"));
      if (p.get("assigned")) q = q.eq("assigned_to", p.get("assigned"));
      if (p.get("source"))   q = q.eq("source", p.get("source"));
      if (p.get("since"))    q = q.gte("created_at", p.get("since"));
      const search = p.get("q");
      if (search) {
        // Escape PostgREST's delimiters. Interpolating a raw value into an
        // or() filter is how you get filter injection.
        const safe = search.replace(/[,()*]/g, " ").trim();
        if (safe) q = q.or(`name.ilike.*${safe}*,email.ilike.*${safe}*,phone.ilike.*${safe}*`);
      }

      const { data, error, count } = await q
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) return err(error.message, 500);
      return json({
        leads: data ?? [],
        pagination: { total: count ?? 0, limit, offset, has_more: (count ?? 0) > offset + limit },
      });
    }

    // ── GET /leads/:id ─────────────────────────────────────────────────────
    const one = path.match(/^\/leads\/([0-9a-f-]{36})$/i);
    if (one && req.method === "GET") {
      const bad = needScope(auth, "leads:read");
      if (bad) return bad;
      const { data, error } = await admin.from("leads").select(LEAD_COLS)
        .eq("id", one[1]).eq("org_id", auth.orgId).maybeSingle();
      if (error) return err(error.message, 500);
      if (!data) return err("No such record", 404);
      return json(data);
    }

    // ── POST /leads ────────────────────────────────────────────────────────
    if (path === "/leads" && req.method === "POST") {
      const bad = needScope(auth, "leads:write");
      if (bad) return bad;

      let body: Record<string, unknown>;
      try { body = await req.json(); } catch { return err("Body must be valid JSON", 400); }

      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
      const phoneRaw = typeof body.phone === "string" ? body.phone : null;
      // Same normalisation the widget and webhook use, so a lead created
      // through the API dedupes against one captured on the website.
      let phone: string | null = null;
      if (phoneRaw) {
        const d = phoneRaw.replace(/[^\d+]/g, "");
        if (d.replace("+", "").length >= 8) {
          phone = /^\d{10}$/.test(d) ? "+91" + d : (d.startsWith("+") ? d : "+" + d);
        }
      }
      if (!email && !phone) {
        return err("A record needs an email or a phone number", 422);
      }

      // Dedupe rather than creating a second copy of a person you already have.
      let dq = admin.from("leads").select("id").eq("org_id", auth.orgId);
      dq = email && phone ? dq.or(`email.eq.${email},phone.eq.${phone}`)
                          : (email ? dq.eq("email", email) : dq.eq("phone", phone!));
      const { data: existing } = await dq.limit(1);
      if (existing?.length) {
        return json({ ok: true, deduped: true, id: existing[0].id,
          message: "A record with that email or phone already exists" }, 200);
      }

      const { data: stage } = await admin.from("pipeline_stages")
        .select("key").eq("org_id", auth.orgId).order("position").limit(1).maybeSingle();

      const { data: created, error: insErr } = await admin.from("leads").insert({
        org_id: auth.orgId,
        name: (typeof body.name === "string" && body.name.trim())
          || email?.split("@")[0] || phone || "API record",
        email, phone,
        source: "other",
        stage_key: stage?.key ?? "new",
        custom: typeof body.custom === "object" && body.custom ? body.custom : {},
        next_follow_up_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      }).select(LEAD_COLS).single();

      if (insErr) {
        // Plan-limit rejections are written to be read by a person, so pass
        // them through rather than flattening to "500".
        const overLimit = /plan includes|subscription has ended/i.test(insErr.message);
        return err(insErr.message, overLimit ? 402 : 500);
      }
      return json(created, 201);
    }

    // ── PATCH /leads/:id ───────────────────────────────────────────────────
    if (one && req.method === "PATCH") {
      const bad = needScope(auth, "leads:write");
      if (bad) return bad;

      let body: Record<string, unknown>;
      try { body = await req.json(); } catch { return err("Body must be valid JSON", 400); }

      // Allowlist. Without one, a caller could PATCH org_id and move a record
      // into another tenant.
      const patch: Record<string, unknown> = {};
      for (const f of ["name", "email", "phone", "stage_key", "score",
                       "assigned_to", "tags", "custom", "next_follow_up_at"]) {
        if (f in body) patch[f] = body[f];
      }
      if (!Object.keys(patch).length) return err("Nothing to update", 400);

      if (typeof patch.stage_key === "string") {
        const { data: valid } = await admin.from("pipeline_stages")
          .select("key").eq("org_id", auth.orgId).eq("key", patch.stage_key).maybeSingle();
        if (!valid) {
          return err(`"${patch.stage_key}" is not a stage in your pipeline`, 422,
            "GET /api/v1/stages lists the valid keys.");
        }
      }

      const { data, error } = await admin.from("leads")
        .update(patch).eq("id", one[1]).eq("org_id", auth.orgId)
        .select(LEAD_COLS).maybeSingle();

      if (error) return err(error.message, 500);
      if (!data) return err("No such record", 404);
      return json(data);
    }

    return err(`No route for ${req.method} ${path}`, 404,
      "Try GET /api/v1/me, /api/v1/leads or /api/v1/stages");
  } catch (e) {
    console.error("api: unhandled", e);
    return err("Something went wrong on our side", 500);
  }
});
