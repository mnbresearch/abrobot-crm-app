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
import { fetchWithTimeout } from "../_shared/http.ts";
// Contact extraction lives in _shared/capture.ts so that chat-agent,
// lead-webhook and the public API cannot disagree about what a phone number is.
// They previously held three separate normalisers with three different rules,
// which meant the same person normalised differently depending on which door
// they came through — and therefore did not dedupe against themselves.
import { EMAIL_RE, PHONE_RE, normPhone, grabName, displayName } from "../_shared/capture.ts";

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
// 2026-09-11 correction. The chain above was written after that incident and
// then rotted in exactly the same way it was meant to prevent:
//
//   llama-3.1-8b-instant  — shut down by Groq on 2026-08-16, the same day as
//                           llama-3.3-70b. It has been a dead entry in the
//                           fallback chain ever since, so the chain was really
//                           two models, not three.
//   qwen/qwen3.6-27b      — alive, but a PREVIEW model, which Groq's own
//                           deprecation policy says is "for evaluation, not
//                           production, and may be discontinued at short
//                           notice". It is also a reasoning model priced at
//                           $0.60/$3.00 — 4x input and 5x output of the
//                           primary. A month spent on it costs more than the
//                           subscription it is serving.
//
// gpt-oss-20b is the same family as the primary, generally available, and
// roughly half its price — so falling back now gets CHEAPER rather than 16x
// more expensive, which is the right direction for an unattended failover.
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const FALLBACK_MODELS = ["openai/gpt-oss-20b"];

// There is deliberately NO cross-tenant booking fallback any more — not a
// hardcoded one, and not an environment one either.
//
// This used to be `Deno.env.get("BOOKING_URL") || "<AbroBot's Calendly>"`.
// Removing only the literal would have changed nothing: BOOKING_URL is a
// deployed secret on this project (app-signup relies on it), so every tenant
// with a NULL booking_url — which was all of them, since nothing seeded it —
// would still have had an AI offering AbroBot's calendar to their own
// customers. The env var is now read by the functions that legitimately act
// as AbroBot, and by nothing that acts on a tenant's behalf.
//
// A missing booking link is a small gap, and publicConfig returns null so the
// widget simply hides the button. Another company's booking link on your
// website is not a gap, it is an incident.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });


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
//
// ── Every default in here used to be AbroBot's ──────────────────────────────
// Not as an error path: as the SUCCESS path for every organisation on the
// platform. create_organisation seeds four fields and apply_industry_pack two
// more; everything else was NULL, and NULL fell through to this function's
// study-abroad copy. A dental clinic's website showed "Study-abroad assistant ·
// online", greeted patients about universities and visas, and offered AbroBot's
// Calendly.
//
// 20260911090000 fixes the data half — industry packs now seed greeting,
// subtitle, chips and knowledge, and every existing org was backfilled. This is
// the other half: what is left when even that has not run. The rule now is that
// a default must be true for ANY business, or it must be absent. An empty
// booking link is a gap; another company's booking link is an incident.
function publicConfig(org: any, cfg: any) {
  const brand = (cfg?.brand_name || org?.name || "").trim();
  const named = brand || "our team";
  return {
    enabled: cfg?.enabled !== false,
    agent_name: cfg?.agent_name || (brand ? `${brand} Assistant` : "Assistant"),
    header_title: cfg?.header_title || (brand ? brand : "Assistant"),
    header_subtitle: cfg?.header_subtitle || "Online",
    greeting: cfg?.greeting ||
      `Hi 👋 How can we help? Tell me what you're looking for and I'll point you the right way.`,
    teaser: cfg?.teaser || (brand ? `Hi 👋 Ask ${brand} anything` : "Hi 👋 How can we help?"),
    // No industry-flavoured fallback chips. Generic openers work for a clinic,
    // a dealership and a law firm alike; "🎓 Scholarships" works for one
    // business in fourteen and is actively wrong for the other thirteen.
    quick_replies: parseChips(cfg?.quick_replies).length ? parseChips(cfg?.quick_replies) : [
      { label: "💬 What you do", prompt: "What do you do?" },
      { label: "💰 Pricing", prompt: "How much does it cost?" },
      { label: "📅 Talk to someone", prompt: "I'd like to speak to someone." },
    ],
    cta_text: cfg?.cta_text || "📅 Book a call",
    // Null rather than a fallback, on both of these. widget.js hides the button
    // when there is no URL, which is the correct behaviour for a business that
    // has not set one.
    booking_url: cfg?.booking_url || null,
    contact_url: cfg?.contact_url || null,
    whatsapp: cfg?.whatsapp || null,
    // A neutral slate rather than AbroBot orange. apply_industry_pack does not
    // set a colour, so this is what most tenants will actually render until
    // they pick one in Settings.
    widget_color: cfg?.widget_color || "#2f3a4a",
    widget_position: cfg?.widget_position === "left" ? "left" : "right",
    logo_url: cfg?.logo_url || null,
    brand: named,
    away_message: cfg?.away_message || null,
  };
}

