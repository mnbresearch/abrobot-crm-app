import { useCallback, useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase, callFunction } from "../lib/supabase";
import { Card, FieldInput, LoadError, Modal, ScoreChip, Spinner, StagePill, cellValue, humanize, timeAgo, useToast } from "../components/ui";
import { IndustryTool } from "../components/IndustryTool";
import { EditLeadDetails, type DetailChanges } from "../components/EditLeadDetails";
import { applyTemplate as mergeTokens } from "../lib/template";
import {
  getConsentPreferences,
  saveConsentPreferences,
  exportLeadSAR,
  eraseLeadPII,
  recordDataRectification,
  generateErasureCertificate,
  downloadErasureCertificate,
  type ConsentPreferences,
} from "../lib/compliance";
import type { Activity, Lead } from "../lib/types";

// Activity types that mean someone actually reached the person. Only these
// move "Last contacted", which drives the follow-up queue — a note or a stage
// change is work done ON the record, not contact WITH the customer.
const CONTACT_TYPES: ReadonlySet<Activity["type"]> = new Set(["call", "email", "whatsapp", "meeting"]);

/** What the plan says about WhatsApp, read from usage_snapshot. */
interface WaAllowance { included: boolean; used: number; limit: number | null }

// One usage_snapshot read per org per minute, shared across record views:
// opening ten records in a row should not cost ten counts of the org's leads.
let waCache: { orgId: string; at: number; value: WaAllowance } | null = null;

