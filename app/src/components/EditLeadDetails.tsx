import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { findConflictingLead, isUniqueViolation, isValidEmail, normPhone, type ConflictingLead } from "../lib/leadContact";
import { Modal } from "./ui";
import type { Lead, PipelineStage } from "../lib/types";

// The core fields of a record — name, email, phone, owner, follow-up date and
// lost reason — had no edit path at all. Custom fields were editable inline,
// but a mistyped phone number captured by the widget stayed mistyped forever,
// the follow-up queue could not be rescheduled from the record it is about,
// and a record could not be handed to a colleague except by a bulk action on
// the Leads list. This is that path.

interface Member { id: string; full_name: string | null; email: string | null }

/** What changed, for the caller to log against the record. */
export interface DetailChanges {
  /** Human sentence for an assignment change, or null if the owner is unchanged. */
  assignment: string | null;
  /** One line per other changed field. */
  lines: string[];
}

// <input type="datetime-local"> speaks local wall-clock time with no zone;
// the column is timestamptz. Converting through Date keeps both honest.
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const fmtWhen = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN") : "none");

export function EditLeadDetails({
  lead, stages, onClose, onSaved, navigate,
}: {
  lead: Lead;
  stages: PipelineStage[];
  onClose: () => void;
  /** Called after the write has landed, with the patch that was applied. */
  onSaved: (patch: Partial<Lead>, changes: DetailChanges) => Promise<void> | void;
  navigate: (to: string) => void;
}) {
  const [name, setName] = useState(lead.name ?? "");
  const [email, setEmail] = useState(lead.email ?? "");
  const [phone, setPhone] = useState(lead.phone ?? "");
  const [assignedTo, setAssignedTo] = useState(lead.assigned_to ?? "");
  const [followUp, setFollowUp] = useState(toLocalInput(lead.next_follow_up_at));
  const [lostReason, setLostReason] = useState(lead.lost_reason ?? "");
  const [members, setMembers] = useState<Member[]>([]);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictingLead | null>(null);

  const stageKey = lead.stage_key ?? lead.stage;
  const isLostStage = !!stages.find((s) => s.key === stageKey)?.is_lost;

  // Active members only: guard_lead_assignee refuses anyone else, so offering
  // a disabled or pending person would only produce an error on save.
  useEffect(() => {
    void supabase.from("profiles")
      .select("id, full_name, email")
      .eq("org_id", lead.org_id)
      .eq("status", "active")
      .order("full_name")
      .then(({ data, error }) => {
        if (error) { setMembersError(error.message); return; }
        setMembersError(null);
        setMembers((data as Member[]) ?? []);
      });
  }, [lead.org_id]);

  const memberName = (id: string | null) => {
    if (!id) return "nobody";
    const m = members.find((x) => x.id === id);
    return m ? (m.full_name || m.email || "a team member") : "a former team member";
  };

  const save = async () => {
    setErr(null);
    setConflict(null);

    const cleanName = name.trim();
    if (!cleanName) { setErr("A name is needed."); return; }

    // An untouched field is left exactly as stored, unvalidated. Records
    // captured before these rules existed can hold a value that would fail
    // them, and correcting someone's name must not be blocked by a phone
    // number nobody touched.
    const emailUntouched = email.trim() === (lead.email ?? "");
    const cleanEmail = emailUntouched ? (lead.email ?? "") : email.trim().toLowerCase();
    if (!emailUntouched && cleanEmail && !isValidEmail(cleanEmail)) {
      setErr("That email address doesn't look right — check for a missing @ or domain.");
      return;
    }

    let cleanPhone: string | null = null;
    if (phone.trim() === (lead.phone ?? "")) {
      cleanPhone = lead.phone ?? null;
    } else if (phone.trim()) {
      cleanPhone = normPhone(phone);
      if (!cleanPhone) {
        setErr("That doesn't look like a phone number. Use the full number, with the country code for numbers outside India (e.g. +1 415 555 0123).");
        return;
      }
    }

    // Same rule as adding a record: one way to reach the person is required,
    // because a record nobody can contact cannot be followed up.
    if (!cleanEmail && !cleanPhone) {
      setErr("Keep a phone number or an email — one of the two is needed to follow up.");
      return;
    }

    const patch: Partial<Lead> = {};
    const lines: string[] = [];
    if (cleanName !== (lead.name ?? "")) { patch.name = cleanName; lines.push(`Name: ${lead.name || "—"} → ${cleanName}`); }
    if ((cleanEmail || null) !== (lead.email ?? null)) {
      patch.email = cleanEmail || null;
      lines.push(`Email: ${lead.email || "—"} → ${cleanEmail || "—"}`);
    }
    if (cleanPhone !== (lead.phone ?? null)) {
      patch.phone = cleanPhone;
      lines.push(`Phone: ${lead.phone || "—"} → ${cleanPhone || "—"}`);
    }
    const nextFollow = fromLocalInput(followUp);
    // Compared at minute precision: the input cannot express seconds, so an
    // untouched field would otherwise always read as "changed".
    const sameMinute = (a: string | null, b: string | null) =>
      (a ? Math.floor(new Date(a).getTime() / 60000) : null) === (b ? Math.floor(new Date(b).getTime() / 60000) : null);
    if (!sameMinute(nextFollow, lead.next_follow_up_at)) {
      patch.next_follow_up_at = nextFollow;
      lines.push(`Follow-up: ${fmtWhen(lead.next_follow_up_at)} → ${fmtWhen(nextFollow)}`);
    }
    if (isLostStage && (lostReason.trim() || null) !== (lead.lost_reason ?? null)) {
      patch.lost_reason = lostReason.trim() || null;
      lines.push(`Lost reason: ${lead.lost_reason || "—"} → ${lostReason.trim() || "—"}`);
    }
    let assignment: string | null = null;
    if ((assignedTo || null) !== (lead.assigned_to ?? null)) {
      patch.assigned_to = assignedTo || null;
      assignment = assignedTo
        ? `Assigned to ${memberName(assignedTo)} (was ${memberName(lead.assigned_to)}).`
        : `Unassigned (was ${memberName(lead.assigned_to)}).`;
    }

    if (Object.keys(patch).length === 0) { onClose(); return; }

    setSaving(true);
    // `.select("id")` so a refusal is distinguishable from success: an UPDATE
    // matching no visible row is a 204 with error: null.
    const { data, error } = await supabase
      .from("leads")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", lead.id)
      .select("id");

    if (error) {
      // 23505 is one of the dedupe unique indexes (20260924092000): another
      // live record in this org already has this email or phone. Say which
      // one, and offer to go there — that record is usually the one to keep.
      if (isUniqueViolation(error)) {
        const holder = await findConflictingLead(
          lead.org_id, { email: patch.email ?? null, phone: patch.phone ?? null }, error, lead.id,
        );
        setSaving(false);
        setConflict(holder);
        setErr(`Another record already has that ${holder?.field ?? "email/phone"}.`);
        return;
      }
      setSaving(false);
      setErr(error.message);
      return;
    }
    if (!data?.length) {
      setSaving(false);
      setErr("Nothing was saved — this record is no longer visible to you, or you no longer have permission to change it.");
      return;
    }

    await onSaved(patch, { assignment, lines });
    setSaving(false);
  };

  return (
    <Modal title="Edit details" onClose={onClose}>
      <div className="field">
        <label className="label" htmlFor="ed-name">Name</label>
        <input id="ed-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label className="label" htmlFor="ed-email">Email</label>
        <input id="ed-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label className="label" htmlFor="ed-phone">Phone</label>
        <input id="ed-phone" className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91…" />
        <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
          Saved in international format — a 10-digit Indian mobile gets +91 added.
        </p>
      </div>
      <div className="field">
        <label className="label" htmlFor="ed-owner">Assigned to</label>
        <select id="ed-owner" className="select" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
          <option value="">Unassigned</option>
          {/* The current owner may no longer be active. Keep them selectable so
              opening this dialog never silently changes who owns the record. */}
          {lead.assigned_to && !members.some((m) => m.id === lead.assigned_to) && (
            <option value={lead.assigned_to}>{membersError ? "Current owner" : "Current owner (no longer active)"}</option>
          )}
          {members.map((m) => (
            <option key={m.id} value={m.id}>{m.full_name || m.email || m.id}</option>
          ))}
        </select>
        {membersError && (
          <p className="sub" style={{ fontSize: 12, marginTop: 4, color: "var(--red)" }}>
            Your team couldn't be loaded ({membersError}), so the list above may be missing people.
          </p>
        )}
      </div>
      <div className="field">
        <label className="label" htmlFor="ed-follow">Next follow-up</label>
        <div className="row" style={{ gap: 8 }}>
          <input
            id="ed-follow"
            className="input"
            type="datetime-local"
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          {followUp && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFollowUp("")}>Clear</button>}
        </div>
      </div>
      {isLostStage && (
        <div className="field">
          <label className="label" htmlFor="ed-lost">Lost reason</label>
          <input id="ed-lost" className="input" value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="e.g. Chose another provider" />
        </div>
      )}

      {err && (
        <div style={{ color: "var(--red)", fontWeight: 600, marginBottom: 12 }}>
          {err}
          {conflict && (
            <>
              {" "}
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginLeft: 6 }}
                onClick={() => { onClose(); navigate(`/leads/${conflict.id}`); }}
              >
                Open {conflict.name || "that record"} →
              </button>
            </>
          )}
        </div>
      )}

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
        <button className={`btn btn-primary${saving ? " btn-busy" : ""}`} onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
