// AbroBot CRM — AI chat agent backend (free Chatbase replacement), fully CRM-configurable.
//
// Powered by Groq (free tier). Deploy:  supabase functions deploy chat-agent --no-verify-jwt
// Secret required:  GROQ_API_KEY  (platform fallback; each org can bring its own key in Settings)
//
// GET  ?org=slug&config=1   -> public widget config (greeting, look, quick replies — no secrets)
// POST { org, conversation_id?, page_url?, message } -> { reply, conversation_id }
//
// EVERYTHING about the agent is controlled from the CRM Settings → AI Agent tab (agent_config row):
//   identity: agent_name, persona, header_title/subtitle, greeting, teaser, logo_url
//   behaviour: knowledge (instructions), tone, languages, guardrails, model, temperature, max_tokens
//   lead capture: capture_fields, booking_url, cta_text
//   look: widget_color, widget_position, brand_name, whatsapp, contact_url
//   status: enabled, away_message

import { createClient } from "npm:@supabase/supabase-js@2";
import { notifyNewLead } from "../_shared/notify.ts";
import { scoreLead } from "../_shared/score.ts";
import { firstStageKey } from "../_shared/stage.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
// Model chain, tried in order.
//
// 2026-08-19 incident: Groq shut down `llama-3.3-70b-versatile` for free and
// developer tiers on 2026-08-16. Every org had model = null, so all of them
// fell through to that one hardcoded constant and the agent broke everywhere
// at once. Last good reply 08-16 20:34, first failure 08-17.
//
// The lesson isn't "pick a better model" — it's that a single hardcoded model
// is a single point of failure against a provider that deprecates on its own
// schedule. So: a chain. If one model is gone, the next is tried, and the
// failure is logged loudly instead of silently becoming an apology to a
// customer.
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const FALLBACK_MODELS = ["qwen/qwen3.6-27b", "llama-3.1-8b-instant"];
const BOOKING_URL = Deno.env.get("BOOKING_URL") || "https://calendly.com/mridulnanda2004/abrobot-meet";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+?\d[\d\s\-()]{8,}\d)/;
function normPhone(p?: string | null): string | null {
  if (!p) return null;
  const d = p.replace(/[^\d+]/g, "");
  if (d.replace("+", "").length < 8) return null;
  if (/^\d{10}$/.test(d)) return "+91" + d;
  return d.startsWith("+") ? d : "+" + d;
}
function grabName(t: string): string | null {
  const m = t.match(/\b(?:my name is|i am|i'm|this is|name[:\-]?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  return m ? m[1].trim().slice(0, 60) : null;
}

/**
 * Strip chain-of-thought before it reaches a visitor.
 *
 * Reasoning-capable models emit their scratchpad in <think> tags, and Groq
 * passes it straight through in message.content. Measured on the live abrobot
 * org: 2 of 4 replies to an ordinary question ("which universities suit a 7.0
 * IELTS?") began with a full "Here's a thinking process:" block. Visitors on
 * the highest-traffic site were seeing the model deliberate about them.
 *
 * Three cases, because the failure modes differ:
 *   1. well-formed <think>...</think>  -> drop the block
 *   2. an opening <think> that never closes (hit the token limit mid-thought)
 *      -> everything after it is scratchpad, so drop to the end
 *   3. a stray closing </think> with no opener (the model started reasoning
 *      before the first token we captured) -> keep only what follows
 *
 * Returns "" when the reply was ENTIRELY scratchpad. That is deliberate: the
 * caller treats empty as "no content" and falls through to the next model in
 * the chain, which is the right outcome — the generation genuinely failed.
 * Returning the raw text instead would print the model's reasoning to the
 * visitor, which is the exact bug this function exists to prevent.
 */
function stripReasoning(raw: string): string {
  let t = raw;
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "");   // 1
  t = t.replace(/<think>[\s\S]*$/i, "");             // 2
  t = t.replace(/^[\s\S]*?<\/think>/i, "");          // 3
  t = t.replace(/<\/?think>/gi, "").trim();
  return t;
}

// quick_replies text -> [{label, prompt}]
function parseChips(text?: string | null): { label: string; prompt: string }[] {
  if (!text) return [];
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 8).map((l) => {
    const i = l.indexOf("|");
    if (i > -1) return { label: l.slice(0, i).trim(), prompt: l.slice(i + 1).trim() };
    return { label: l.length > 26 ? l.slice(0, 24) + "…" : l, prompt: l };
  });
}

