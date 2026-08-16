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

  const cfg = await getWhatsAppConfig(admin, profile.org_id);
  const result = await sendWhatsAppText(cfg, lead.phone, text);

  if (!result.sent) {
    const status = result.reason === "not_configured" ? 503 : 502;
    return json({ ok: false, error: result.detail ?? result.reason }, status);
  }

  await admin.from("activities").insert({
    org_id: profile.org_id, lead_id: lead.id, user_id: userData.user.id,
    type: "whatsapp",
    content: `WhatsApp sent by ${profile.full_name || "a counsellor"}:\n${text}`,
  });
  await admin.from("leads").update({ last_contacted_at: new Date().toISOString() }).eq("id", lead.id);

  return json({ ok: true, message_id: result.message_id });
});