export function LeadDetail({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const { org, ui, stages, fields, profile, isAdmin } = useApp();
  const [lead, setLead] = useState<Lead | null>(null);
  const [acts, setActs] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [waOpen, setWaOpen] = useState(false);
  const [waText, setWaText] = useState("");
  const [waSending, setWaSending] = useState(false);
  const [templates, setTemplates] = useState<
    { id: string; name: string; body: string; channel: string; subject: string | null }[]
  >([]);
  const [emOpen, setEmOpen] = useState(false);
  const [emSubject, setEmSubject] = useState("");
  const [emText, setEmText] = useState("");
  const [emSending, setEmSending] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [complianceOpen, setComplianceOpen] = useState(false);
  const [complianceTab, setComplianceTab] = useState<"sar" | "consent" | "rectification" | "erasure">("consent");
  const [consentDraft, setConsentDraft] = useState<ConsentPreferences | null>(null);
  const [consentSaving, setConsentSaving] = useState(false);
  const [rectName, setRectName] = useState("");
  const [rectEmail, setRectEmail] = useState("");
  const [rectPhone, setRectPhone] = useState("");
  const [rectReason, setRectReason] = useState("");
  const [rectSaving, setRectSaving] = useState(false);
  const [erasureInput, setErasureInput] = useState("");
  const [erasing, setErasing] = useState(false);
  const [exportingSar, setExportingSar] = useState(false);
  // null = not known (not read yet, or the read failed). Unknown leaves the
  // button usable — whatsapp-send enforces the plan itself and says why — but
  // a KNOWN "not included" stops someone writing a message that can only be
  // refused.
  const [wa, setWa] = useState<WaAllowance | null>(null);
  const toast = useToast();

  const [loadError, setLoadError] = useState<string | null>(null);
  // The activities read had its own error discarded entirely, so a failure
  // rendered "Nothing logged yet." on a customer record — the one sentence on
  // this page people act on. Someone reading it calls a customer who was called
  // yesterday, or re-sends a proposal that already went out.
  const [actsError, setActsError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [l, a] = await Promise.all([
      supabase.from("leads").select("*").eq("id", id).single(),
      supabase.from("activities").select("*").eq("lead_id", id).order("created_at", { ascending: false }).limit(100),
    ]);
    // PGRST116 is "no rows" — a genuinely missing record. Anything else is a
    // failure, and rendering "Not found." for it tells someone their customer
    // record has been deleted when the network simply hiccuped.
    if (l.error && l.error.code !== "PGRST116") setLoadError(l.error.message);
    else setLoadError(null);
    setLead((l.data as Lead) ?? null);
    // The lead and its history are two separate reads: the record can arrive
    // while its history does not, and in that case the history must say so
    // rather than render as an absence of history.
    if (a.error) setActsError(a.error.message);
    else { setActsError(null); setActs((a.data as Activity[]) ?? []); }
    setLoading(false);
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // Templates were pure CRUD with no consumer anywhere — the merge tokens the
  // editor documents were substituted by no code path in the repo. This is
  // the first thing that actually uses them.
  useEffect(() => {
    if (!org) return;
    void supabase.from("message_templates")
      .select("id, name, body, channel, subject").eq("org_id", org.id).order("name")
      .then(({ data, error }) => {
        // The error was dropped, so a failed read left `templates` empty — and
        // an empty array renders as no template picker at all in the WhatsApp
        // and email composers. An org that had carefully written a library of
        // templates simply found them absent, with nothing to distinguish that
        // from never having created any.
        if (error) {
          console.error("lead detail: templates unavailable —", error.message);
          toast.error(`Your message templates couldn't be loaded (${error.message}) — the picker below will be empty.`);
          return;
        }
        setTemplates(data ?? []);
      });
  }, [org]);

  useEffect(() => {
    if (!org) return;
    if (waCache && waCache.orgId === org.id && Date.now() - waCache.at < 60_000) { setWa(waCache.value); return; }
    void supabase.rpc("usage_snapshot", { p_org_id: org.id }).then(({ data, error }) => {
      if (error || !data) { console.warn("lead detail: plan state unavailable —", error?.message); return; }
      const snap = data as { whatsapp?: boolean; whatsapp_messages?: { used?: number; limit?: number | null } };
      const value: WaAllowance = {
        included: !!snap.whatsapp,
        used: snap.whatsapp_messages?.used ?? 0,
        limit: snap.whatsapp_messages?.limit ?? null,
      };
      waCache = { orgId: org.id, at: Date.now(), value };
      setWa(value);
    });
  }, [org]);

  // The same substitution the server runs (lib/template.ts is a port of
  // _shared/template.ts). For WhatsApp this IS the send — whatsapp-send does
  // no substitution of its own — so a token this missed went to the customer
  // literally. For email the server substitutes again, and the two now agree.
  const merge = (body: string) => {
    if (!lead) return body;
    return mergeTokens(body, lead, org?.name ?? "");
  };

  const applyTemplate = (body: string) => setWaText(merge(body));

  const sendEmail = async () => {
    if (!lead || !emSubject.trim() || !emText.trim()) return;
    setEmSending(true);
    try {
      // lead_ids rather than an audience filter: this is one person, and the
      // audience path could quietly widen if a filter were ever mis-set.
      // send-campaign answers HTTP 200 with { sent: 0, errors: [...] } when the
      // send itself fails — a bad Resend key, an unverified domain, a bounce.
      // callFunction only throws on a non-2xx status, so discarding the return
      // value meant the toast said "Email sent" for a message that was never
      // sent, and no activity row was written either. A counsellor would tell a
      // client "I've emailed you the documents" on the strength of it.
      //
      // Templates.tsx already reads this response correctly; this caller did not.
      const r = await callFunction<{ sent: number; matched: number; errors?: string[] }>(
        "send-campaign",
        { subject: emSubject.trim(), body: emText.trim(), lead_ids: [lead.id] },
      );

      if (!r.sent) {
        throw new Error(r.errors?.[0] ?? "The email could not be sent.");
      }

      setEmOpen(false);
      setEmText("");
      setEmSubject("");
      toast.show("Email sent");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
    setEmSending(false);
  };

  const sendWhatsApp = async () => {
    if (!lead || !waText.trim()) return;
    setWaSending(true);
    try {
      await callFunction("whatsapp-send", { lead_id: lead.id, text: waText.trim() });
      setWaOpen(false);
      setWaText("");
      toast.show("WhatsApp sent");
      await load();   // the send logs an activity; show it
    } catch (e) {
      // Meta's real errors matter here: 131047 means the 24-hour window has
      // closed and you need an approved template. Saying "failed" would send
      // someone hunting for a bug that isn't there.
      toast.error((e as Error).message);
    }
    setWaSending(false);
  };

  // Every write surfaces its error. A save that silently fails while the UI
  // says it worked is worse than an error message — the user walks away
  // believing the record is updated.
  //
  // Returns whether the write landed. Callers need that: useToast REPLACES the
  // visible toast rather than queueing, so a caller that toasted a success
  // after this failed wiped the error off the screen in the same tick and left
  // the user with a confirmation of something that did not happen.
  const log = async (type: Activity["type"], content: string): Promise<boolean> => {
    if (!lead || !org) return false;
    const { error } = await supabase.from("activities").insert({
      org_id: org.id, lead_id: lead.id, user_id: profile?.id ?? null, type, content,
    });
    if (error) { toast.error(error.message); return false; }
    // Notes and stage changes are not contact. Stamping them made a record
    // someone merely annotated drop out of the "not contacted" queue, so the
    // customer who most needed a call was the one nobody was reminded about.
    if (!CONTACT_TYPES.has(type)) { await load(); return true; }
    // "Last contacted" drives the follow-up queue, so a silent failure here
    // means someone gets chased twice or not at all.
    // `.select("id")` so a refusal is distinguishable from success: PostgREST
    // answers an UPDATE whose WHERE matches no VISIBLE row with 204 and
    // error: null, so this "succeeded" without touching anything. Still not
    // fatal to the note that has already been written — same console.warn as
    // the error branch — but no longer invisible.
    const { data: touched, error: touchErr } = await supabase.from("leads")
      .update({ last_contacted_at: new Date().toISOString() }).eq("id", lead.id).select("id");
    if (touchErr) console.warn("could not update last_contacted_at:", touchErr.message);
    else if (!touched?.length) console.warn("last_contacted_at matched no visible row — permission may have been revoked");
    await load();
    return true;
  };

  // Also returns whether the move landed, for the same reason as `log`.
  const moveStage = async (key: string): Promise<boolean> => {
    if (!lead) return false;
    const label = stages.find((s) => s.key === key)?.label ?? key;
    const previous = lead;

    // Optimistic — the pill should move the instant you choose, not after a
    // round trip. Rolled back below if the write is rejected.
    setLead({ ...lead, stage_key: key });

    // stage_key is the source of truth; the DB trigger mirrors it back to the
    // legacy enum so the old frontend stays consistent.
    // `.select("id")` so a refusal is distinguishable from success. PostgREST
    // answers an UPDATE whose WHERE matches no VISIBLE row with 204 and
    // error: null — so the optimistic pill above stayed put, the activity below
    // was written, "Moved to X" appeared, and the stage never changed. A member
    // whose access was revoked keeps a usable token for up to an hour.
    const { data, error } = await supabase
      .from("leads")
      .update({ stage_key: key, updated_at: new Date().toISOString() })
      .eq("id", lead.id)
      .select("id");

    if (error) {
      setLead(previous);
      toast.error(error.message);
      return false;
    }
    if (!data?.length) {
      setLead(previous);
      toast.error("The stage was not changed — this record is no longer visible to you, or you no longer have permission to change it.");
      return false;
    }
    await log("stage_change", `Moved to ${label}.`);
    toast.show(`Moved to ${label}`);
    return true;
  };

  const addTag = async (tag: string) => {
    if (!lead || !tag.trim()) return;
    const tags: string[] = Array.isArray(lead.tags) ? lead.tags : [];
    const clean = tag.trim().toLowerCase();
    if (tags.includes(clean)) return;
    const next = [...tags, clean];
    setLead({ ...lead, tags: next });
    // `.select("id")` for the same reason as moveStage: no visible row means 204
    // with error: null, so the tag stayed on screen until the next reload and
    // was never saved.
    const { data, error } = await supabase.from("leads").update({ tags: next }).eq("id", lead.id).select("id");
    if (error) { setLead({ ...lead, tags }); toast.error(error.message); return; }
    if (!data?.length) {
      setLead({ ...lead, tags });
      toast.error("The tag was not saved — this record is no longer visible to you, or you no longer have permission to change it.");
    }
  };

  const removeTag = async (tag: string) => {
    if (!lead) return;
    const tags: string[] = Array.isArray(lead.tags) ? lead.tags : [];
    const next = tags.filter((t) => t !== tag);
    setLead({ ...lead, tags: next });
    // Same as addTag: a 204 with error: null meant the tag vanished from the
    // screen and stayed on the record.
    const { data, error } = await supabase.from("leads").update({ tags: next }).eq("id", lead.id).select("id");
    if (error) { setLead({ ...lead, tags }); toast.error(error.message); return; }
    if (!data?.length) {
      setLead({ ...lead, tags });
      toast.error("The tag was not removed — this record is no longer visible to you, or you no longer have permission to change it.");
    }
  };

  const archive = async () => {
    if (!lead) return;
    // Soft delete, not a hard one: archive_lead sets deleted_at, RLS hides the
    // record, and purge_archived removes it for real after 30 days. Until now
    // the whole mechanism existed in SQL with zero callers — and the product
    // had no way to remove a record at all, which for a CRM is not a missing
    // nicety. A wrong number typed into a form stayed forever.
    if (!confirm(
      `Archive ${lead.name}?\n\nThe record is hidden immediately and permanently deleted after 30 days. ` +
      `An admin can restore it before then.`
    )) return;
    const { data, error } = await supabase.rpc("archive_lead", { p_lead_id: lead.id });
    if (error) { toast.error(error.message); return; }
    if (data && data.ok === false) { toast.error(String(data.reason ?? "Could not archive")); return; }
    toast.show("Archived — restorable for 30 days");
    navigate("/leads");
  };

  // After EditLeadDetails has written. The record on screen takes the patch
  // immediately; the history gets one line per kind of change, attributed to
  // whoever made it — an owner change as an "assignment", so the Activity
  // filter for reassignments finds it.
  const detailsSaved = async (patch: Partial<Lead>, changes: DetailChanges) => {
    if (!lead) return;
    setLead({ ...lead, ...patch });
    setDetailsOpen(false);
    let ok = true;
    if (changes.assignment) ok = (await log("assignment", changes.assignment)) && ok;
    if (changes.lines.length) ok = (await log("note", `Details updated:\n${changes.lines.join("\n")}`)) && ok;
    // log() has already toasted its own failure; don't paper over it.
    if (ok) toast.show("Details saved");
  };

  const addNote = async () => {
    if (!note.trim()) return;
    await log("note", note.trim());
    setNote("");
  };

  if (loading) return <Spinner />;
  if (loadError) {
    return (
      <Card>
        <p style={{ marginBottom: 10 }}>Could not load this record.</p>
        <p className="sub" style={{ marginBottom: 12 }}>{loadError}</p>
        <button className="btn btn-primary" onClick={() => void load()}>Try again</button>
      </Card>
    );
  }
  if (!lead) return <Card><p>Not found.</p></Card>;

  const stageKey = lead.stage_key ?? lead.stage;

  // Why WhatsApp cannot be sent from here, if we know it cannot. The same two
  // refusals whatsapp-send gives (402), said before anyone writes a message.
  const waBlocked: string | null =
    wa && !wa.included
      ? "WhatsApp sending isn't included on your current plan — it comes with Growth and above. The ↗ link still opens WhatsApp on this device."
      : wa && wa.limit !== null && wa.used >= wa.limit
        ? `This month's WhatsApp allowance (${wa.limit} messages) is used up. It resets on the 1st; the ↗ link still opens WhatsApp on this device.`
        : null;

  const waModal = waOpen && (
    <Modal title={`WhatsApp ${lead.name}`} onClose={() => setWaOpen(false)}>
      <p className="sub" style={{ marginTop: -6 }}>
        Sent from your business number and logged against this record — unlike the
        deep link, which opens WhatsApp on your phone and leaves no trace here.
      </p>

      {templates.filter((t) => t.channel !== "email").length > 0 && (
        <div className="field">
          <label className="label">Start from a template</label>
          <div className="row row-wrap">
            {templates.filter((t) => t.channel !== "email").map((t) => (
              <button key={t.id} className="btn btn-sm" onClick={() => applyTemplate(t.body)}>
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <label className="label" htmlFor="wa-body">Message</label>
        <textarea
          id="wa-body"
          className="textarea"
          autoFocus
          value={waText}
          onChange={(e) => setWaText(e.target.value)}
          placeholder={`Hi ${(lead.name ?? "").split(" ")[0]}, …`}
          style={{ minHeight: 130 }}
        />
        <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
          Meta only allows free-form messages within 24 hours of their last message
          to you. Outside that window this will be refused with Meta's own reason,
          and you'll need an approved template.
        </p>
      </div>

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={() => setWaOpen(false)}>Cancel</button>
        <button
          className={`btn btn-primary${waSending ? " btn-busy" : ""}`}
          onClick={() => void sendWhatsApp()}
          disabled={waSending || !waText.trim()}
        >
          {waSending ? "Sending…" : "Send"}
        </button>
      </div>
    </Modal>
  );

  // Email from the record itself. Before this, the product could not send an
  // email at all: Templates was a notepad and send-campaign had no callers.
  const emailModal = emOpen && (
    <Modal title={`Email ${lead.name}`} onClose={() => setEmOpen(false)} wide>
      <p className="sub" style={{ marginTop: -6 }}>
        Sent in your business's name, with replies going to your address, and logged against this
        record.
      </p>

      {lead.nurture_opted_out && (
        <p className="pill pill-red" style={{ display: "inline-block", margin: "4px 0 10px" }}>
          This person has unsubscribed — the send will be refused.
        </p>
      )}

      {templates.filter((t) => t.channel === "email").length > 0 && (
        <div className="field">
          <label className="label">Start from a template</label>
          <div className="row row-wrap">
            {templates.filter((t) => t.channel === "email").map((t) => (
              <button
                key={t.id}
                className="btn btn-sm"
                onClick={() => {
                  setEmSubject(merge(t.subject || t.name));
                  setEmText(merge(t.body));
                }}
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <label className="label" htmlFor="em-subject">Subject</label>
        <input
          id="em-subject"
          className="input"
          value={emSubject}
          onChange={(e) => setEmSubject(e.target.value)}
          placeholder={`Following up, ${(lead.name ?? "").split(" ")[0]}`}
        />
      </div>

      <div className="field">
        <label className="label" htmlFor="em-body">Message</label>
        <textarea
          id="em-body"
          className="textarea"
          value={emText}
          onChange={(e) => setEmText(e.target.value)}
          style={{ minHeight: 180 }}
        />
        <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
          Plain text. Blank lines become paragraphs and links are made clickable — an unsubscribe
          footer is added automatically, because bulk senders without one get filtered as spam.
        </p>
      </div>

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={() => setEmOpen(false)}>Cancel</button>
        <button
          className={`btn btn-primary${emSending ? " btn-busy" : ""}`}
          onClick={() => void sendEmail()}
          disabled={emSending || !emSubject.trim() || !emText.trim() || lead.nurture_opted_out}
        >
          {emSending ? "Sending…" : "Send email"}
        </button>
      </div>
    </Modal>
  );

  const consentPrefs = getConsentPreferences(lead);

  const complianceModal = complianceOpen && (
    <Modal title={`🛡️ Compliance & Data Privacy — ${lead.name}`} onClose={() => setComplianceOpen(false)} wide>
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button
          className={`tab${complianceTab === "consent" ? " active" : ""}`}
          onClick={() => setComplianceTab("consent")}
        >
          Communication &amp; Consent
        </button>
        <button
          className={`tab${complianceTab === "sar" ? " active" : ""}`}
          onClick={() => setComplianceTab("sar")}
        >
          Data Subject Dossier (SAR)
        </button>
        <button
          className={`tab${complianceTab === "rectification" ? " active" : ""}`}
          onClick={() => setComplianceTab("rectification")}
        >
          ⚖️ Right to Rectification
        </button>
        {isAdmin && (
          <button
            className={`tab${complianceTab === "erasure" ? " active" : ""}`}
            onClick={() => setComplianceTab("erasure")}
            style={{ color: complianceTab === "erasure" ? "#b91c1c" : undefined }}
          >
            Right to Erasure
          </button>
        )}
      </div>

      {complianceTab === "consent" && (
        <div className="stack">
          <p className="sub" style={{ marginTop: -4, marginBottom: 10 }}>
            Manage statutory communication consent and Do-Not-Contact (DNC) preferences under India's DPDP Act 2023 and GDPR.
          </p>

          <div className="field">
            <label className="label">Statutory Consent Basis</label>
            <select
              className="input"
              value={consentDraft?.consent_status ?? "inbound_inquiry"}
              onChange={(e) =>
                setConsentDraft((prev) =>
                  prev ? { ...prev, consent_status: e.target.value as any } : null
                )
              }
            >
              <option value="inbound_inquiry">Inbound Commercial Enquiry (Legitimate Interest / Implied Consent)</option>
              <option value="explicit_consent">Explicit Consent Granted (Verifiable Opt-In)</option>
              <option value="consent_withdrawn">Consent Withdrawn / Revoked (Do Not Outreach)</option>
            </select>
          </div>

          <div className="field">
            <label className="label">Channel Opt-Out Restrictions (Do Not Contact)</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
              <label className="row" style={{ cursor: "pointer", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={consentDraft?.opt_out_whatsapp ?? false}
                  onChange={(e) =>
                    setConsentDraft((prev) =>
                      prev ? { ...prev, opt_out_whatsapp: e.target.checked } : null
                    )
                  }
                />
                <span><b>WhatsApp Opt-Out:</b> Do not send WhatsApp outreach or template alerts</span>
              </label>
              <label className="row" style={{ cursor: "pointer", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={consentDraft?.opt_out_email ?? false}
                  onChange={(e) =>
                    setConsentDraft((prev) =>
                      prev ? { ...prev, opt_out_email: e.target.checked } : null
                    )
                  }
                />
                <span><b>Email Opt-Out:</b> Do not send email campaigns or automated nurture</span>
              </label>
              <label className="row" style={{ cursor: "pointer", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={consentDraft?.opt_out_calls ?? false}
                  onChange={(e) =>
                    setConsentDraft((prev) =>
                      prev ? { ...prev, opt_out_calls: e.target.checked } : null
                    )
                  }
                />
                <span><b>Do Not Call (DNC):</b> Do not place outbound calls</span>
              </label>
            </div>
          </div>

          <div className="field">
            <label className="label">Consent Documentation &amp; Audit Notes</label>
            <textarea
              className="textarea"
              rows={3}
              value={consentDraft?.consent_notes ?? ""}
              onChange={(e) =>
                setConsentDraft((prev) =>
                  prev ? { ...prev, consent_notes: e.target.value } : null
                )
              }
              placeholder="e.g. Verbal request during call on 21 Oct, or web form opt-in timestamp"
            />
          </div>

          <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
            <button className="btn" onClick={() => setComplianceOpen(false)}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={consentSaving}
              onClick={async () => {
                if (!consentDraft || !lead) return;
                setConsentSaving(true);
                const res = await saveConsentPreferences(supabase, lead, consentDraft, profile);
                setConsentSaving(false);
                if (!res.success) {
                  toast.error(res.error || "Could not save consent preferences");
                  return;
                }
                toast.show("Consent preferences updated and logged");
                setComplianceOpen(false);
                await load();
              }}
            >
              {consentSaving ? "Saving…" : "Save Preferences"}
            </button>
          </div>
        </div>
      )}

      {complianceTab === "sar" && (
        <div className="stack">
          <p className="sub" style={{ marginTop: -4, marginBottom: 12 }}>
            Under Section 11 of India's DPDP Act 2023 and Articles 15 &amp; 20 of GDPR, any Data Principal has the right to access and obtain a portable copy of all personal data, activity timelines, and chat transcripts held by your organisation.
          </p>

          <div style={{ background: "var(--track, #f1f5f9)", borderRadius: 10, padding: 14, fontSize: 13, lineHeight: 1.6 }}>
            <div><b>Data Subject:</b> {lead.name} ({lead.email || "no email"} · {lead.phone || "no phone"})</div>
            <div><b>Data Fiduciary:</b> {org?.name ?? "Your Organization"}</div>
            <div><b>Timeline Entries:</b> {acts.length} recorded events</div>
            <div><b>Format:</b> Machine-readable portable JSON with statutory compliance headers</div>
          </div>

          <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
            <button className="btn" onClick={() => setComplianceOpen(false)}>Close</button>
            <button
              className="btn btn-primary"
              disabled={exportingSar}
              onClick={async () => {
                setExportingSar(true);
                try {
                  const { data: convs } = await supabase
                    .from("conversations")
                    .select("id, created_at")
                    .eq("lead_id", lead.id);

                  let transcripts: any[] = [];
                  if (convs?.length) {
                    const convIds = convs.map((c) => c.id);
                    const { data: msgs } = await supabase
                      .from("chat_messages")
                      .select("conversation_id, role, content, created_at")
                      .in("conversation_id", convIds)
                      .order("created_at");

                    transcripts = convs.map((c) => ({
                      conversation_id: c.id,
                      started_at: c.created_at,
                      messages: (msgs || [])
                        .filter((m) => m.conversation_id === c.id)
                        .map((m) => ({
                          role: m.role,
                          content: m.content,
                          timestamp: m.created_at,
                        })),
                    }));
                  }

                  exportLeadSAR(lead, acts, transcripts, org?.name || "AbroBot Customer");
                  toast.show("Data Subject Access Request (SAR) package downloaded");
                  setComplianceOpen(false);
                } catch (err) {
                  toast.error(`SAR export failed: ${(err as Error).message}`);
                } finally {
                  setExportingSar(false);
                }
              }}
            >
              {exportingSar ? "Packaging Dossier…" : "📁 Download Official SAR Dossier (JSON)"}
            </button>
          </div>
        </div>
      )}

      {complianceTab === "rectification" && (
        <div className="stack">
          <p className="sub" style={{ marginTop: -4, marginBottom: 12 }}>
            Under Section 12(1) of India's DPDP Act 2023 and Article 16 of GDPR, a Data Principal has the right to correction, completion, and updating of inaccurate personal data.
          </p>

          <div className="field">
            <label className="label">Full Name</label>
            <input
              className="input"
              value={rectName}
              onChange={(e) => setRectName(e.target.value)}
              placeholder="Full Name"
            />
          </div>

          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field">
              <label className="label">Email Address</label>
              <input
                className="input"
                type="email"
                value={rectEmail}
                onChange={(e) => setRectEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </div>
            <div className="field">
              <label className="label">Phone Number</label>
              <input
                className="input"
                type="tel"
                value={rectPhone}
                onChange={(e) => setRectPhone(e.target.value)}
                placeholder="+91 98765 43210"
              />
            </div>
          </div>

          <div className="field">
            <label className="label">Statutory Request Basis / Justification (Mandatory Audit Requirement)</label>
            <textarea
              className="textarea"
              rows={3}
              value={rectReason}
              onChange={(e) => setRectReason(e.target.value)}
              placeholder="e.g. Data Principal submitted correction request via support email on 22 Oct 2026 citing updated phone number."
            />
          </div>

          <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
            <button className="btn" onClick={() => setComplianceOpen(false)}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={rectSaving || !rectReason.trim() || !rectName.trim()}
              onClick={async () => {
                if (!lead || !rectReason.trim() || !rectName.trim()) return;
                setRectSaving(true);
                const res = await recordDataRectification(
                  supabase,
                  lead,
                  {
                    name: rectName.trim(),
                    email: rectEmail.trim() || null,
                    phone: rectPhone.trim() || null,
                  },
                  rectReason.trim(),
                  profile,
                );
                setRectSaving(false);
                if (!res.success) {
                  toast.error(res.error || "Could not record rectification");
                  return;
                }
                toast.show("Data rectification logged and updated under DPDP / GDPR");
                setComplianceOpen(false);
                await load();
              }}
            >
              {rectSaving ? "Saving Rectification…" : "Record Statutory Rectification"}
            </button>
          </div>
        </div>
      )}

      {complianceTab === "erasure" && isAdmin && (
        <div className="stack">
          <div style={{ background: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.3)", borderRadius: 10, padding: 14 }}>
            <div style={{ fontWeight: 700, color: "#b91c1c", fontSize: 14, marginBottom: 4 }}>
              ⚠️ Right to Erasure / Right to be Forgotten (DPDP Sec. 12 / GDPR Art. 17)
            </div>
            <p className="sub" style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
              Executing this request permanently redacts this person's personal data (name, email, phone, custom fields, and conversation identifiers).
              The record will be anonymized, an official compliance audit entry will be logged, and the record will be archived.
              <b> This action cannot be reversed.</b>
            </p>
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label className="label">Type <code>ERASE</code> to confirm statutory erasure:</label>
            <input
              className="input"
              value={erasureInput}
              onChange={(e) => setErasureInput(e.target.value)}
              placeholder="Type ERASE"
            />
          </div>

          <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
            <button className="btn" onClick={() => setComplianceOpen(false)}>Cancel</button>
            <button
              className="btn btn-danger"
              disabled={erasureInput.trim() !== "ERASE" || erasing}
              onClick={async () => {
                if (erasureInput.trim() !== "ERASE" || !lead) return;
                setErasing(true);
                const cert = generateErasureCertificate(
                  lead.id,
                  org?.name || "AbroBot Customer",
                  org?.id || "",
                  profile?.full_name || profile?.email || "Compliance Officer",
                );
                const res = await eraseLeadPII(supabase, lead, profile);
                setErasing(false);
                if (!res.success) {
                  toast.error(res.error || "Erasure failed");
                  return;
                }
                downloadErasureCertificate(cert);
                toast.show("Personal data permanently erased & Certificate of Erasure downloaded");
                setComplianceOpen(false);
                navigate("/leads");
              }}
            >
              {erasing ? "Redacting PII…" : "Permanently Erase & Download Certificate"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );

  return (
    <div className="stack">
      {waModal}
      {emailModal}
      {complianceModal}
      {detailsOpen && (
        <EditLeadDetails
          lead={lead}
          stages={stages}
          onClose={() => setDetailsOpen(false)}
          onSaved={detailsSaved}
          navigate={navigate}
        />
      )}
      <div className="row">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate("/leads")}>← {ui.leadNounPlural}</button>
      </div>

      <div className="row" style={{ alignItems: "flex-start" }}>
        <div>
          <h1>{lead.name}</h1>
          <div className="row row-wrap" style={{ marginTop: 7 }}>
            <StagePill stageKey={stageKey} stages={stages} />
            <ScoreChip score={lead.score} />
            <span className="pill pill-muted">via {lead.source}</span>
            {lead.nurture_opted_out && <span className="pill pill-red">Unsubscribed</span>}
            {consentPrefs.opt_out_whatsapp && (
              <span className="pill pill-red" title="Visitor has requested not to be messaged on WhatsApp">
                🚫 WhatsApp Opt-out
              </span>
            )}
            {consentPrefs.opt_out_email && (
              <span className="pill pill-red" title="Visitor has opted out of marketing & email">
                🚫 Email Opt-out
              </span>
            )}
            {consentPrefs.opt_out_calls && (
              <span className="pill pill-amber" title="Visitor requested Do Not Call (DNC)">
                🚫 Do Not Call
              </span>
            )}
            {consentPrefs.consent_status === "consent_withdrawn" && (
              <span className="pill pill-red" title="Statutory consent withdrawn under DPDP Act / GDPR">
                ⚠️ Consent Withdrawn
              </span>
            )}
            {consentPrefs.consent_status === "explicit_consent" && (
              <span className="pill pill-green" title="Explicit verifiable consent recorded">
                ✓ Explicit Consent
              </span>
            )}

            {(Array.isArray(lead.tags) ? lead.tags : []).map((t) => (
              <button
                key={t}
                className="pill pill-interactive"
                title="Remove tag"
                onClick={() => void removeTag(t)}
              >
                {t} <span style={{ opacity: 0.55 }}>✕</span>
              </button>
            ))}

            {tagging ? (
              <input
                className="input"
                style={{ maxWidth: 150, padding: "3px 10px", borderRadius: 999, fontSize: 12 }}
                autoFocus
                placeholder="tag name"
                onBlur={(e) => { void addTag(e.target.value); setTagging(false); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { void addTag((e.target as HTMLInputElement).value); setTagging(false); }
                  if (e.key === "Escape") setTagging(false);
                }}
              />
            ) : (
              <button className="pill pill-muted pill-interactive" onClick={() => setTagging(true)}>+ tag</button>
            )}
          </div>
        </div>
        <div className="spacer" />
        <div className="row row-wrap" style={{ justifyContent: "flex-end" }}>
          {lead.phone && <a className="btn btn-sm" href={`tel:${lead.phone}`}>📞 Call</a>}
          {/* Admins only: send-campaign refuses everyone else with a 403, so
              showing it to a counsellor meant writing an email that could
              only bounce back as an error. They keep the mail-app link. */}
          {lead.email && isAdmin && (
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                if (consentPrefs.opt_out_email || lead.nurture_opted_out) {
                  if (!confirm("⚠️ This contact has opted out of email communication. Do you want to proceed?")) {
                    return;
                  }
                }
                setEmOpen(true);
              }}
              title="Send from your business address and log it here"
            >
              ✉️ Send email
            </button>
          )}
          {lead.phone && (
            waBlocked ? (
              // Not `disabled`: a disabled button swallows the tap, and on a
              // phone there is no hover to show a tooltip — the explanation
              // would be unreachable exactly where WhatsApp matters most.
              <button
                className="btn btn-sm"
                aria-disabled="true"
                style={{ opacity: 0.6 }}
                title={waBlocked}
                onClick={() => toast.error(waBlocked)}
              >
                💬 WhatsApp
              </button>
            ) : (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  if (consentPrefs.opt_out_whatsapp) {
                    if (!confirm("⚠️ This contact has opted out of WhatsApp messages under DPDP / GDPR communication preferences. Do you want to override and message them anyway?")) {
                      return;
                    }
                  }
                  setWaOpen(true);
                }}
              >
                💬 WhatsApp
              </button>
            )
          )}
          {/* The deep link stays, as a second option. It opens WhatsApp on the
              user's own phone and logs nothing — useful when they want a real
              conversation, useless as the only option, which is what it was. */}
          {lead.phone && (
            <a className="btn btn-sm" href={`https://wa.me/${lead.phone.replace(/[^\d]/g, "")}`}
               target="_blank" rel="noreferrer" title="Open in WhatsApp on this device (not logged)">
              ↗
            </a>
          )}
          {lead.email && (
            <a className="btn btn-sm" href={`mailto:${lead.email}`} title="Opens your own mail app — not sent or logged by the CRM">
              ✉️ Open in mail app
            </a>
          )}
          <button
            className="btn btn-sm"
            onClick={() => {
              setConsentDraft(getConsentPreferences(lead));
              setRectName(lead.name || "");
              setRectEmail(lead.email || "");
              setRectPhone(lead.phone || "");
              setRectReason("");
              setErasureInput("");
              setComplianceOpen(true);
            }}
            title="DPDP Act 2023 & GDPR: Export SAR dossier, manage consent, or erase personal data"
          >
            🛡️ Compliance
          </button>
          {isAdmin && (
            <button
              className="btn btn-sm btn-danger"
              onClick={() => void archive()}
              title="Hide this record; permanently deleted after 30 days"
            >
              🗄 Archive
            </button>
          )}
        </div>
      </div>

      <Card title="Quick actions">
        <div className="row-wrap">
          {ui.quickActions.map((a) => (
            <button
              key={a.key}
              className="btn btn-sm"
              onClick={async () => {
                // Both, not either. `else if` meant an action carrying BOTH a
                // stage and an activity type silently dropped the activity —
                // so "Book appointment" moved the card and logged no meeting,
                // and six actions labelled "Send proposal" / "Send quote" /
                // "Send itinerary" moved a card while sending nothing and
                // logging nothing. A law firm would believe a proposal had gone
                // out. These are still not *sending* anything — that needs the
                // Email button above — but they now leave a truthful trace.
                // Bail on the first failure instead of toasting success over it.
                // moveStage/log already toast their own error, and useToast
                // replaces the visible toast rather than queueing — so the old
                // unconditional toast.show(a.label) overwrote the error within
                // the same click. A rejected stage move (RLS, dropped
                // connection) ended with "Send proposal" on screen and the card
                // rolled back to where it started.
                if (a.toStage && !(await moveStage(a.toStage))) return;
                if (a.logAs && !(await log(a.logAs, `${a.label}.`))) return;
                if (a.toStage || a.logAs) toast.show(a.label);
              }}
            >
              {a.icon} {a.label}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 13 }}>
          <label className="label">Move to stage</label>
          <select className="select" value={stageKey} onChange={(e) => void moveStage(e.target.value)} style={{ maxWidth: 260 }}>
            {stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
      </Card>

      <div className="grid grid-2">
        <Card
          title="Details"
          action={
            <div className="row" style={{ gap: 6 }}>
              <button className="btn btn-sm" onClick={() => setDetailsOpen(true)}>
                Edit details
              </button>
              {fields.length > 0 && (
                <button className="btn btn-sm" onClick={() => setEditing(!editing)}>
                  {editing ? "Done" : "Edit fields"}
                </button>
              )}
            </div>
          }
        >
          <Detail k="Phone" v={lead.phone ?? "—"} />
          <Detail k="Email" v={lead.email ?? "—"} />
          <Detail k="Created" v={timeAgo(lead.created_at)} />
          <Detail k="Last contacted" v={timeAgo(lead.last_contacted_at)} />
          <Detail k="Follow-up" v={lead.next_follow_up_at ? new Date(lead.next_follow_up_at).toLocaleString("en-IN") : "—"} />
          {lead.lost_reason && <Detail k="Lost reason" v={lead.lost_reason} />}

          {fields.length > 0 && <div style={{ height: 1, background: "var(--border)", margin: "13px 0" }} />}

          {fields.map((f) =>
            editing ? (
              <div className="field" key={f.id}>
                {f.type !== "checkbox" && <label className="label">{f.label}</label>}
                <FieldInput
                  def={f}
                  value={lead.custom?.[f.key]}
                  onChange={async (v) => {
                    const before = lead.custom ?? {};
                    const next = { ...before, [f.key]: v };
                    setLead({ ...lead, custom: next });
                    // `.select("id")` for the same reason as moveStage above: an
                    // UPDATE matching no visible row is a 204 with error: null,
                    // so the typed value sat on screen looking saved and was
                    // gone on the next load.
                    const { data, error } = await supabase.from("leads").update({ custom: next }).eq("id", lead.id).select("id");
                    if (error) { setLead({ ...lead, custom: before }); toast.error(error.message); return; }
                    if (!data?.length) {
                      setLead({ ...lead, custom: before });
                      toast.error(`"${f.label}" was not saved — this record is no longer visible to you, or you no longer have permission to change it.`);
                    }
                  }}
                />
              </div>
            ) : (
              <Detail key={f.id} k={f.label} v={cellValue(lead, f.key)} />
            ),
          )}
        </Card>

        <IndustryTool kind={ui.tool} label={ui.toolLabel} lead={lead} onLeadChange={setLead} />
      </div>

      <Card title="Activity">
        <div className="row" style={{ gap: 9, marginBottom: 15 }}>
          <input
            className="input"
            placeholder="Add a note…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void addNote(); }}
          />
          <button className="btn btn-primary" onClick={addNote} disabled={!note.trim()}>Add</button>
        </div>

        {/* Error before empty. "Nothing logged yet." is a statement about this
            customer's history, and off a failed read it is a false one. */}
        {actsError ? (
          <LoadError message={actsError} onRetry={() => void load()} />
        ) : acts.length === 0 ? (
          <p className="sub">Nothing logged yet.</p>
        ) : (
          <div>
            {acts.map((a) => (
              <div key={a.id} style={{ display: "flex", gap: 11, padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: 17 }}>{iconFor(a.type)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{a.content}</div>
                  <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>
                    {humanize(a.type)} · {timeAgo(a.created_at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      {toast.node}
    </div>
  );
}

const Detail = ({ k, v }: { k: string; v: string }) => (
  <div className="row" style={{ justifyContent: "space-between", padding: "5px 0", gap: 14 }}>
    <span className="sub">{k}</span>
    <span style={{ fontWeight: 600, textAlign: "right", wordBreak: "break-word" }}>{v}</span>
  </div>
);

function iconFor(t: Activity["type"]): string {
  const m: Record<Activity["type"], string> = {
    note: "📝", call: "📞", whatsapp: "💬", email: "✉️", meeting: "🤝",
    stage_change: "🔀", assignment: "👤", system: "⚙️",
  };
  return m[t] ?? "•";
}
