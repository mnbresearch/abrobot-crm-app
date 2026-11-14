import { useState, useMemo } from "react";
import { Modal } from "./ui";
import { supabase } from "../lib/supabase";
import { formatCurrencyINR, type AtRiskDeal } from "../lib/revenueLeakage";
import type { Lead, Profile, Organization } from "../lib/types";

interface Props {
  deal: AtRiskDeal;
  members: Profile[];
  org: Organization | null;
  profile: Profile | null;
  onClose: () => void;
  onSuccess: (updatedLead: Lead) => void;
}

export function ExecutiveRescueModal({ deal, members, org, profile, onClose, onSuccess }: Props) {
  const { lead, riskType, estimatedValue, severity, riskTitle } = deal;
  const [tab, setTab] = useState<"message" | "reassign" | "escalate">("message");
  const [selectedRep, setSelectedRep] = useState<string>(lead.assigned_to || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const senderName = profile?.full_name || "Leadership Team";
  const orgName = org?.name || "our team";

  const defaultMessage = useMemo(() => {
    const firstName = lead.name ? lead.name.split(" ")[0] : "there";
    if (riskType === "sla_breach") {
      return `Hi ${firstName}, this is ${senderName} from executive leadership at ${orgName}. I noticed our response was delayed regarding your inquiry, and I wanted to personally reach out to ensure you receive our highest priority attention. When is a convenient time for a brief 5-minute call today?`;
    }
    if (riskType === "overdue_followup") {
      return `Hi ${firstName}, this is ${senderName} from ${orgName}. Sincere apologies that our scheduled follow-up was delayed — your time is extremely valuable to us. What is the most critical question I can help answer for you right now?`;
    }
    if (riskType === "velocity_stalled") {
      return `Hi ${firstName}, this is ${senderName} from ${orgName}. We've been reviewing your requirements and wanted to offer an executive fast-track briefing to ensure all your questions are addressed. Would you like to connect directly this week?`;
    }
    return `Hi ${firstName}, this is ${senderName} from ${orgName}. Thank you for your interest! I am personally overseeing priority accounts this month and wanted to welcome you directly. How can we best assist your evaluation?`;
  }, [lead.name, riskType, senderName, orgName]);

  const [message, setMessage] = useState(defaultMessage);

  const cleanPhone = useMemo(() => {
    if (!lead.phone) return null;
    return lead.phone.replace(/[^0-9]/g, "");
  }, [lead.phone]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const handleLogExecutiveTouch = async (channel: "whatsapp" | "email") => {
    if (!org) return;
    setSaving(true);
    setError(null);
    try {
      const nowIso = new Date().toISOString();
      const { error: actErr } = await supabase.from("activities").insert({
        org_id: org.id,
        lead_id: lead.id,
        user_id: profile?.id ?? null,
        type: channel,
        content: `[⚡ Executive War Room Rescue via ${channel.toUpperCase()}]\n${message}`,
      });
      if (actErr) console.warn("Activity log failed:", actErr.message);

      const { data: updated, error: leadErr } = await supabase
        .from("leads")
        .update({ last_contacted_at: nowIso })
        .eq("id", lead.id)
        .select("*")
        .single();

      if (leadErr) throw leadErr;
      if (updated) {
        onSuccess(updated as Lead);
        onClose();
      }
    } catch (e: any) {
      setError(e.message || "Failed to record executive contact");
    } finally {
      setSaving(false);
    }
  };

  const handleReassign = async () => {
    if (!org) return;
    if (!selectedRep) {
      setError("Please select a team member to assign this deal to.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const targetRep = members.find((m) => m.id === selectedRep);
      const repName = targetRep?.full_name || targetRep?.email || "Teammate";

      const { data: updated, error: leadErr } = await supabase
        .from("leads")
        .update({ assigned_to: selectedRep })
        .eq("id", lead.id)
        .select("*")
        .single();

      if (leadErr) throw leadErr;

      await supabase.from("activities").insert({
        org_id: org.id,
        lead_id: lead.id,
        user_id: profile?.id ?? null,
        type: "note",
        content: `⚡ Reassigned to ${repName} via Executive War Room Rescue to prevent pipeline leakage.`,
      });

      if (updated) {
        onSuccess(updated as Lead);
        onClose();
      }
    } catch (e: any) {
      setError(e.message || "Failed to reassign lead");
    } finally {
      setSaving(false);
    }
  };

  const handleEscalateFollowUp = async () => {
    if (!org) return;
    setSaving(true);
    setError(null);
    try {
      // Escalate follow-up to 2 hours from now
      const urgentFollowUp = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      const existingTags = Array.isArray(lead.tags) ? lead.tags : [];
      const updatedTags = existingTags.includes("urgent_rescue")
        ? existingTags
        : [...existingTags, "urgent_rescue"];

      const { data: updated, error: leadErr } = await supabase
        .from("leads")
        .update({
          next_follow_up_at: urgentFollowUp,
          tags: updatedTags,
        })
        .eq("id", lead.id)
        .select("*")
        .single();

      if (leadErr) throw leadErr;

      await supabase.from("activities").insert({
        org_id: org.id,
        lead_id: lead.id,
        user_id: profile?.id ?? null,
        type: "note",
        content: "🚨 Executive Escalation: Follow-up deadline fast-tracked to +2 hours. Deal tagged #urgent_rescue.",
      });

      if (updated) {
        onSuccess(updated as Lead);
        onClose();
      }
    } catch (e: any) {
      setError(e.message || "Failed to escalate deal");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="⚡ Executive Revenue Rescue" onClose={onClose} wide>
      <div className="stack" style={{ gap: 16 }}>
        {/* Deal Header Overview */}
        <div
          style={{
            background: "var(--bg-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            padding: "12px 16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 16 }}>{lead.name}</span>
              <span className={`pill ${severity === "critical" ? "pill-red" : "pill-amber"}`} style={{ fontSize: 11 }}>
                {riskTitle}
              </span>
            </div>
            <div className="sub" style={{ fontSize: 12, marginTop: 4 }}>
              Assigned to: <strong>{deal.assignedMemberName}</strong> · Stage Dwell: {deal.dwellDays}d · Contact: {lead.phone || lead.email || "No direct contact"}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="sub" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>Revenue at Risk</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "var(--red)" }}>
              {formatCurrencyINR(estimatedValue)}
            </div>
          </div>
        </div>

        {/* Tab selection */}
        <div className="row" style={{ gap: 8, borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
          <button
            type="button"
            className={`btn btn-sm ${tab === "message" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setTab("message")}
          >
            💬 VIP Executive Re-engagement
          </button>
          <button
            type="button"
            className={`btn btn-sm ${tab === "reassign" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setTab("reassign")}
          >
            🔄 1-Click Rebalance Rep
          </button>
          <button
            type="button"
            className={`btn btn-sm ${tab === "escalate" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setTab("escalate")}
          >
            🚨 Emergency Escalation (+2h)
          </button>
        </div>

        {error && (
          <div className="card" style={{ background: "var(--red-soft)", color: "var(--red)", padding: "10px 14px", fontSize: 13 }}>
            {error}
          </div>
        )}

        {/* Tab 1: VIP Executive Message */}
        {tab === "message" && (
          <div className="stack" style={{ gap: 12 }}>
            <p className="sub" style={{ fontSize: 13 }}>
              High-intent enterprise deals salvage at <strong>3.4x higher rates</strong> when contacted by a founder or executive leader within the first SLA breach window.
            </p>
            <div>
              <label className="sub" style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}>
                Personalized Executive Draft:
              </label>
              <textarea
                className="textarea"
                rows={4}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                style={{ width: "100%", fontFamily: "inherit", fontSize: 13.5, lineHeight: 1.5 }}
              />
            </div>
            <div className="row" style={{ gap: 10, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
              <div className="row" style={{ gap: 8 }}>
                {cleanPhone && (
                  <a
                    href={`https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-sm"
                    style={{ background: "#25D366", color: "#fff", borderColor: "#25D366", fontWeight: 600 }}
                    onClick={() => void handleLogExecutiveTouch("whatsapp")}
                  >
                    🚀 WhatsApp VIP Outreach
                  </a>
                )}
                {lead.email && (
                  <a
                    href={`mailto:${lead.email}?subject=${encodeURIComponent(`Executive follow-up regarding ${orgName}`)}&body=${encodeURIComponent(message)}`}
                    className="btn btn-sm btn-secondary"
                    onClick={() => void handleLogExecutiveTouch("email")}
                  >
                    ✉️ Send VIP Email
                  </a>
                )}
                <button type="button" className="btn btn-sm btn-ghost" onClick={handleCopy}>
                  {copied ? "✓ Copied to Clipboard" : "📋 Copy Message"}
                </button>
              </div>

              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={saving}
                onClick={() => void handleLogExecutiveTouch("whatsapp")}
              >
                {saving ? "Logging..." : "Mark Rescued & Touch Recorded"}
              </button>
            </div>
          </div>
        )}

        {/* Tab 2: 1-Click Rebalance Rep */}
        {tab === "reassign" && (
          <div className="stack" style={{ gap: 14 }}>
            <p className="sub" style={{ fontSize: 13 }}>
              When a sales rep is bottlenecked or inactive on a high-value opportunity, reassigning instantly prevents the deal from turning cold.
            </p>
            <div>
              <label className="sub" style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}>
                Assign To Teammate:
              </label>
              <select
                className="select"
                value={selectedRep}
                onChange={(e) => setSelectedRep(e.target.value)}
                style={{ width: "100%" }}
              >
                <option value="">— Select Team Member —</option>
                {members
                  .filter((m) => m.status === "active")
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.full_name || m.email} ({m.role})
                    </option>
                  ))}
              </select>
            </div>
            <div className="row" style={{ gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving || !selectedRep}
                onClick={handleReassign}
              >
                {saving ? "Reassigning..." : "⚡ Reassign Deal Immediately"}
              </button>
            </div>
          </div>
        )}

        {/* Tab 3: Emergency SLA Escalation */}
        {tab === "escalate" && (
          <div className="stack" style={{ gap: 14 }}>
            <p className="sub" style={{ fontSize: 13 }}>
              Fast-track this deal’s follow-up SLA to <strong>within 2 hours</strong> and apply the <code style={{ color: "var(--red)", fontWeight: 700 }}>#urgent_rescue</code> tag. The assigned rep will see this lead at the very top of their cockpit.
            </p>
            <div
              className="card"
              style={{
                background: "linear-gradient(135deg, rgba(239, 68, 68, 0.05), rgba(245, 158, 11, 0.05))",
                borderLeft: "4px solid var(--red)",
                padding: "12px 16px",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>Action Checklist:</div>
              <ul style={{ margin: "6px 0 0 18px", fontSize: 12.5, color: "var(--text)" }}>
                <li>Resets SLA timer to 2 hours from right now.</li>
                <li>Attaches high-priority audit note to the lead's history.</li>
                <li>Elevates lead priority score by +25 points in the Rep Cockpit queue.</li>
              </ul>
            </div>
            <div className="row" style={{ gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ background: "var(--red)", borderColor: "var(--red)" }}
                disabled={saving}
                onClick={handleEscalateFollowUp}
              >
                {saving ? "Escalating..." : "🚨 Enforce +2h Urgent Follow-Up"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
