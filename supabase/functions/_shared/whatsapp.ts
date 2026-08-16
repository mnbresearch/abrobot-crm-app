// AbroBot CRM — outbound WhatsApp via the Meta Cloud API.
//
// Config lives on the org's agent_config row (CRM Settings → WhatsApp):
//   whatsapp_token      text     — permanent access token from the Meta app
//   whatsapp_phone_id   text     — the Phone Number ID (NOT the phone number)
//   whatsapp_autoreply  boolean  — auto-respond to inbound messages
//
// IMPORTANT — the 24-hour rule:
// Meta only allows free-form messages inside a 24h customer service window
// opened by the customer's own last message. Outside that window you must send
// an approved *template*. sendWhatsAppText() therefore surfaces Meta's error
// rather than silently failing, so the CRM can tell the counsellor why.

const GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") || "v21.0";

// Platform fallback, mirroring chat-agent's GROQ_API_KEY pattern: an operator
// can hold the access token in function secrets rather than the agent_config
// row. A per-org token, when present, still takes precedence.
const PLATFORM_WA_TOKEN = Deno.env.get("WHATSAPP_TOKEN") ?? "";

export type WhatsAppConfig = {
  whatsapp_token?: string | null;
  whatsapp_phone_id?: string | null;
  whatsapp_autoreply?: boolean | null;
};

export type SendResult =
  | { sent: true; message_id?: string }
  | { sent: false; reason: "not_configured" | "error"; detail?: string };

/** E.164 without the leading "+" — what the Graph API expects. */
export function waNumber(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

export async function sendWhatsAppText(
  cfg: WhatsAppConfig,
  to: string,
  text: string,
): Promise<SendResult> {
  const token = ((cfg.whatsapp_token ?? "").toString().trim()) || PLATFORM_WA_TOKEN;
  const phoneId = (cfg.whatsapp_phone_id ?? "").toString().trim();
  if (!token || !phoneId || !to) return { sent: false, reason: "not_configured" };

  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: waNumber(to),
        type: "text",
        text: { preview_url: false, body: text.slice(0, 4096) },
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Meta's error payload is genuinely diagnostic (error 131047 = outside
      // the 24h window, 190 = expired token). Pass it through.
      const detail = data?.error?.message
        ? `${data.error.code ?? r.status}: ${data.error.message}`
        : `graph ${r.status}`;
      return { sent: false, reason: "error", detail };
    }
    return { sent: true, message_id: data?.messages?.[0]?.id };
  } catch (e) {
    return { sent: false, reason: "error", detail: (e as Error).message };
  }
}

/** Fetch just the WhatsApp config for an org. */
// deno-lint-ignore no-explicit-any
export async function getWhatsAppConfig(supabase: any, orgId: string): Promise<WhatsAppConfig> {
  const { data } = await supabase
    .from("agent_config")
    .select("whatsapp_token, whatsapp_phone_id, whatsapp_autoreply")
    .eq("org_id", orgId)
    .single();
  return data ?? {};
}
