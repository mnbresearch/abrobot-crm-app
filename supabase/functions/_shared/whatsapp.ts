import { fetchWithTimeout } from "./http.ts";
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

// ── The platform credentials, and why they come as a PAIR ───────────────────
//
// This mirrors chat-agent's GROQ_API_KEY pattern — an operator can hold the
// credentials in function secrets rather than on each agent_config row — but
// WhatsApp is not like Groq, and copying the pattern verbatim opened a hole.
//
// The old code took the token from the org row OR the platform secret, and the
// phone id from the org row, always. whatsapp_phone_id is a plain column any
// org admin can write, with no ownership check anywhere. So an admin could
// clear their token, paste ANOTHER tenant's Phone Number ID, and send.
//
// Meta would have allowed it. The Graph API authorises the *token* against the
// phone id, and the platform token owns every number registered to our app —
// so from Meta's side the call is perfectly legitimate. Messages would go out
// under another business's verified name, count against that number's quality
// rating, and bill to our Meta account.
//
// Hence the pairing rule below: the platform token is only ever used with the
// platform's own phone id, read from the same secrets store, never from a
// tenant-writable column. A tenant using their own token is unaffected —
// Meta's own check already stops them borrowing a number their token does not
// own, which is exactly the authorisation the platform token bypasses.
const PLATFORM_WA_TOKEN = (Deno.env.get("WHATSAPP_TOKEN") ?? "").trim();
const PLATFORM_WA_PHONE_ID = (Deno.env.get("WHATSAPP_PHONE_ID") ?? "").trim();

export type WhatsAppConfig = {
  whatsapp_token?: string | null;
  whatsapp_phone_id?: string | null;
  whatsapp_autoreply?: boolean | null;
};

export type SendResult =
  | { sent: true; message_id?: string }
  | { sent: false; reason: "not_configured" | "refused" | "error"; detail?: string };

/**
 * Decide which credentials this send may use.
 *
 * Exported so it can be unit-tested without touching Meta. The rule is short
 * enough to state in one sentence and was worth none of the trouble it caused
 * by being implicit: a token may only be used with a phone id it is entitled
 * to, and the platform token is entitled to all of them, so its phone id must
 * come from the operator rather than the tenant.
 */
export function resolveWhatsAppCredentials(
  cfg: WhatsAppConfig,
  platform: { token: string; phoneId: string } = {
    token: PLATFORM_WA_TOKEN,
    phoneId: PLATFORM_WA_PHONE_ID,
  },
): { token: string; phoneId: string } | { refused: string } | null {
  const orgToken = (cfg.whatsapp_token ?? "").toString().trim();
  const orgPhoneId = (cfg.whatsapp_phone_id ?? "").toString().trim();

  if (orgToken) {
    // The tenant's own token. Meta enforces that the token owns the phone id,
    // so this path needs no check from us — and adding one would break the
    // legitimate case where a tenant moves to a second number of their own.
    if (!orgPhoneId) return null;
    return { token: orgToken, phoneId: orgPhoneId };
  }

  if (!platform.token) return null;

  // Platform token. Its phone id is not negotiable.
  if (!platform.phoneId) {
    return {
      refused:
        "The platform WhatsApp token is set but WHATSAPP_PHONE_ID is not. " +
        "Sending would require trusting a tenant-supplied phone number ID, which is refused.",
    };
  }

  if (orgPhoneId && orgPhoneId !== platform.phoneId) {
    return {
      refused:
        "This organisation has a WhatsApp phone number ID set but no token of its own. " +
        "Sending from that number would use the platform's credentials, which are not " +
        "authorised for it. Add this organisation's own WhatsApp access token in " +
        "Settings → WhatsApp.",
    };
  }

  return { token: platform.token, phoneId: platform.phoneId };
}

/** E.164 without the leading "+" — what the Graph API expects. */
export function waNumber(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

export async function sendWhatsAppText(
  cfg: WhatsAppConfig,
  to: string,
  text: string,
): Promise<SendResult> {
  if (!to) return { sent: false, reason: "not_configured" };

  const creds = resolveWhatsAppCredentials(cfg);
  if (creds === null) return { sent: false, reason: "not_configured" };
  if ("refused" in creds) {
    // Deliberately a distinct reason, not "error". A caller that logs this
    // should be able to tell a misconfiguration it must not paper over from a
    // transient Graph failure it may retry.
    return { sent: false, reason: "refused", detail: creds.refused };
  }
  const { token, phoneId } = creds;

  try {
    const r = await fetchWithTimeout(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
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
