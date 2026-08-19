// AbroBot CRM — AI conversation summariser (Groq, free tier).
// Deploy:  supabase functions deploy summarize-chats --no-verify-jwt
// Secret:  GROQ_API_KEY  (already set for chat-agent)
//
// POST { org: "abrobot", conversation_ids: ["uuid", ...] }
//  -> { summaries: { "<conversation_id>": { summary, interest } } }
//
// Transcripts are read server-side (service role) scoped to the org, so the
// endpoint can only summarise that org's real conversations — it can't be used
// as a free LLM proxy for arbitrary text.

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
// See the note in chat-agent: llama-3.3-70b-versatile was shut down by Groq on
// 2026-08-16 for free/developer tiers. Keep this in step with chat-agent's
// DEFAULT_MODEL.
const MODEL = "openai/gpt-oss-120b";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

const MAX_CONVOS = 150;     // cap per export request
const BATCH = 8;            // conversations per Groq call
const MAX_CHARS = 1800;     // transcript trim per conversation

async function summariseBatch(items: { id: string; transcript: string }[]) {
  const sys =
    "You summarise study-abroad website chat conversations for a CRM used by counsellors in India. " +
    "For EACH conversation produce: a 'summary' of at most 2 short sentences capturing what the visitor " +
    "wants (country, program level, intake, topics like scholarships/visa/fees/tests) and whether they " +
    "shared contact details / became a lead; and 'interest' as short middot-separated tags " +
    "(e.g. 'Canada · Masters · scholarships'). Be factual, no fluff. " +
    'Return ONLY valid JSON of the form {"summaries":[{"id":"...","summary":"...","interest":"..."}]}.';
  const user = JSON.stringify(items.map((it) => ({ id: it.id, transcript: it.transcript.slice(0, MAX_CHARS) })));

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 1600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: "Conversations:\n" + user },
      ],
    }),
  });
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content ?? "{}";
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  const arr = Array.isArray(parsed?.summaries) ? parsed.summaries : [];
  const out: Record<string, { summary: string; interest: string }> = {};
  for (const s of arr) {
    if (s && s.id) out[String(s.id)] = { summary: String(s.summary || ""), interest: String(s.interest || "") };
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!GROQ_KEY) return json({ error: "summariser not configured" }, 503);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  const { data: org } = await supabase.from("organizations")
    .select("id, active").eq("slug", body.org ?? "abrobot").single();
  if (!org?.active) return json({ error: "org unavailable" }, 404);

  const ids: string[] = Array.isArray(body.conversation_ids)
    ? body.conversation_ids.filter((x: unknown) => typeof x === "string").slice(0, MAX_CONVOS)
    : [];
  if (!ids.length) return json({ summaries: {} });

  // Fetch messages for these conversations, scoped to the org.
  const { data: msgs } = await supabase.from("chat_messages")
    .select("conversation_id, role, content, created_at")
    .eq("org_id", org.id).in("conversation_id", ids).order("created_at");

  const byConv: Record<string, { role: string; content: string }[]> = {};
  (msgs ?? []).forEach((m) => { (byConv[m.conversation_id] ||= []).push(m); });

  const items = ids
    .filter((id) => byConv[id]?.length)
    .map((id) => ({
      id,
      transcript: byConv[id].map((m) => `${m.role === "user" ? "Visitor" : "AI"}: ${m.content}`).join("\n"),
    }));

  const summaries: Record<string, { summary: string; interest: string }> = {};
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    try {
      Object.assign(summaries, await summariseBatch(chunk));
    } catch (_e) { /* skip chunk; client falls back to heuristic */ }
  }

  return json({ summaries });
});
