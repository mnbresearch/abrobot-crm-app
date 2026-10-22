import { fetchWithTimeout } from "./http.ts";
import { scrubToken } from "./notify.ts";
// AbroBot CRM — alerts for the PLATFORM operator (us), never for a tenant.
//
// notifyNewLead() posts into the tenant's own Telegram chat. That is right for
// "you have a new lead" and wrong for "a payment was taken but the plan was not
// granted": the customer is told about our failure, and we are not.
//
// Destination, in order:
//   1. app_settings ops_telegram_bot_token + ops_telegram_chat_id — the same
//      operator channel the SQL job watchdog uses (20260914120000).
//   2. Function secrets TELEGRAM_BOT_TOKEN + OPERATOR_TELEGRAM_CHAT_ID.
//
// Never throws. Returns {sent:false, reason} instead, so a caller on the money
// path can log it and carry on.

// deno-lint-ignore no-explicit-any
type Db = any;

export type OperatorResult = { sent: boolean; reason?: string };

const MAX_LEN = 3900; // Telegram's limit is 4096; leave room for the prefix.

async function resolveChannel(admin: Db): Promise<{ token: string; chat: string; via: string } | { error: string }> {
  let settingsNote = "";
  try {
    const { data, error } = await admin.from("app_settings")
      .select("key, value")
      .in("key", ["ops_telegram_bot_token", "ops_telegram_chat_id"]);
    if (error) {
      settingsNote = `app_settings unreadable: ${error.message || "unknown error"}`;
    } else {
      const map = new Map<string, string>(
        ((data ?? []) as { key: string; value: string | null }[])
          .map((r) => [r.key, String(r.value ?? "").trim()]),
      );
      const token = map.get("ops_telegram_bot_token") ?? "";
      const chat = map.get("ops_telegram_chat_id") ?? "";
      if (token && chat) return { token, chat, via: "app_settings" };
    }
  } catch (e) {
    settingsNote = `app_settings read threw: ${(e as Error)?.message || "unknown"}`;
  }

  const token = (Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "").trim();
  const chat = (Deno.env.get("OPERATOR_TELEGRAM_CHAT_ID") ?? "").trim();
  if (token && chat) return { token, chat, via: "env" };

  return {
    error: "not_configured: set app_settings ops_telegram_bot_token/ops_telegram_chat_id " +
      "or secrets TELEGRAM_BOT_TOKEN/OPERATOR_TELEGRAM_CHAT_ID" +
      (settingsNote ? ` (${settingsNote})` : ""),
  };
}

/** Send a plain-text alert to the platform operator. Never throws. */
export async function notifyOperator(admin: Db, text: string): Promise<OperatorResult> {
  try {
    const ch = await resolveChannel(admin);
    if ("error" in ch) {
      console.warn("notifyOperator: not sent —", ch.error, "| message:", text.slice(0, 300));
      return { sent: false, reason: ch.error };
    }
    const body = `🛠 AbroBot CRM (operator)\n${text}`.slice(0, MAX_LEN);
    const r = await fetchWithTimeout(`https://api.telegram.org/bot${ch.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Plain text, no parse_mode: order ids and error strings contain
      // underscores and angle brackets that would break Markdown/HTML parsing
      // and drop the alert at exactly the moment it matters.
      body: JSON.stringify({ chat_id: ch.chat, text: body, disable_web_page_preview: true }),
    });
    if (!r.ok) {
      const detail = scrubToken((await r.text().catch(() => "")).slice(0, 200));
      console.error("notifyOperator: telegram", r.status, detail, "| message:", text.slice(0, 300));
      return { sent: false, reason: `telegram ${r.status}: ${detail}` };
    }
    return { sent: true };
  } catch (e) {
    const reason = scrubToken((e as Error)?.message || "send threw");
    console.error("notifyOperator: failed —", reason, "| message:", text.slice(0, 300));
    return { sent: false, reason };
  }
}