// Public widget config (no secrets) — used by widget.js to render itself.
function publicConfig(org: any, cfg: any) {
  const brand = cfg?.brand_name || org?.name || "AbroBot";
  return {
    enabled: cfg?.enabled !== false,
    agent_name: cfg?.agent_name || `${brand} AI`,
    header_title: cfg?.header_title || `${brand} AI`,
    header_subtitle: cfg?.header_subtitle || "Study-abroad assistant · online",
    greeting: cfg?.greeting ||
      `Hi there! 👋 I'm the ${brand} AI assistant. Ask me anything about universities, scholarships, visas or SOPs — or tell me your goal and I'll guide you personally.`,
    teaser: cfg?.teaser || `Hi there 👋 I'm ${brand} AI — ask me anything!`,
    quick_replies: parseChips(cfg?.quick_replies) .length ? parseChips(cfg?.quick_replies) : [
      { label: "🎓 Universities", prompt: "Which universities suit my profile?" },
      { label: "💰 Scholarships", prompt: "What scholarships can I get for studying abroad?" },
      { label: "🛂 Visa help", prompt: "Can you help me with my student visa?" },
    ],
    cta_text: cfg?.cta_text || "📅 Book a free call",
    booking_url: cfg?.booking_url || BOOKING_URL,
    contact_url: cfg?.contact_url || "https://www.abrobot.ai/contactus",
    whatsapp: cfg?.whatsapp || null,
    widget_color: cfg?.widget_color || "#f97316",
    widget_position: cfg?.widget_position === "left" ? "left" : "right",
    logo_url: cfg?.logo_url || null,
    brand: brand,
    away_message: cfg?.away_message || null,
  };
}

