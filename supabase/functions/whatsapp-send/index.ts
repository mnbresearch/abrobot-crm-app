// AbroBot CRM — send a WhatsApp message to a lead.
// Deploy:  supabase functions deploy whatsapp-send   (KEEP Verify JWT ON)
// Secrets: none — the token comes from the org's agent_config row.
//
// Auth mirrors send-campaign: the caller sends the logged-in user's Supabase
// access token, and may only message leads belonging to their own org.
//
// POST { lead_id, text }
//  -> { ok, message_id }  and logs a `whatsapp` activity against the lead.
//
// NOTE: Meta only permits free-form text inside the 24h window opened by the
// customer's last inbound message. Outside it you need an approved template;
// this endpoint returns Meta's error (131047) rather than pretending success.

import { createClient } from "npm:@supabase/supabase-js@2";
import { getWhatsAppConfig, sendWhatsAppText } from "../_shared/whatsapp.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // --- authenticate the CRM user ---
  const authz = req.headers.get("Authorization") || "";
  const token = authz.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing auth" }, 401);
  const { data: userData, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !userData?.user) return json({ error: "invalid session" }, 401);
  const { data: profile } = await admin.from("profiles")
    .select("org_id, status, full_name").eq("id", userData.user.id).single();
  if (!profile || profile.status !== "active" || !profile.org_id) {
    return json({ error: "not an active member" }, 403);
  }

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const leadId = (body?.lead_id ?? "").toString().trim();
  const text = (body?.text ?? "").toString().trim();
  if (!leadId || !text) return json({ error: "lead_id and text are required" }, 400);

  // lead must belong to the caller's org — this is the tenancy boundary
  const { data: lead } = await admin.from("leads")
    .select("id, name, phone, org_id").eq("id", leadId).eq("org_id", profile.org_id).single();
  if (!lead) return json({ error: "lead not found in your org" }, 404);
  if (!lead.phone) return json({ error: "lead has no phone number" }, 422);

  // Plan gate. WhatsApp is the headline Growth/Business feature AND carries a
  // real per-conversation cost from Meta, so it is the one limit where "shown
  // in the pricing table but never checked" costs money twice: margin on the
  // sends, and the reason anyone upgrades.
  // Two distinct refusals, because they need different messages: "your plan
  // does not include WhatsApp" is an upsell, "you have used this month's
  // WhatsApp allowance" is not.
  const { data: wa, error: waErr } = await admin.rpc("whatsapp_allowance", { p_org_id: profile.org_id });
  if (waErr) {
    // Fail CLOSED. Meta bills us per message and marketing templates cost 7x a
    // utility one, so "we could not check the allowance" must never mean "send
    // it anyway".
    console.error("whatsapp-send: allowance check failed:", waErr.message);
    return json({ error: "Could not check your WhatsApp allowance. Nothing was sent." }, 503);
  }
  if (!wa?.included) {
    return json({
      error: "WhatsApp is not included on your current plan",
      code: "PLAN_UPGRADE_REQUIRED",
      upgrade_to: "growth",
    }, 402); // Payment Required — the honest status for this
  }
  if (wa.remaining !== null && wa.remaining <= 0) {
    return json({
      error: `You have used this month's WhatsApp allowance (${wa.limit} messages). It resets on the 1st.`,
      code: "WHATSAPP_LIMIT_REACHED",
      used: wa.used, limit: wa.limit,
    }, 402);
  }

  const cfg = await getWhatsAppConfig(admin, profile.org_id);
  const result = await sendWhatsAppText(cfg, lead.phone, text);

  if (!result.sent) {
    const status = result.reason === "not_configured" ? 503 : 502;
    return json({ ok: false, error: result.detail ?? result.reason }, status);
  }

  // Meter AFTER a confirmed send. Counting attempts would bill a customer for
  // Meta's rejections, which is the wrong side to err on.
  await admin.rpc("consume_usage", {
    p_org_id: profile.org_id, p_metric: "whatsapp_messages", p_amount: 1,
  });

  await admin.from("activities").insert({
    org_id: profile.org_id, lead_id: lead.id, user_id: userData.user.id,
    type: "whatsapp",
    content: `WhatsApp sent by ${profile.full_name || "a counsellor"}:\n${text}`,
  });
  await admin.from("leads").update({ last_contacted_at: new Date().toISOString() }).eq("id", lead.id);

  return json({ ok: true, message_id: result.message_id });
});
