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

import { requireCronOrMember } from "../_shared/cron-auth.ts";
import { fetchWithTimeout } from "../_shared/http.ts";
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

/**
 * Summarise a batch of website chat transcripts.
 *
 * The prompt used to open "You summarise STUDY-ABROAD website chat
 * conversations … for counsellors in India" and asked for study-abroad tags by
 * name — country, programme level, intake, scholarships, visa, tests. This
 * function runs on a cron for every organisation on the platform, so a dental
 * clinic's patient enquiries were being summarised by a model told to look for
 * a target country and an intake, and tagged accordingly.
 *
 * Same cross-tenant class of bug as the widget defaults; it survived the first
 * sweep because nothing a visitor sees comes from here — only what the
 * CUSTOMER reads in their own Conversations screen.
 *
 * The replacement names no industry and prescribes no tag vocabulary. The
 * transcript already contains the subject matter, and a model asked for "the
 * topics that actually came up" will produce "root canal · Tuesday · cost" for
 * a clinic and "Canada · Masters · scholarships" for a consultancy without
 * being told which it is.
 */
async function summariseBatch(items: { id: string; transcript: string }[]) {
  const sys =
    "You summarise website chat conversations for a business's CRM. The business may be in any " +
    "industry — a clinic, a dealership, a law firm, a school, a consultancy — so take the subject " +
    "matter entirely from the transcript and never assume what the business sells. " +
    "For EACH conversation produce: a 'summary' of at most 2 short sentences capturing what the " +
    "visitor wants and whether they shared contact details; and 'interest' as short " +
    "middot-separated tags drawn from the topics that actually came up in that conversation " +
    "(e.g. 'root canal · Tuesday · cost' or 'Canada · Masters · scholarships'). " +
    "Be factual, no fluff, and never invent a detail the transcript does not contain. " +
    'Return ONLY valid JSON of the form {"summaries":[{"id":"...","summary":"...","interest":"..."}]}.';
  const user = JSON.stringify(items.map((it) => ({ id: it.id, transcript: it.transcript.slice(0, MAX_CHARS) })));

  const r = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
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
  },
    // summarising a long transcript is slower than a chat turn
    25000,);
  // r.ok was never tested. On a 429 or 500 there are no `choices`, `text` falls
  // back to "{}", the summaries object comes out empty, the per-lead catch
  // never fires, and this returns 200 with {}. The user clicks "AI summary",
  // gets nothing, and no error exists anywhere to explain it.
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    console.error("summarize-chats: Groq returned", r.status, detail);
    throw new Error(
      r.status === 429
        ? "The AI service is rate-limited right now. Try again in a minute."
        : `The AI service returned ${r.status}.`,
    );
  }
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


// The cron-death detector only works if something actually reports in.
// record_heartbeat() shipped with zero callers, so job_heartbeats stayed at
// "never reported" and stale_jobs() flagged every job stale forever — the
// monitoring was itself the thing that was broken.
async function heartbeat(status: string, detail?: string) {
  try {
    await supabase.rpc("record_heartbeat", {
      p_job: "summarize-chats", p_status: status, p_detail: detail ?? null,
    });
  } catch (e) {
    // Never let reporting health break the work whose health is reported.
    console.warn("heartbeat failed:", (e as Error).message);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // Scheduled endpoint. Deployed --no-verify-jwt because pg_cron carries no
  // Supabase JWT, so a shared secret is the boundary. See _shared/cron-auth.ts.
  const cronAuth = await requireCronOrMember(req, CORS, supabase);
  if (!cronAuth.ok) return cronAuth.response!;
  // When a person called this, they may only act on their OWN org —
  // the org is taken from their token, never from the request body.
  const callerOrgId: string | undefined = cronAuth.orgId;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!GROQ_KEY) return json({ error: "summariser not configured" }, 503);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  const { data: org } = await supabase.from("organizations")
    .select("id, active")
    // Same pin as run-automations: the token decides the org for a person,
    // the body only decides it for the scheduler.
    // Defaulting to "abrobot" made a multi-tenant scheduled job single-tenant:
    // an unattended run with no org named summarised AbroBot's conversations
    // and nobody else's, on every other customer's schedule.
    .eq(callerOrgId ? "id" : "slug", callerOrgId ?? (body.org ?? ""))
    .single();
  if (!callerOrgId && !body.org) return json({ error: "no organisation specified" }, 400);
  if (!org?.active) return json({ error: "org unavailable" }, 404);

  // Metering happens further down, once we know how many batches will ACTUALLY
  // reach Groq. Charging here — off the raw body length — bills a caller for
  // junk: the ids are unvalidated at this point, so fifty made-up ids, or fifty
  // belonging to another organisation, would debit fifty summaries and produce
  // none. See the block above `items`.

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

  // ── Metering ──────────────────────────────────────────────────────────────
  // This function calls Groq and, until now, charged nobody for it. Every other
  // AI path on the platform — chat-agent, whatsapp-send, nurture, send-campaign
  // — calls consume_usage; this one was billed to the platform and attributed
  // to no customer, so it appeared in neither the margin model nor the
  // customer's usage meter. It runs on a cron, in batches, unattended, which is
  // precisely the shape of spend that goes unnoticed until the invoice.
  //
  // Charged HERE, after `byConv` has been built from an org-scoped read, so the
  // count reflects conversations that really exist and really belong to this
  // organisation. One unit per batch, matching what is actually sent to Groq.
  //
  // Fails CLOSED: an org that cannot pay for a summary does not get one.
  // Summaries are a convenience, so refusing is a strictly better failure than
  // silent unbilled spend.
  const realIds = ids.filter((id) => byConv[id]?.length);
  if (!realIds.length) return json({ summaries: {} });

  const { data: usage, error: usageErr } = await supabase.rpc("consume_usage", {
    p_org_id: org.id, p_metric: "ai_messages", p_amount: Math.ceil(realIds.length / BATCH),
  });
  if (usageErr) {
    console.error("summarize-chats: consume_usage failed, refusing:", usageErr.message);
    return json({ error: "could not check this organisation's allowance" }, 503);
  }
  if (usage && (usage as { allowed?: boolean }).allowed === false) {
    return json({ summaries: {}, skipped: "monthly AI allowance used up" });
  }

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

  await heartbeat("ok", `${Object.keys(summaries).length} summarised`);
  return json({ summaries });
});
