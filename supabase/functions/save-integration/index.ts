// AbroBot CRM — write integration credentials, and test them.
//
// Deploy:  supabase functions deploy save-integration      (KEEP Verify JWT ON)
//
// Why this exists rather than a plain table update from the browser:
//
// agent_config holds whatsapp_token, telegram_bot_token, resend_api_key and
// groq_api_key on the SAME ROW as the greeting and the persona. RLS is
// row-level, so any policy that lets an admin edit the greeting also lets them
// read the tokens — and the Settings screen deliberately never SELECTs those
// columns for exactly that reason.
//
// So the browser can never be given a read path. It writes through here, and
// gets back only "configured / not configured". A token that has been saved
// can never be displayed again, by anyone, through any screen.
//
// POST { action: "save_whatsapp" | "save_telegram" | "test_whatsapp" | "test_telegram" | "status", ... }

import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // --- caller must be an admin of the org they are configuring ---
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing auth" }, 401);

  const { data: userData, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !userData?.user) return json({ error: "invalid session" }, 401);

  const { data: profile } = await admin.from("profiles")
    .select("org_id, status, role").eq("id", userData.user.id).single();

  if (!profile || profile.status !== "active" || !profile.org_id) {
    return json({ error: "not an active member" }, 403);
  }
  if (!["org_admin", "super_admin"].includes(profile.role)) {
    // Credentials let you send messages billed to the org and read every
    // conversation. Admins only.
    return json({ error: "only an admin can change integration settings" }, 403);
  }
  const orgId = profile.org_id;

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  const str = (v: unknown, max = 500) =>
    typeof v === "string" ? v.trim().slice(0, max) : "";

  try {
    switch (body.action) {
      // ── What is configured? Booleans only, never values. ──────────────────
      case "status": {
        const { data } = await admin.from("agent_config")
          .select("whatsapp_token, whatsapp_phone_id, whatsapp_autoreply, telegram_bot_token, telegram_chat_id, notify_new_leads, whatsapp, resend_api_key, nurture_enabled")
          .eq("org_id", orgId).maybeSingle();

        return json({
          email: {
            // Own key vs. shared platform key. Worth showing, because on the
            // shared key a tenant's deliverability rides on every other
            // tenant's sending behaviour — which is fine until it isn't.
            own_key: !!data?.resend_api_key,
            nurture_on: !!data?.nurture_enabled,
          },
          whatsapp: {
            configured: !!(data?.whatsapp_token && data?.whatsapp_phone_id),
            phone_id_set: !!data?.whatsapp_phone_id,
            display_number: data?.whatsapp ?? null,
            autoreply: !!data?.whatsapp_autoreply,
          },
          telegram: {
            configured: !!(data?.telegram_bot_token && data?.telegram_chat_id),
            chat_id_set: !!data?.telegram_chat_id,
            alerts_on: !!data?.notify_new_leads,
          },
        });
      }

      // ── WhatsApp ──────────────────────────────────────────────────────────
      case "save_whatsapp": {
        const patch: Record<string, unknown> = { org_id: orgId };
        // An empty token means "leave what is stored alone", so a customer can
        // change their phone number without re-pasting a token they no longer
        // have. Sending the literal string "-" clears it.
        const tok = str(body.token, 400);
        if (tok === "-") patch.whatsapp_token = null;
        else if (tok) patch.whatsapp_token = tok;

        if (typeof body.phone_id === "string") patch.whatsapp_phone_id = str(body.phone_id, 60) || null;
        if (typeof body.display_number === "string") patch.whatsapp = str(body.display_number, 30) || null;
        if (typeof body.autoreply === "boolean") patch.whatsapp_autoreply = body.autoreply;

        const { error } = await admin.from("agent_config")
          .upsert(patch, { onConflict: "org_id" });
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, saved: "whatsapp" });
      }

      case "test_whatsapp": {
        const to = str(body.to, 30);
        if (!to) return json({ error: "Enter a number to send the test to" }, 400);

        const { data: cfg } = await admin.from("agent_config")
          .select("whatsapp_token, whatsapp_phone_id").eq("org_id", orgId).maybeSingle();

        if (!cfg?.whatsapp_token || !cfg?.whatsapp_phone_id) {
          return json({ ok: false, error: "Save your token and Phone Number ID first" }, 400);
        }

        const digits = to.replace(/[^\d]/g, "");
        const r = await fetch(
          `https://graph.facebook.com/v21.0/${cfg.whatsapp_phone_id}/messages`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${cfg.whatsapp_token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: digits,
              type: "text",
              text: { body: "✅ WhatsApp is connected to your AbroBot CRM. This is a test." },
            }),
          },
        );
        const out = await r.json();
        if (!r.ok) {
          // Meta's errors are genuinely useful — 131030 means the number is not
          // on your test allow-list, 190 means the token expired. Passing them
          // through saves an hour of guessing.
          const msg = out?.error?.message ?? `Meta returned ${r.status}`;
          const code = out?.error?.code;
          return json({ ok: false, error: msg, meta_code: code }, 200);
        }
        return json({ ok: true, message_id: out?.messages?.[0]?.id });
      }

      // ── Telegram ──────────────────────────────────────────────────────────
      case "save_telegram": {
        const patch: Record<string, unknown> = { org_id: orgId };
        const tok = str(body.bot_token, 200);
        if (tok === "-") patch.telegram_bot_token = null;
        else if (tok) patch.telegram_bot_token = tok;

        if (typeof body.chat_id === "string") patch.telegram_chat_id = str(body.chat_id, 60) || null;
        if (typeof body.notify === "boolean") patch.notify_new_leads = body.notify;

        const { error } = await admin.from("agent_config")
          .upsert(patch, { onConflict: "org_id" });
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, saved: "telegram" });
      }

      case "test_telegram": {
        const { data: cfg } = await admin.from("agent_config")
          .select("telegram_bot_token, telegram_chat_id").eq("org_id", orgId).maybeSingle();

        // Platform bot token is a valid fallback; chat_id never is, because it
        // identifies THIS customer's channel.
        const bot = cfg?.telegram_bot_token || Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
        if (!bot) return json({ ok: false, error: "No bot token saved" }, 400);
        if (!cfg?.telegram_chat_id) {
          return json({ ok: false, error: "Save your Chat ID first" }, 400);
        }

        const r = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: cfg.telegram_chat_id,
            text: "✅ Telegram alerts are connected to your AbroBot CRM. New records will appear here.",
          }),
        });
        const out = await r.json();
        if (!out?.ok) {
          return json({ ok: false, error: out?.description ?? `Telegram returned ${r.status}` }, 200);
        }
        return json({ ok: true });
      }

      // ── Email (Resend) ────────────────────────────────────────────────────
      case "save_email": {
        const tok = str(body.api_key, 200);
        const patch: Record<string, unknown> = { org_id: orgId };
        if (tok === "-") patch.resend_api_key = null;
        else if (tok) {
          // Resend keys start re_. Checking is not security — it is catching
          // the far more common case of someone pasting the wrong key from a
          // password manager and then wondering why email silently stopped.
          if (!/^re_/.test(tok)) {
            return json({ error: "That doesn't look like a Resend key — they start with re_" }, 400);
          }
          patch.resend_api_key = tok;
        }
        const { error } = await admin.from("agent_config").upsert(patch, { onConflict: "org_id" });
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, saved: "email" });
      }

      case "test_email": {
        const to = str(body.to, 200);
        if (!to || !to.includes("@")) return json({ error: "Enter an address to send the test to" }, 400);

        const { data: cfg } = await admin.from("agent_config")
          .select("resend_api_key, brand_name").eq("org_id", orgId).maybeSingle();

        const key = (cfg?.resend_api_key || "").trim() || Deno.env.get("RESEND_API_KEY") || "";
        if (!key) return json({ ok: false, error: "No Resend key saved, and no platform key is configured" }, 400);

        const { data: org } = await admin.from("organizations").select("name").eq("id", orgId).single();
        const brand = (cfg?.brand_name || org?.name || "Your team").replace(/["<>\\]/g, "");
        const from = Deno.env.get("NURTURE_FROM") || "hello@updates.mnbresearch.com";

        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
          body: JSON.stringify({
            from: `${brand} <${from}>`,
            to: [to],
            subject: "✅ Email is connected to your AbroBot CRM",
            html: `<p>This is a test from <b>${brand}</b>. Email sending is working — messages you send from a record, and any automatic follow-up you switch on, will arrive like this.</p>`,
          }),
        });
        const out = await r.json();
        if (!r.ok) {
          // Resend's messages are specific and useful: an unverified domain
          // and an invalid key fail very differently.
          return json({ ok: false, error: out?.message ?? `Resend returned ${r.status}` }, 200);
        }
        return json({ ok: true, message_id: out?.id, using: cfg?.resend_api_key ? "your key" : "the shared key" });
      }

      default:
        return json({ error: `unknown action: ${body.action}` }, 400);
    }
  } catch (e) {
    console.error("save-integration:", e);
    return json({ error: (e as Error).message }, 500);
  }
});
