import { fetchWithTimeout } from "./http.ts";
// AbroBot CRM — Telegram new-lead alerts.
//
// Config lives on the org's agent_config row (set in CRM Settings → Alerts):
//   notify_new_leads     boolean  — master switch
//   telegram_bot_token   text     — from @BotFather
//   telegram_chat_id     text     — the chat to post into
//
// Design notes:
//  - Alerts are best-effort. A failure here must NEVER break lead intake,
//    so every path is caught and reported, never thrown.
//  - The bot token stays server-side. It is read with the service role and
//    used only from this function — it is never returned to a caller.

const CRM_BASE = Deno.env.get("CRM_BASE_URL") || "https://crm.mnbresearch.com";

// Platform fallback. Lets an operator keep the bot token in function secrets
// instead of the agent_config row — which is what makes it possible to empty
// the secret columns without losing alerts. Per-org tokens still win.
const PLATFORM_TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

export type NewLeadAlert = {
  id: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  target_country?: string | null;
  course?: string | null;
  score?: number | null;
  message?: string | null;
};

export type AlertResult =
  | { sent: true }
  | { sent: false; reason: "disabled" | "not_configured" | "error"; detail?: string };

// Telegram HTML parse_mode only needs these three escaped.
const esc = (s: unknown) =>
  String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

function buildMessage(lead: NewLeadAlert, brand: string): string {
  const rows: string[] = [];
  if (lead.phone) rows.push(`📞 <b>${esc(lead.phone)}</b>`);
  if (lead.email) rows.push(`✉️ ${esc(lead.email)}`);

  const facts = [lead.target_country, lead.course].filter(Boolean).map(esc);
  if (facts.length) rows.push(`🎓 ${facts.join(" · ")}`);
  if (typeof lead.score === "number") rows.push(`⭐ Score ${lead.score}/100`);
  if (lead.source) rows.push(`🔗 via ${esc(lead.source)}`);

  if (lead.message) {
    const snip = lead.message.length > 300 ? lead.message.slice(0, 300) + "…" : lead.message;
    rows.push(`\n<i>${esc(snip)}</i>`);
  }

  return [
    `🔔 <b>New lead — ${esc(brand)}</b>`,
    `👤 <b>${esc(lead.name || "Unknown")}</b>`,
    ...rows,
    `\n<a href="${CRM_BASE}/leads/${lead.id}">Open in CRM →</a>`,
  ].join("\n");
}

/**
 * Send a Telegram alert for a newly created lead.
 * Resolves to an AlertResult; never rejects.
 */
// deno-lint-ignore no-explicit-any
export async function notifyNewLead(
  supabase: any,
  orgId: string,
  lead: NewLeadAlert,
): Promise<AlertResult> {
  try {
    // `.maybeSingle()`, and the error is CHECKED.
    //
    // This read decided everything below it while discarding `error`, so a
    // refused read (RLS change, transient failure, a missing row under
    // `.single()`) produced `cfg = null` and the next line returned
    // `reason: "disabled"` — the word for a deliberate customer setting.
    //
    // Two consequences, both silent. Every org's new-lead alerts stop, and
    // `run-actions.ts` only fails an automation when `reason === "error"`, so
    // each rule still records `ok: true` in `automation_runs`. The board stays
    // green while nobody is being told about any new enquiry.
    const { data: cfg, error: cfgErr } = await supabase
      .from("agent_config")
      .select("notify_new_leads, telegram_bot_token, telegram_chat_id, brand_name")
      .eq("org_id", orgId)
      .maybeSingle();

    if (cfgErr) {
      // console.error, not just a returned value: the one caller that reads
      // this reason is run-actions, and lead-webhook puts it in an HTTP body
      // that Meta and Zapier discard. A log line is the only thing that
      // reaches a human here.
      console.error(`notifyNewLead: could not read alert settings for org ${orgId}:`, cfgErr.message);
      return { sent: false, reason: "error", detail: `alert settings unreadable: ${cfgErr.message}` };
    }

    if (!cfg?.notify_new_leads) return { sent: false, reason: "disabled" };

    const token = ((cfg.telegram_bot_token ?? "").toString().trim()) || PLATFORM_TELEGRAM_TOKEN;
    const chatId = (cfg.telegram_chat_id ?? "").toString().trim();
    if (!token || !chatId) return { sent: false, reason: "not_configured" };

    const r = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: buildMessage(lead, cfg.brand_name || "AbroBot"),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    if (!r.ok) {
      // Telegram returns a JSON description that is genuinely useful
      // (chat not found, bot blocked, bad token) — surface it to the caller.
      //
      // Through scrubToken, though. This branch returned `await r.text()`
      // raw while only the catch below scrubbed, and Telegram echoes the
      // request in some error bodies. The detail travels into an HTTP
      // response body, a browser toast and any log aggregator, so the one
      // path that talks to Telegram when something is wrong was the one path
      // that could hand out the bot token.
      // Scrub FIRST, then slice. The other order truncates the body at 300
      // characters and can cut through the middle of a bare `<id>:<token>` —
      // leaving fewer than the 30 token characters the pattern requires, so
      // the redaction never fires and up to 29 characters of the secret print.
      // Redacting before truncating cannot have that failure mode.
      const body = scrubToken(await r.text()).slice(0, 300);
      console.error(`notifyNewLead: telegram ${r.status} for org ${orgId}: ${body}`);
      return { sent: false, reason: "error", detail: `telegram ${r.status}: ${body}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: "error", detail: scrubToken((e as Error).message) };
  }
}

// Deno puts the full request URL into fetch's TypeError message, and the
// Telegram bot token lives IN that URL. So a network-level failure hands the
// token to whatever renders the error — a webhook caller's response body, a
// browser toast, a log aggregator. Never let the raw message through.
export function scrubToken(msg: string): string {
  return (msg || "")
    .replace(/\/bot[0-9]+:[A-Za-z0-9_-]+/g, "/bot<redacted>")
    // `{8,10}` left the leading digit of an 11-digit bot id behind: a token
    // `12345678901:AA...` matched only from the `2`, so the output was
    // `1<redacted>` — a redaction that still printed part of the secret.
    // Telegram ids are routinely 10-11 digits now and still growing, so the
    // length guess had to go.
    //
    // The anchor is `[^0-9]`, NOT `[^0-9A-Za-z_-]`. I tried the wider class
    // first, reasoning that it was a cleaner word boundary, and it was a
    // strictly worse redaction than the bug it replaced: `bot<id>:<token>`
    // with no leading slash — a shape Telegram echoes in some error bodies —
    // stopped matching at all, so the ENTIRE token printed. Rule 1 above only
    // catches the `/bot…` form, so nothing else covered it.
    //
    // Excluding only digits keeps the greedy behaviour that made the old
    // pattern safe: it will happily start mid-identifier and consume a
    // character or two of surrounding text, which is ugly and harmless. A
    // redaction should fail towards redacting too much.
    .replace(/(^|[^0-9])[0-9]{6,}:[A-Za-z0-9_-]{30,}/g, "$1<redacted>");
}
