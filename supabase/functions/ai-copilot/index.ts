// AbroBot CRM — AI Copilot & Next Best Action Suggestion Engine.
// Powered by Groq LLM (with fallback).
// Deploy: supabase functions deploy ai-copilot --no-verify-jwt
//
// POST { lead_id, action: "suggest_reply" | "summarize_dossier" | "recommended_action", channel?: "whatsapp" | "email" }
//  -> { ok: true, suggestion: string, rationale: string, recommended_stage?: string }

import { createClient } from "npm:@supabase/supabase-js@2";
import { fetchWithTimeout } from "../_shared/http.ts";
import { safeHexColor } from "../_shared/url-safety.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const PRIMARY_MODEL = "openai/gpt-oss-120b";
const FALLBACK_MODEL = "openai/gpt-oss-20b";

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

  const authz = req.headers.get("Authorization") || "";
  const token = authz.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing auth" }, 401);

  const { data: userData, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !userData?.user) return json({ error: "invalid session" }, 401);

  const { data: profile } = await admin.from("profiles")
    .select("org_id, status, full_name, role").eq("id", userData.user.id).single();
  if (!profile || profile.status !== "active" || !profile.org_id) {
    return json({ error: "not an active member" }, 403);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  const leadId = (body?.lead_id ?? "").toString().trim();
  const actionType = (body?.action ?? "suggest_reply").toString().trim();
  const channel = (body?.channel ?? "whatsapp").toString().trim();

  if (!leadId) return json({ error: "lead_id is required" }, 400);

  // Read lead record and enforce organization isolation boundary
  const { data: lead, error: leadErr } = await admin.from("leads")
    .select("id, name, email, phone, stage, stage_key, score, budget_inr, target_country, course, intake, custom, last_contacted_at, created_at, org_id")
    .eq("id", leadId)
    .eq("org_id", profile.org_id)
    .is("deleted_at", null)
    .maybeSingle();

  if (leadErr || !lead) return json({ error: "lead not found in your organization" }, 404);

  // Read recent activities for interaction context
  const { data: acts } = await admin.from("activities")
    .select("type, content, created_at")
    .eq("lead_id", lead.id)
    .eq("org_id", profile.org_id)
    .order("created_at", { ascending: false })
    .limit(10);

  // Read organization and agent knowledge for business alignment
  const { data: org } = await admin.from("organizations")
    .select("name, industry_slug").eq("id", profile.org_id).single();
  const { data: cfg } = await admin.from("agent_config")
    .select("agent_name, brand_name, knowledge, tone, groq_api_key")
    .eq("org_id", profile.org_id).maybeSingle();

  const groqKey = (cfg?.groq_api_key || GROQ_KEY).trim();
  if (!groqKey) {
    return json({ error: "AI service key is not configured" }, 503);
  }

  // Consume AI usage allowance atomically
  const { data: usage, error: usageErr } = await admin.rpc("consume_usage", {
    p_org_id: profile.org_id,
    p_metric: "ai_messages",
    p_amount: 1,
  });

  if (usageErr || (usage as { allowed?: boolean } | null)?.allowed === false) {
    return json({
      error: "Monthly AI messages allowance reached or unavailable.",
      code: "AI_LIMIT_REACHED",
    }, 402);
  }

  const brand = cfg?.brand_name || org?.name || "Our Team";
  const tone = cfg?.tone || "direct, warm, concise, professional";
  const knowledge = cfg?.knowledge || "";

  // Compile lead dossier
  const dossier = {
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    score: lead.score,
    stage: lead.stage_key || lead.stage,
    target_country: lead.target_country,
    course_or_service: lead.course,
    budget_inr: lead.budget_inr,
    intake_or_timeline: lead.intake,
    custom_details: lead.custom || {},
    recent_activities: (acts || []).map((a) => `[${a.type} @ ${a.created_at}]: ${a.content}`).join("\n"),
  };

  let prompt = "";
  if (actionType === "suggest_reply") {
    prompt = `You are the executive AI sales strategist for "${brand}".
Business context: ${knowledge.slice(0, 1500)}
Communication channel: ${channel.toUpperCase()}
Tone: ${tone}

Lead Dossier:
${JSON.stringify(dossier, null, 2)}

TASK:
Craft the single most persuasive, high-converting next message to send to ${lead.name} via ${channel}.
- If WhatsApp: Keep it short (2-4 sentences), natural, warm, and ending with a clear low-friction question.
- If Email: Include a compelling subject line and crisp body.
- Be context-aware of their history, score (${lead.score}/100), and stage.
- Also provide a 1-sentence 'rationale' explaining why this message strategy moves them forward.

Respond ONLY with valid JSON in this schema:
{
  "subject": "optional subject line if email, else null",
  "text": "the draft message copy ready to send",
  "rationale": "strategic justification for this outreach",
  "recommended_stage": "suggested next pipeline stage if appropriate, or null"
}`;
  } else if (actionType === "summarize_dossier") {
    prompt = `You are an AI deal intelligence analyst for "${brand}".
Lead Dossier:
${JSON.stringify(dossier, null, 2)}

TASK:
Generate a high-impact 3-bullet executive summary of this lead:
1. Intent & Qualification Fit (budget, needs, timeline)
2. Current Status & Momentum (recap of latest interactions)
3. Recommended Next Best Action (the exact next move the human rep should make today)

Respond ONLY with valid JSON in this schema:
{
  "summary": "3-bullet synthesized intelligence briefing",
  "rationale": "key buying or risk signal detected",
  "next_action": "concrete step for sales rep"
}`;
  }

  const callGroq = async (model: string) => {
    return await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 600,
        response_format: { type: "json_object" },
      }),
    }, 15_000);
  };

  let resp = await callGroq(PRIMARY_MODEL).catch(() => null);
  if (!resp || !resp.ok) {
    resp = await callGroq(FALLBACK_MODEL).catch(() => null);
  }

  if (!resp || !resp.ok) {
    return json({ error: "AI intelligence service temporarily unavailable." }, 502);
  }

  const rawJson = await resp.json().catch(() => ({}));
  const content = rawJson?.choices?.[0]?.message?.content || "{}";

  let parsed: any = {};
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = { text: content, rationale: "AI generated contextual recommendation." };
  }

  return json({
    ok: true,
    action: actionType,
    data: parsed,
  });
});
