/**
 * The abandoned-checkout reminder. Pure, so it is unit-tested from Node
 * (recovery-email.test.cjs) — every value that came from a customer is
 * HTML-escaped, and the copy never claims anything the system does not know.
 *
 * It does not say "your payment failed" (it may have been abandoned), and it
 * does not promise "nothing was charged": our record and Cashfree's both say
 * unpaid, but a bank can still be mid-settlement. It says what we know — no
 * completed payment reached us, the plan is unchanged — and how to get help if
 * money did leave their account.
 */

export interface RecoveryInput {
  firstName: string | null;
  orgName: string;
  planLabel: string;
  amountInr: number | null;
  months: number;
  startedAt: string;      // ISO
  attempt: number;        // 1 = first reminder
  settingsUrl: string;
  unsubUrl: string;
}

const esc = (s: string) =>
  (s || "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]!));

const inr = (n: number | null) =>
  n == null ? "" : "₹" + Math.round(n).toLocaleString("en-IN");

export function buildRecoveryEmail(i: RecoveryInput): { subject: string; html: string; text: string } {
  const name = (i.firstName || "").trim().split(/\s+/)[0] || "there";
  const when = new Date(i.startedAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "Asia/Kolkata" });
  const term = i.months === 12 ? "yearly" : "monthly";
  const price = inr(i.amountInr);
  // Newlines stripped: the org name is customer-chosen and a subject is a header.
  const subject = (i.attempt > 1
    ? `Still want ${i.planLabel} for ${i.orgName}?`
    : `Your ${i.planLabel} upgrade didn't complete`).replace(/[\r\n]+/g, " ").slice(0, 150);

  const lines = [
    `Hi ${name},`,
    `On ${when} you started upgrading ${i.orgName} to ${i.planLabel}${price ? ` (${price}, ${term})` : ""}, but we haven't received a completed payment, so your plan hasn't changed.`,
    `If you'd still like to upgrade, you can pick up where you left off in Settings: ${i.settingsUrl}`,
    `If something went wrong on the payment page — or money left your account but your plan didn't change — just reply to this email and we'll sort it out.`,
    `— The AbroBot CRM team`,
  ];
  const text = lines.join("\n\n") +
    `\n\nYou're receiving this because you started a checkout on AbroBot CRM. Stop these reminders: ${i.unsubUrl}`;

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1e293b;line-height:1.6">
  <p>Hi ${esc(name)},</p>
  <p>On ${esc(when)} you started upgrading <b>${esc(i.orgName)}</b> to <b>${esc(i.planLabel)}</b>${price ? ` (${esc(price)}, ${term})` : ""}, but we haven't received a completed payment, so your plan hasn't changed.</p>
  <p style="margin:22px 0"><a href="${esc(i.settingsUrl)}" style="background:#6d5efc;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Finish upgrading</a></p>
  <p>If something went wrong on the payment page — or money left your account but your plan didn't change — just reply to this email and we'll sort it out.</p>
  <p>— The AbroBot CRM team</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
  <p style="font-size:12px;color:#64748b">You're receiving this because you started a checkout on AbroBot CRM.
  <a href="${esc(i.unsubUrl)}" style="color:#64748b">Stop these reminders</a>. AbroBot Technologies Pvt Ltd · crm.mnbresearch.com</p>
</div>`;
  return { subject, html, text };
}
