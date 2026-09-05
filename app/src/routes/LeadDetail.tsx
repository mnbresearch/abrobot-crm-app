import { useCallback, useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase, callFunction } from "../lib/supabase";
import { Card, FieldInput, Modal, ScoreChip, Spinner, StagePill, cellValue, humanize, timeAgo, useToast } from "../components/ui";
import { IndustryTool } from "../components/IndustryTool";
import type { Activity, Lead } from "../lib/types";

export function LeadDetail({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const { org, ui, stages, fields, profile } = useApp();
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
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    const [l, a] = await Promise.all([
      supabase.from("leads").select("*").eq("id", id).single(),
      supabase.from("activities").select("*").eq("lead_id", id).order("created_at", { ascending: false }).limit(100),
    ]);
    setLead((l.data as Lead) ?? null);
    setActs((a.data as Activity[]) ?? []);
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
      .then(({ data }) => setTemplates(data ?? []));
  }, [org]);

  // Preview-only substitution. The server does this again on send, from
  // _shared/template.ts, and that copy is authoritative — this one exists so
  // the person sees the real message before they commit to it.
  const merge = (body: string) => {
    if (!lead) return body;
    return body
      .replace(/\{\{\s*name\s*\}\}/gi, lead.name ?? "")
      .replace(/\{\{\s*first_name\s*\}\}/gi, (lead.name ?? "").split(" ")[0])
      .replace(/\{\{\s*country\s*\}\}/gi, lead.target_country ?? "")
      .replace(/\{\{\s*course\s*\}\}/gi, lead.course ?? lead.course_level ?? "")
      .replace(/\{\{\s*brand\s*\}\}/gi, org?.name ?? "");
  };

  const applyTemplate = (body: string) => setWaText(merge(body));

  const sendEmail = async () => {
    if (!lead || !emSubject.trim() || !emText.trim()) return;
    setEmSending(true);
    try {
      // lead_ids rather than an audience filter: this is one person, and the
      // audience path could quietly widen if a filter were ever mis-set.
      await callFunction("send-campaign", {
        subject: emSubject.trim(),
        body: emText.trim(),
        lead_ids: [lead.id],
      });
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
  const log = async (type: Activity["type"], content: string) => {
    if (!lead || !org) return;
    const { error } = await supabase.from("activities").insert({
      org_id: org.id, lead_id: lead.id, user_id: profile?.id ?? null, type, content,
    });
    if (error) { toast.error(error.message); return; }
    await supabase.from("leads").update({ last_contacted_at: new Date().toISOString() }).eq("id", lead.id);
    await load();
  };

  const moveStage = async (key: string) => {
    if (!lead) return;
    const label = stages.find((s) => s.key === key)?.label ?? key;
    const previous = lead;

    // Optimistic — the pill should move the instant you choose, not after a
    // round trip. Rolled back below if the write is rejected.
    setLead({ ...lead, stage_key: key });

    // stage_key is the source of truth; the DB trigger mirrors it back to the
    // legacy enum so the old frontend stays consistent.
    const { error } = await supabase
      .from("leads")
      .update({ stage_key: key, updated_at: new Date().toISOString() })
      .eq("id", lead.id);

    if (error) {
      setLead(previous);
      toast.error(error.message);
      return;
    }
    await log("stage_change", `Moved to ${label}.`);
    toast.show(`Moved to ${label}`);
  };

  const addTag = async (tag: string) => {
    if (!lead || !tag.trim()) return;
    const tags: string[] = Array.isArray(lead.tags) ? lead.tags : [];
    const clean = tag.trim().toLowerCase();
    if (tags.includes(clean)) return;
    const next = [...tags, clean];
    setLead({ ...lead, tags: next });
    const { error } = await supabase.from("leads").update({ tags: next }).eq("id", lead.id);
    if (error) { setLead({ ...lead, tags }); toast.error(error.message); }
  };

  const removeTag = async (tag: string) => {
    if (!lead) return;
    const tags: string[] = Array.isArray(lead.tags) ? lead.tags : [];
    const next = tags.filter((t) => t !== tag);
    setLead({ ...lead, tags: next });
    const { error } = await supabase.from("leads").update({ tags: next }).eq("id", lead.id);
    if (error) { setLead({ ...lead, tags }); toast.error(error.message); }
  };

  const addNote = async () => {
    if (!note.trim()) return;
    await log("note", note.trim());
    setNote("");
  };

  if (loading) return <Spinner />;
  if (!lead) return <Card><p>Not found.</p></Card>;

  const stageKey = lead.stage_key ?? lead.stage;

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

  return (
    <div className="stack">
      {waModal}
      {emailModal}
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
          {lead.email && (
            <button className="btn btn-sm btn-primary" onClick={() => setEmOpen(true)}>
              ✉️ Email
            </button>
          )}
          {lead.phone && (
            <button className="btn btn-sm btn-primary" onClick={() => setWaOpen(true)}>
              💬 WhatsApp
            </button>
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
          {lead.email && <a className="btn btn-sm" href={`mailto:${lead.email}`}>✉️ Email</a>}
        </div>
      </div>

      <Card title="Quick actions">
        <div className="row-wrap">
          {ui.quickActions.map((a) => (
            <button
              key={a.key}
              className="btn btn-sm"
              onClick={async () => {
                if (a.toStage) await moveStage(a.toStage);
                else if (a.logAs) { await log(a.logAs, `${a.label} logged.`); toast.show(a.label); }
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
            <button className="btn btn-sm" onClick={() => setEditing(!editing)}>
              {editing ? "Done" : "Edit"}
            </button>
          }
        >
          <Detail k="Phone" v={lead.phone ?? "—"} />
          <Detail k="Email" v={lead.email ?? "—"} />
          <Detail k="Created" v={timeAgo(lead.created_at)} />
          <Detail k="Last contacted" v={timeAgo(lead.last_contacted_at)} />
          <Detail k="Follow-up" v={lead.next_follow_up_at ? new Date(lead.next_follow_up_at).toLocaleString("en-IN") : "—"} />

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
                    const { error } = await supabase.from("leads").update({ custom: next }).eq("id", lead.id);
                    if (error) { setLead({ ...lead, custom: before }); toast.error(error.message); }
                  }}
                />
              </div>
            ) : (
              <Detail key={f.id} k={f.label} v={cellValue(lead, f.key)} />
            ),
          )}
        </Card>

        <IndustryTool kind={ui.tool} label={ui.toolLabel} lead={lead} />
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

        {acts.length === 0 ? (
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