function buildSystemPrompt(cfg: any, brand: string, bookingUrl: string): string {
  const parts: string[] = [];
  // `knowledge` is seeded as '' by create_organisation, and '' is falsy — so
  // this fallback was reached by EVERY new tenant, and it told all of them they
  // were study-abroad counsellors. The industry packs now seed real knowledge
  // (20260911090000); this is what is left if even that is missing, and it has
  // to be true of any business at all.
  parts.push(
    cfg?.knowledge ||
      `You are the assistant on ${brand}'s website. You help visitors with what ${brand} offers ` +
      `and take their enquiry. You have NOT been told the specifics of this business, so do not ` +
      `invent any: no prices, services, timings, availability, locations or credentials. When you ` +
      `do not know something, say so plainly and offer to take their details so a colleague can ` +
      `answer properly.`,
  );
  if (cfg?.persona) parts.push(`Persona: ${cfg.persona}`);
  parts.push(`You are "${cfg?.agent_name || brand + " Assistant"}", chatting with a visitor on the ${brand} website.`);
  parts.push(
    `STYLE — BE VERY BRIEF. This is a chat, not an essay. Reply in AT MOST 2–3 short sentences or 3–4 one-line bullets. ` +
    `Never write long paragraphs or repeat yourself. Get to the point in the first line; easy to scan on a phone.`,
  );
  if (cfg?.tone) parts.push(`Tone: ${cfg.tone}.`);
  if (cfg?.languages) parts.push(`You may reply in these languages if the visitor uses them: ${cfg.languages}. Default to the visitor's language.`);

  const fields = (cfg?.capture_fields || "name,phone,email").split(",").map((s: string) => s.trim()).filter(Boolean);
  if (fields.length) {
    // ── Ask for ONE field, not the whole set ────────────────────────────────
    //
    // This used to say "collect the visitor's name, phone, email in one
    // friendly message", and the model did exactly that: it rendered a form.
    // Real transcripts show replies like
    //
    //     "To match you with the best scholarships, I'll need a few quick
    //      details: • Full Name *** • Phone Number with +91 *** • Email ***"
    //
    // — three required fields, with asterisks, to a stranger who had asked one
    // question. Across 139 conversations the bot asked in 110 of them and
    // **93 of those visitors left without answering**.
    //
    // The counter-evidence is in the same data: a visitor who sends three or
    // more messages converts 14 times out of 20. The bot is good at this once
    // a conversation exists. The three-field form is what stops one existing —
    // 97 of 139 conversations are a single message.
    //
    // So: still ask early, but ask for one thing, in one sentence, attached to
    // an answer rather than in place of one. `fields[0]` is the org's own
    // first choice in capture_fields, so a tenant reorders that column to
    // change what gets asked for first.
    const first = fields[0];
    const rest = fields.slice(1);
    parts.push(
      `LEAD CAPTURE: ask for the visitor's ${first} — and ONLY their ${first} — as a single short ` +
      `sentence at the end of your reply. Never present a form, a bulleted list of fields, ` +
      `asterisks, or the word "required", and never ask for more than one detail in a message. ` +
      (rest.length
        ? `Once they have given their ${first} and you have helped them further, you may ask for their ` +
          `${rest.join(" or ")} later in the same natural way — one at a time, never together. `
        : "") +
      `If they ignore or decline it, drop it completely and keep helping; ask again at most once, ` +
      `and only after two more useful exchanges. A visitor who keeps talking is worth far more ` +
      `than a contact detail extracted early, so never withhold an answer to get one.`,
    );
  }
  // This block used to be unconditional and entirely study-abroad: it told a
  // dental clinic's model to establish the patient's "target country and study
  // level", assess "visa/admission competitiveness", suggest "university/course
  // directions" and offer AbroBot's Calendly. The industry persona was appended
  // AFTER it, producing a genuinely self-contradictory prompt.
  //
  // What is actually generic about a good closer is: give a useful answer, then
  // offer the concrete next step this business has configured.
  parts.push(
    `CLOSER BEHAVIOUR: (1) BE USEFUL FIRST — answer the question properly before steering anywhere. ` +
    `Once you understand what the visitor needs, give the single most useful next step. ` +
    (bookingUrl
      ? `(2) OFFER THE NEXT STEP — when they are engaged, warmly offer to book a call here: ${bookingUrl} . Frame it as help, not a sale. Offer once, don't nag.`
      : `(2) OFFER THE NEXT STEP — when they are engaged, offer to have someone from ${brand} follow up, and take their contact details.`),
  );
  parts.push(
    `Never guarantee an outcome, a result, an approval or a price. If you are unsure, say details vary ` +
    `and recommend speaking to the ${brand} team rather than guessing.`,
  );
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
    // No org named, no config. This used to default to "abrobot", which meant
    // a request with no ?org= received AbroBot's greeting, colour, logo and
    // booking link — a cross-tenant default on a public endpoint. widget.js
    // already refuses to render without data-org, so nothing legitimate relies
    // on the fallback; anything that hits it is misconfigured and should be
    // told so rather than handed a stranger's branding.
    if (!slug) return json({ enabled: false, error: "no organisation specified" });
    const { data: org } = await supabase.from("organizations").select("id, name, active").eq("slug", slug).single();
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

  // Query string wins, body is the fallback, and there is no third option —
  // see the GET branch above for why defaulting to a real tenant is not one.
  slug = slug || (body.org ?? "").toString().toLowerCase().trim();
  if (!slug) return json({ error: "no organisation specified" }, 400);

  // `plan` is selected for the usage-limit check further down.
  const { data: org } = await supabase.from("organizations").select("id, name, active, plan").eq("slug", slug).single();
  if (!org?.active) return json({ error: "agent unavailable" }, 404);

  // The cast is load-bearing for the typechecker, not cosmetic. supabase-js
  // parses the select string at the *type* level to build the row type, and it
  // can only do that for a string literal — this one is concatenated across two
  // lines, so inference falls back to a union containing GenericStringError and
  // every property access below becomes a compile error. Deno check runs in CI,
  // so that is a broken build, not a squiggle.
  //
  // Splitting it into one long literal would also work and is uglier; naming
  // the shape here at least documents what this function actually needs.
  const { data: cfg } = await supabase.from("agent_config").select(
    "agent_name, knowledge, enabled, groq_api_key, booking_url, brand_name, whatsapp, contact_url, " +
    "persona, tone, temperature, model, max_tokens, capture_fields, languages, guardrails, away_message",
  ).eq("org_id", org.id).single() as {
    data: {
      agent_name: string | null; knowledge: string | null; enabled: boolean | null;
      groq_api_key: string | null; booking_url: string | null; brand_name: string | null;
      whatsapp: string | null; contact_url: string | null; persona: string | null;
      tone: string | null; temperature: number | null; model: string | null;
      max_tokens: number | null; capture_fields: unknown; languages: unknown;
      guardrails: string | null; away_message: string | null;
    } | null;
  };

  const brand = cfg?.brand_name || cfg?.agent_name || org.name || "our team";
  const bookingUrl = cfg?.booking_url || "";
  const waLine = cfg?.whatsapp ? ` or WhatsApp us at ${cfg.whatsapp}` : "";

  if (cfg && cfg.enabled === false) {
    return json({ reply: cfg.away_message || `Our AI assistant is currently offline. Please reach ${brand}${waLine} and our team will help you.` });
  }

  const groqKey = (cfg?.groq_api_key || GROQ_KEY).trim();

  // --- rate limit ---
  //
  // This endpoint has to stay open: the widget runs on a visitor's browser and
  // the org comes from the page, so there is no key to require. But org slugs
  // are public — they are in the embed snippet — and there was no limit of any
  // kind. Anyone could drain a competitor's monthly AI allowance to zero, at
  // which point their widget starts telling real prospects it is "taking a
  // short break", and burn the Groq key they pay for.
  //
  // MOVED ABOVE THE WRITES (2026-09-11). This used to sit ~90 lines further
  // down, after the conversation insert, the history read, the user-message
  // insert and — on a first message that contains contact details — a lead
  // insert, an activity insert and a Telegram alert. So a request that was
  // about to be REFUSED still did six writes and burned an edge invocation.
  //
  // At 20/min that is 864,000 refused requests a month from a single IP, each
  // leaving rows behind: enough to fill the 500 MB free database and consume
  // the entire 500k free edge-function quota — breaking the platform for every
  // other tenant, not just the one being targeted. Refusing before we write is
  // the difference between a rate limit and an expensive way to say no.
  //
  // Per org+IP+minute. Not a defence against a distributed attacker, but it
  // turns "one script, one afternoon" into something requiring real effort.
  {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const { data: rl, error: rlErr } = await supabase.rpc("hit_rate_limit", {
      p_key: `chat:${org.id}:${ip}`, p_limit: 20, p_window_seconds: 60,
    });
    // Fail CLOSED, the same posture as consume_usage below. The error used to
    // be discarded, so an RPC failure left `rl` undefined and the request sailed
    // through — meaning the one condition most likely to coincide with an
    // attack (a database under load) was also the condition that switched the
    // rate limiter off.
    if (rlErr) {
      console.error("chat-agent: rate limit check failed, refusing:", rlErr.message);
      return json({
        reply: "We're having a busy moment — please try again in a few seconds.",
        rate_limited: true,
      }, 503);
    }
    if (rl && rl.allowed === false) {
      // No conversation_id: we deliberately have not created one. The widget
      // treats a missing id as "keep the one you have", so a real visitor who
      // types too fast keeps their thread.
      return json({
        reply: "You're sending messages very quickly — give me a moment and try again.",
        rate_limited: true,
      }, 429);
    }
  }

  // Get or create conversation
  let convId: string | null = body.conversation_id ?? null;
  // The lead this conversation is already tied to, if any. Read here because
  // it is the durable answer to "who is this visitor": the capture block
  // further down can only match against the last 20 messages, so once contact
  // details scroll out of that window it would otherwise create a second lead
  // for a person it had already recorded.
  let convLeadId: string | null = null;
  if (convId) {
    // A soft-deleted conversation must not keep accepting messages. Deletion
    // is enforced in RLS only and this runs as the service role, so without
    // the filter a thread the customer deleted stays live and keeps growing.
    const { data } = await supabase.from("conversations").select("id, lead_id")
      .eq("id", convId).eq("org_id", org.id).is("deleted_at", null).maybeSingle();
    if (!data) convId = null;
    else convLeadId = data.lead_id ?? null;
  }
  if (!convId) {
    const { data, error } = await supabase.from("conversations")
      .insert({ org_id: org.id, page_url: body.page_url ?? null }).select("id").single();
    // Was `data!.id`. A non-null assertion on an insert that can fail turns a
    // recoverable database hiccup into an unhandled TypeError, a 500, and
    // "Connection issue" in the visitor's chat window — for a conversation we
    // could simply have carried on without persisting.
    if (error || !data) {
      console.error("chat-agent: could not open a conversation:", error?.message);
      return json({
        reply: `Sorry — I couldn't start a chat session just now. Please reach ${brand}${waLine} and someone will help you.`,
      });
    }
    convId = data.id;
  }

  // Newest 20, then reversed back into chronological order.
  //
  // This was `.order("created_at").limit(20)`. `.order()` defaults to ASCENDING,
  // so it fetched the FIRST twenty messages, not the last. For the opening ten
  // turns that is indistinguishable from correct, which is why it survived —
  // but past turn twenty the model was prompted with a frozen window of the
  // conversation's opening and never saw anything the visitor said afterwards.
  //
  // It only breaks the long, engaged conversations: the ones about to convert.
  // And it reads as "the bot got dumb", not as a bug, so nobody reports it.
  const { data: historyDesc, error: historyErr } = await supabase.from("chat_messages")
    .select("role, content").eq("conversation_id", convId)
    .order("created_at", { ascending: false }).limit(20);

  // A failed history read is NOT an empty history, and the difference matters
  // three separate ways further down:
  //   * the model would be prompted with no context and answer as though the
  //     visitor had just arrived, mid-conversation;
  //   * `convText` is built from it, so contact details already given would
  //     scroll out of view and the capture block below would write nulls over
  //     details already stored (see the guard there);
  //   * `message_count` is derived from `history.length`, so a 40-message
  //     conversation would be stamped back down to 2.
  // Treat it as a transient failure and let the visitor retry, rather than
  // answering confidently from nothing.
  if (historyErr) {
    console.error(`chat-agent: could not read history for conversation ${convId}:`, historyErr.message);
    return json({
      reply: "Sorry, I'm having trouble reaching my notes for a moment. Could you send that again?",
      conversation_id: convId,
    });
  }
  const history = (historyDesc ?? []).slice().reverse();

  await supabase.from("chat_messages").insert({ conversation_id: convId, org_id: org.id, role: "user", content: message });

  // --- capture contact details ---
  // Declared out here so the final response can report a failed capture.
  // Silence is the bug: the visitor gets a normal reply either way, so if we
  // do not say so, nobody ever learns the enquiry was lost.
  let captureFailed: string | null = null;

  // VISITOR TURNS ONLY. This was `(history ?? []).map(h => h.content)`, which
  // included the assistant's own replies — and several of those replies embed
  // `cfg.whatsapp`, the tenant's own WhatsApp number:
  //
  //   "Sorry, I'm having trouble right now. Please reach {brand} or WhatsApp
  //    us at {cfg.whatsapp} and our team will help you."
  //
  // That reply is written to chat_messages, so on the NEXT turn PHONE_RE found
  // the business's own number in its own history and captured it as the
  // visitor's. One Groq blip, then any further message, and a lead was created
  // whose phone is the tenant's own switchboard. Worse, that number then became
  // the dedupe key, so every later visitor whose conversation hit the same
  // fallback MERGED INTO THAT ONE RECORD — dozens of real enquiries collapsing
  // into a single lead nobody could untangle.
  //
  // Reading contact details out of our own output was never intended; the
  // visitor is the only party whose details we are extracting.
  const visitorText = (history ?? [])
    .filter((h) => h.role !== "assistant")
    .map((h) => h.content)
    .join("\n");
  const convText = visitorText + "\n" + message;
  const email = (convText.match(EMAIL_RE) || [])[0]?.toLowerCase() || null;
  const phone = normPhone((convText.match(PHONE_RE) || [])[0] || null);
  const name = grabName(convText);
  if (email || phone) {
    // ── Only write what we actually found ──────────────────────────────────
    //
    // This wrote all three fields unconditionally from a 20-message window, so
    // the moment a visitor's email scrolled out of that window the update set
    // `visitor_email: null` and ERASED a detail already captured. `visitor_name`
    // was the most fragile of the three — `grabName` only matches an explicit
    // self-introduction, so it is usually null while email and phone are not.
    //
    // The damage compounds: with the stored identifier gone, the dedupe below
    // searches on whichever identifier survived, misses the lead created from
    // the other one, and creates a SECOND lead for the same person — counted
    // twice against the plan, alerted twice, and split across two records a
    // counsellor then works twice.
    const visitorPatch: Record<string, string> = {};
    if (name) visitorPatch.visitor_name = name;
    if (email) visitorPatch.visitor_email = email;
    if (phone) visitorPatch.visitor_phone = phone;
    if (Object.keys(visitorPatch).length) {
      const { error: convErr } = await supabase.from("conversations")
        .update(visitorPatch).eq("id", convId);
      if (convErr) {
        console.error(`chat-agent: could not attach visitor details to conversation ${convId}:`, convErr.message);
      }
    }
    // Excluding deleted records means a returning visitor whose record was
    // deleted gets a fresh one, rather than silently reviving the old one.
    let q = supabase.from("leads").select("id").eq("org_id", org.id)
      .is("deleted_at", null);
    // Strip PostgREST's delimiters before interpolating. or() is a
    // mini-language: a comma, parenthesis or quote in a value reshapes the
    // filter rather than being matched literally.
    //
    // Not currently exploitable — `email` comes from EMAIL_RE, which cannot
    // contain any of these, and `phone` from normPhone, which strips to digits
    // and +. But that is upstream sanitisation two functions away, invisible at
    // this call site, and one regex tweak from being wrong. lead-webhook
    // already escapes here for exactly this reason; this makes it consistent.
    const noDelims = (v: string) => v.replace(/[,()"']/g, "");
    if (email && phone) q = q.or(`email.eq.${noDelims(email)},phone.eq.${noDelims(phone)}`);
    else if (email) q = q.eq("email", email); else q = q.eq("phone", phone!);
    const { data: existing, error: existingErr } = await q.limit(1);

    // An errored dedupe read is not "no duplicate". `{ data: null, error }`
    // and "nothing matched" are the same shape here, and the branch below
    // treats absence as permission to CREATE — so a transient read failure
    // makes a second lead for someone already in the CRM. There is no unique
    // constraint on (org_id, email) to catch it downstream, so nothing does.
    //
    // Prefer the lead this conversation is ALREADY linked to. The window-based
    // lookup above can only see what is still in the last 20 messages; the
    // conversation's own lead_id is the durable answer and outlives it.
    //
    // On a failed dedupe read, `convLeadId` is the ONLY thing standing between
    // us and a duplicate — so it is used, not discarded. My first version of
    // this guard set `leadId = undefined` on error, wrote "fail closed" in a
    // comment, and then fell straight through to the insert below with nothing
    // to stop it: it created the duplicate it claimed to prevent, AND threw
    // away the one identifier that could have avoided it.
    let leadId = existingErr
      ? (convLeadId ?? undefined)
      : (existing?.[0]?.id ?? convLeadId ?? undefined);

    if (existingErr && !leadId) {
      // Genuinely cannot tell whether this person exists. Creating a record
      // now risks a duplicate with a second alert and a second plan charge;
      // skipping costs one turn, and the visitor's details are already on the
      // conversation row, so the next message retries the whole block. Skip.
      console.error(
        `chat-agent: dedupe read failed for org ${org.id} and this conversation has no lead yet — ` +
        `skipping capture this turn rather than risking a duplicate:`,
        existingErr.message,
      );
      captureFailed = `could not check for an existing record: ${existingErr.message}`;
    } else if (!leadId) {
      // displayName, not `|| phone`. The widget is the path that produced the live
      // record reading "👤 +918745821142" — lead-webhook was fixed first and this,
      // the one that actually caused it, was left on the old fallback.
      const leadName = displayName(name, email, phone);
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
        // A unique violation means someone else created this person between
        // our dedupe read and our insert — a visitor with two tabs open, or a
        // form submitted while the chat was running. That is not a capture
        // failure: the record exists. Re-read and adopt it, so the
        // conversation still gets linked and no alert is raised for a
        // non-event. Without this, the partial unique index on
        // (org_id, lower(email)) would turn a harmless race into a lost
        // enquiry reported as a capture failure.
        if (leadErr.code === "23505") {
          let rq = supabase.from("leads").select("id").eq("org_id", org.id).is("deleted_at", null);
          rq = email ? rq.eq("email", email) : rq.eq("phone", phone!);
          const { data: raced } = await rq.limit(1);
          if (raced?.[0]?.id) {
            console.warn(`chat-agent: concurrent capture for org ${org.id}, adopted ${raced[0].id}`);
            leadId = raced[0].id;
          } else {
            captureFailed = leadErr.message;
          }
        } else {
          // A plan-limit refusal is the one failure the TENANT can act on, and
          // until now it was the quietest. On the free plan inbound capture is
          // NOT exempt from the record cap, so once a free account reaches 50
          // records every subsequent website enquiry was refused with P0001,
          // logged to a function log nobody reads, and answered with a perfectly
          // normal AI reply. The visitor typed their phone number, got a helpful
          // answer, and left. No record, no alert, nothing on any screen.
          //
          // That is exactly the tier the widget exists to demonstrate, so the
          // first thing a trialling customer experienced was silent data loss.
          // Telling them on the FIRST lost enquiry rather than the hundredth is
          // the difference between a prompt to upgrade and a reason to leave.
          //
          // Deliberately non-fatal and awaited loosely: the visitor still gets
          // their answer either way, and a Telegram outage must not become a
          // chat outage.
          if (leadErr.code === "P0001") {
            // Shape matches NewLeadAlert exactly — `score` is omitted rather
            // than sent as 0, because buildMessage renders any number and
            // "⭐ Score 0/100" on an alert about a LOST enquiry is noise.
            // notifyNewLead resolves to an AlertResult and never rejects, so no
            // try/catch is needed and adding one would only hide a contract
            // change.
            const alerted = await notifyNewLead(supabase, org.id, {
              id: "capture-blocked",
              name: "⚠️ An enquiry could not be saved",
              email,
              phone,
              source: "website",
              message: `Your plan's record limit stopped this enquiry being saved. ${leadErr.message}`,
            });
            if (!alerted.sent) {
              console.error(
                `chat-agent: a capture was blocked for org ${org.id} AND the alert did not send ` +
                `(${alerted.reason}${alerted.detail ? ": " + alerted.detail : ""}). ` +
                `Nobody has been told this enquiry was lost.`,
              );
            }
          }
          // Loud, and visible to system-health, which already watches this org.
          console.error(
            `chat-agent: LEAD CAPTURE FAILED for org ${org.id} (${org.name}) — ` +
            `${leadErr.code ?? "?"} ${leadErr.message}. Contact was: ` +
            `${email ?? "no email"} / ${phone ?? "no phone"}`,
          );
          captureFailed = leadErr.message;
        }
      }

      leadId = leadId ?? lead?.id;
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
    // supabase-js RESOLVES with { error } rather than throwing, so the catch
    // below never fired for an RPC failure — only `data` was read, `usage` came
    // back null, `usage.allowed === false` was false, and the request sailed
    // through. "A limit enforced only in the client is not a limit" was still
    // true whenever this RPC erred.
    const { data: usage, error: usageErr } = await supabase.rpc("consume_usage", {
      p_org_id: org.id,
      p_metric: "ai_messages",
      p_amount: 1,
    });

    if (usageErr) {
      // Fail closed, but warmly — the reader is a visitor on our customer's
      // website, not an operator. We still capture their details below.
      console.error("chat-agent: consume_usage failed, refusing:", usageErr.message);
      const msg = cfg?.away_message?.trim() ||
        `Thanks for reaching out! Our assistant is briefly unavailable. ` +
        `Leave your phone or email and the ${brand} team will get straight back to you.`;
      await supabase.from("chat_messages").insert({
        conversation_id: convId, org_id: org.id, role: "assistant", content: msg,
      });
      return json({ reply: msg, conversation_id: convId, limited: true });
    }

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
    // Reaches here only for a genuine throw (network, not a Postgres error).
    console.error("usage check threw:", (e as Error).message);
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

  // Reasoning models spend tokens thinking BEFORE they answer, and that
  // thinking comes out of the same max_tokens budget as the reply.
  //
  // Observed live on 2026-09-03: abrobot's system prompt is ~14,600 characters
  // and "What does AbroBot cost?" is a question worth deliberating over. The
  // model used its entire 900-token budget on the <think> block and emitted no
  // answer at all. stripReasoning() correctly reduced that to "", the loop
  // treated it as no content, every model in the chain did the same thing, and
  // the visitor got the apology. A simple "Hi" on the same org still worked,
  // which is what made it look intermittent.
  //
  // So: give reasoning models headroom to think AND answer. The visible reply
  // is still bounded by the prompt's "2-3 short sentences" instruction — this
  // only stops the scratchpad from eating the answer.
  const REASONING_MODELS = ["gpt-oss", "qwen3", "deepseek-r1", "o1", "o3"];
  const isReasoning = (m: string) =>
    REASONING_MODELS.some((r) => m.toLowerCase().includes(r));
  const baseTokens = cfg?.max_tokens || 350;
  const tokensFor = (m: string) => (isReasoning(m) ? baseTokens + 900 : baseTokens);

  // Latency. Giving the model room to think fixed the empty replies but pushed
  // responses to ~7s, and a visitor deciding between us and a competitor does
  // not wait 7 seconds for a chat bubble.
  //
  // The cost is the thinking, not the model — so turn the thinking down rather
  // than dropping to a weaker model. Groq exposes two parameters on gpt-oss:
  //   reasoning_effort: "low"   — think briefly instead of exhaustively
  //   reasoning_format: "hidden" — keep the scratchpad OUT of message.content
  //
  // The second one is the proper fix for the <think> leak. stripReasoning()
  // stays as a belt-and-braces guard for any model that ignores the parameter,
  // but with "hidden" the reasoning should never reach us in the first place.
  //
  // Only sent to gpt-oss, which documents support. If Groq ever rejects them
  // the request 400s, and the retry below re-sends without them rather than
  // burning the primary model.
  const supportsReasoningParams = (m: string) => m.toLowerCase().includes("gpt-oss");

  outer:
  for (const model of chain) {
    // Dropped to false if Groq rejects the reasoning parameters, so the same
    // model gets a second chance plainly instead of being abandoned.
    let useReasoningParams = supportsReasoningParams(model);

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const payload: Record<string, unknown> = {
          model,
          temperature: typeof cfg?.temperature === "number" ? cfg.temperature : 0.5,
          // Reasoning models need room for the <think> block AND the answer.
          max_tokens: tokensFor(model),
          messages,
        };
        if (useReasoningParams) {
          payload.reasoning_effort = "low";
          payload.reasoning_format = "hidden";
        }

        const r = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
          body: JSON.stringify(payload),
        },
    // a reasoning model on the free tier can legitimately take 20s+; the fallback chain below handles a real failure
    25000,);

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

          // A 400 while we are sending reasoning_effort / reasoning_format is
          // most likely the parameters, not the model. Drop them and give this
          // model one more go before writing it off — otherwise a parameter
          // Groq renames some Tuesday would silently demote every org to the
          // weakest model in the chain, and the only symptom would be worse
          // answers that nobody can explain.
          if (r.status === 400 && useReasoningParams) {
            console.error(`groq ${model}: retrying without reasoning parameters`);
            useReasoningParams = false;
            continue;
          }

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

  // Both message inserts were unchecked. A refused insert leaves a hole in the
  // transcript that the CRM and `GET /api/v1/conversations/:id` both display,
  // and — because the next turn's history is read back from this table — the
  // model loses the exchange and can repeat itself with no trace of why.
  const { error: replyInsertErr } = await supabase.from("chat_messages")
    .insert({ conversation_id: convId, org_id: org.id, role: "assistant", content: reply });
  if (replyInsertErr) {
    console.error(`chat-agent: could not store the reply for conversation ${convId}:`, replyInsertErr.message);
  }

  // Ask the table, rather than inferring from a capped page.
  const { count: msgCount, error: countErr } = await supabase
    .from("chat_messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", convId);
  const totalMessages = countErr ? null : (msgCount ?? null);
  if (countErr) {
    console.error(`chat-agent: could not count messages for conversation ${convId}:`, countErr.message);
  }

  await supabase.from("conversations").update({
    last_message_at: new Date().toISOString(),
    // Counted at the source, not derived from the window.
    //
    // This was `history.length + 2`, an OVERWRITE computed from a read capped
    // at 20 — so the number saturated at 22 no matter how long the
    // conversation ran, and that is exactly where engagement starts to matter.
    // `api/index.ts` hands this figure to customer integrations and the CRM
    // shows it as conversation depth, so the metric a team would use to spot
    // an engaged visitor was pinned at its ceiling.
    //
    // A `count: "exact", head: true` query asks the database how many rows
    // there actually are; it cannot saturate and cannot be reset by a short
    // read. If the count fails, the column is left alone rather than being
    // stamped with a wrong number.
    ...(totalMessages !== null ? { message_count: totalMessages } : {}),
  }).eq("id", convId);

  // capture_failed is surfaced deliberately. The widget ignores it, so the
  // visitor's experience is unchanged — but it turns a silent loss into
  // something system-health and the function logs can both see.
  return json(captureFailed
    ? { reply, conversation_id: convId, capture_failed: captureFailed }
    : { reply, conversation_id: convId });
});