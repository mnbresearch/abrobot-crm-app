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
    const { data: cfg } = await supabase
      .from("agent_config")
      .select("notify_new_leads, telegram_bot_token, telegram_chat_id, brand_name")
      .eq("org_id", orgId)
      .single();

    if (!cfg?.notify_new_leads) return { sent: false, reason: "disabled" };

    const token = ((cfg.telegram_bot_token ?? "").toString().trim()) || PLATFORM_TELEGRAM_TOKEN;
    const chatId = (cfg.telegram_chat_id ?? "").toString().trim();
    if (!token || !chatId) return { sent: false, reason: "not_configured" };

    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
      return { sent: false, reason: "error", detail: `telegram ${r.status}: ${await r.text()}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: "error", detail: (e as Error).message };
  }
}