function buildSystemPrompt(cfg: any, brand: string, bookingUrl: string): string {
  const parts: string[] = [];
  parts.push(cfg?.knowledge || `You are a helpful, knowledgeable study-abroad counsellor for ${brand}.`);
  if (cfg?.persona) parts.push(`Persona: ${cfg.persona}`);
  parts.push(`You are "${cfg?.agent_name || brand + " AI"}", chatting with a visitor on the ${brand} website.`);
  parts.push(
    `STYLE — BE VERY BRIEF. This is a chat, not an essay. Reply in AT MOST 2–3 short sentences or 3–4 one-line bullets. ` +
    `Never write long paragraphs or repeat yourself. Get to the point in the first line; easy to scan on a phone.`,
  );
  if (cfg?.tone) parts.push(`Tone: ${cfg.tone}.`);
  if (cfg?.languages) parts.push(`You may reply in these languages if the visitor uses them: ${cfg.languages}. Default to the visitor's language.`);

  const fields = (cfg?.capture_fields || "name,phone,email").split(",").map((s: string) => s.trim()).filter(Boolean);
  if (fields.length) {
    parts.push(
      `LEAD CAPTURE: naturally collect the visitor's ${fields.join(", ")} in one friendly message before giving detailed personal guidance. ` +
      `Ask once, don't nag; if they skip it, keep helping and ask again later.`,
    );
  }
  parts.push(
    `CLOSER BEHAVIOUR: (1) INSTANT FREE ASSESSMENT — once you know their target country, study level and rough background, give a tight structured read: a one-line fit note, a cautious sense of visa/admission competitiveness (never a guarantee), 1–2 example university/course directions, and the single most important next step. ` +
    (bookingUrl
      ? `(2) BOOK A FREE CALL — when engaged or asked about applications/packages/visas/scholarships, warmly offer to book a free counselling call here: ${bookingUrl} . Frame it as help, not a sale. Offer once, don't nag.`
      : `(2) NEXT STEP — when engaged, warmly offer to connect them with a ${brand} counsellor.`),
  );
  parts.push(`Never guarantee visas, admissions or scholarships. If unsure, say details vary and recommend speaking to the ${brand} team.`);
  if (cfg?.guardrails) parts.push(`STRICT RULES — never break these: ${cfg.guardrails}`);
  return parts.join("\n\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  // The org came only from ?org=. widget.js sends it there, so production was
  // fine — but the widget ALSO puts org in the POST body, and that copy was
  // silently ignored. Anyone integrating from the body alone (as I did while
  // testing) got served AbroBot's agent and knowledge base under someone
  // else's brand, with no error. Defaulting a tenant identifier is the
  // dangerous part; read the body as a fallback and keep the default only for
  // the legacy embeds that rely on it.
  let slug = (url.searchParams.get("org") || "").toLowerCase().trim();

  // ---------- public widget config (GET) ----------
  if (req.method === "GET") {
    // GET has no body, so the legacy "abrobot" default is preserved here or
    // any old embed without ?org= would silently render nothing.
    const gslug = slug || "abrobot";
    const { data: org } = await supabase.from("organizations").select("id, name, active").eq("slug", gslug).single();
    if (!org?.active) return json({ enabled: false });
    const { data: cfg } = await supabase.from("agent_config").select(
      "agent_name, enabled, greeting, teaser, header_title, header_subtitle, quick_replies, cta_text, widget_color, widget_position, booking_url, contact_url, whatsapp, brand_name, logo_url, away_message",
    ).eq("org_id", org.id).single();
    return json(publicConfig(org, cfg));
  }

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const message = (body.message ?? "").toString().slice(0, 2000).trim();
  if (!message) return json({ error: "empty message" }, 400);

  // Query string wins; body is the fallback; "abrobot" only if neither is given.
  slug = slug || (body.org ?? "").toString().toLowerCase().trim() || "abrobot";

  // `plan` is selected for the usage-limit check further down.
  const { data: org } = await supabase.from("organizations").select("id, name, active, plan").eq("slug", slug).single();
  if (!org?.active) return json({ error: "agent unavailable" }, 404);

  const { data: cfg } = await supabase.from("agent_config").select(
    "agent_name, knowledge, enabled, groq_api_key, booking_url, brand_name, whatsapp, contact_url, " +
    "persona, tone, temperature, model, max_tokens, capture_fields, languages, guardrails, away_message",
  ).eq("org_id", org.id).single();

  const brand = cfg?.brand_name || cfg?.agent_name || org.name || "our team";
  const bookingUrl = cfg?.booking_url || BOOKING_URL;
  const waLine = cfg?.whatsapp ? ` or WhatsApp us at ${cfg.whatsapp}` : "";

  if (cfg && cfg.enabled === false) {
    return json({ reply: cfg.away_message || `Our AI assistant is currently offline. Please reach ${brand}${waLine} and our team will help you.` });
  }

  const groqKey = (cfg?.groq_api_key || GROQ_KEY).trim();

  // Get or create conversation
  let convId: string | null = body.conversation_id ?? null;
  if (convId) {
    const { data } = await supabase.from("conversations").select("id").eq("id", convId).eq("org_id", org.id).single();
    if (!data) convId = null;
  }
  if (!convId) {
    const { data } = await supabase.from("conversations").insert({ org_id: org.id, page_url: body.page_url ?? null }).select("id").single();
    convId = data!.id;
  }

  const { data: history } = await supabase.from("chat_messages")
    .select("role, content").eq("conversation_id", convId).order("created_at").limit(20);

  await supabase.from("chat_messages").insert({ conversation_id: convId, org_id: org.id, role: "user", content: message });

  // --- capture contact details ---
  // Declared out here so the final response can report a failed capture.
  // Silence is the bug: the visitor gets a normal reply either way, so if we
  // do not say so, nobody ever learns the enquiry was lost.
  let captureFailed: string | null = null;

  const convText = (history ?? []).map((h) => h.content).join("\n") + "\n" + message;
  const email = (convText.match(EMAIL_RE) || [])[0]?.toLowerCase() || null;
  const phone = normPhone((convText.match(PHONE_RE) || [])[0] || null);
  const name = grabName(convText);
  if (email || phone) {
    await supabase.from("conversations").update({ visitor_name: name, visitor_email: email, visitor_phone: phone }).eq("id", convId);
    let q = supabase.from("leads").select("id").eq("org_id", org.id);
    if (email && phone) q = q.or(`email.eq.${email},phone.eq.${phone}`);
    else if (email) q = q.eq("email", email); else q = q.eq("phone", phone!);
    const { data: existing } = await q.limit(1);
    let leadId = existing?.[0]?.id;
    if (!leadId) {
      const leadName = name || email?.split("@")[0] || phone || "Website chat";
      // a chat lead has already engaged — count the turns so far
      const { score } = scoreLead({
        email, phone, stage: "new",
        engagement_count: Math.ceil(((history?.length ?? 0) + 1) / 2),
      });
      // This is the whole point of the widget: a visitor just gave us their
      // contact details. The error used to be discarded, so a rejected insert
      // (plan limit, expired plan, RLS, a bad enum) produced a perfectly
      // normal-looking reply, HTTP 200, no alert, no activity, and no trace
      // anywhere that a real enquiry had been dropped. Exactly the shape of
      // the app-signup bug that silently binned every signup for two months.
      // See _shared/stage.ts — defaulting to 'new' hid widget-captured leads
      // from the Pipeline board for every non-study-abroad tenant.
      const stageKey = await firstStageKey(supabase, org.id);

      const { data: lead, error: leadErr } = await supabase.from("leads").insert({
        org_id: org.id, name: leadName,
        email, phone, source: "website", score, stage_key: stageKey,
        next_follow_up_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      }).select("id").single();

      if (leadErr) {
        // Loud, and visible to system-health, which already watches this org.
        console.error(
          `chat-agent: LEAD CAPTURE FAILED for org ${org.id} (${org.name}) — ` +
          `${leadErr.code ?? "?"} ${leadErr.message}. Contact was: ` +
          `${email ?? "no email"} / ${phone ?? "no phone"}`,
        );
        captureFailed = leadErr.message;
      }

      leadId = lead?.id;
      if (leadId) {
        await supabase.from("activities").insert({
          org_id: org.id, lead_id: leadId, type: "system", content: "Lead captured by AI chat agent on the website.",
        });
        // best-effort — a failed alert must never break the chat reply
        await notifyNewLead(supabase, org.id, {
          id: leadId, name: leadName, email, phone, source: "website",
          score, message,
        });
      }
    }
    if (leadId) await supabase.from("conversations").update({ lead_id: leadId }).eq("id", convId);
  }

  // --- plan limit enforcement ---
  //
  // Until now nothing checked credits outside the browser, which meant the
  // limits were advisory: anyone calling this endpoint directly, or simply
  // leaving the widget open, consumed unlimited AI messages. A limit enforced
  // only in the client is not a limit.
  //
  // consume_usage() increments and checks atomically, so two concurrent chats
  // cannot both slip past the last credit.
  try {
    // Reading plan_limits by org.plan here was subtly wrong: organizations.plan
    // records what was PURCHASED, not whether it is still live. An org whose
    // subscription lapsed six months ago still has plan='growth' and would keep
    // its 5,000 monthly messages. consume_usage now resolves the limit itself
    // via plan_of(), which accounts for trial and subscription expiry.
    const { data: usage } = await supabase.rpc("consume_usage", {
      p_org_id: org.id,
      p_metric: "ai_messages",
      p_amount: 1,
    });

    if (usage && usage.allowed === false) {
      // Deliberately warm rather than a raw 429: this message is read by a
      // prospective customer of *our customer*, not by a developer.
      const overMsg = cfg?.away_message?.trim() ||
        `Thanks for reaching out! Our assistant is taking a short break. ` +
        `Please leave your phone or email and the ${brand} team will get straight back to you.`;
      await supabase.from("chat_messages").insert({
        conversation_id: convId, org_id: org.id, role: "assistant", content: overMsg,
      });
      return json({ reply: overMsg, conversation_id: convId, limited: true });
    }
  } catch (e) {
    // Never block a real conversation because metering failed.
    console.error("usage check failed, allowing through:", (e as Error).message);
  }

  // --- build Groq request from full config ---
  const system = buildSystemPrompt(cfg, brand, bookingUrl);
  const messages = [
    { role: "system", content: system },
    ...(history ?? []).map((h) => ({ role: h.role === "assistant" ? "assistant" : "user", content: h.content })),
    { role: "user", content: message },
  ];

  let reply = `Sorry, I'm having trouble right now. Please reach ${brand}${waLine} and our team will help you.`;

  // Retry on transient failures.
  //
  // Measured 2026-08-18: 8 of 165 assistant replies were this fallback,
  // clustered on three dates rather than spread evenly — the signature of
  // free-tier rate limiting during traffic bursts, not a broken key.
  //
  // Two bugs were causing every one of those to reach a real visitor:
  //   1. a single attempt, so any blip lost the conversation
  //   2. a 429 does NOT throw — it returns JSON with no `choices`, so the
  //      catch block never ran and the failure was completely silent
  // Now: up to 3 attempts with backoff, and every failure is logged so it
  // shows up in the function logs instead of only in the transcript.
  // Try each model in turn; retry transient failures within a model.
  const chain = [cfg?.model || DEFAULT_MODEL, ...FALLBACK_MODELS]
    .filter((m, i, arr) => m && arr.indexOf(m) === i);
  const ATTEMPTS = 2;
  let got = false;

  outer:
  for (const model of chain) {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
          body: JSON.stringify({
            model,
            temperature: typeof cfg?.temperature === "number" ? cfg.temperature : 0.5,
            max_tokens: cfg?.max_tokens || 350,
            messages,
          }),
        });

        if (r.ok) {
          const data = await r.json();
          const text = data?.choices?.[0]?.message?.content;
          // An all-scratchpad reply strips to "" and is treated as no content,
          // so the loop tries the next model rather than printing reasoning.
          const clean = text ? stripReasoning(text) : "";
          if (clean) { reply = clean; got = true; break outer; }
          console.error(
            `groq ${model}: ok but no usable content${text ? " (reasoning only)" : ""}:`,
            JSON.stringify(data).slice(0, 300),
          );
        } else {
          const body = await r.text();
          console.error(`groq ${model} -> ${r.status} (attempt ${attempt}): ${body.slice(0, 300)}`);
          // 400/404 = model gone or bad request: move to the next model
          // rather than retrying something that will never work.
          // 401/403 = the key itself is wrong; no model will help.
          if (r.status === 401 || r.status === 403) break outer;
          if (r.status !== 429 && r.status < 500) break; // next model
        }
      } catch (e) {
        console.error(`groq ${model} threw (attempt ${attempt}):`, (e as Error).message);
      }

      if (attempt < ATTEMPTS) await new Promise((res) => setTimeout(res, 500));
    }
  }

  if (!got) {
    console.error(`ALL MODELS FAILED for org ${org.id}; chain: ${chain.join(", ")}`);
  }

  await supabase.from("chat_messages").insert({ conversation_id: convId, org_id: org.id, role: "assistant", content: reply });
  await supabase.from("conversations").update({
    last_message_at: new Date().toISOString(),
    message_count: ((history?.length ?? 0) + 2),
  }).eq("id", convId);

  // capture_failed is surfaced deliberately. The widget ignores it, so the
  // visitor's experience is unchanged — but it turns a silent loss into
  // something system-health and the function logs can both see.
  return json(captureFailed
    ? { reply, conversation_id: convId, capture_failed: captureFailed }
    : { reply, conversation_id: convId });
});