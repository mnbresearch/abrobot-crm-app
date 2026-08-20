import { useCallback, useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, FieldInput, ScoreChip, Spinner, StagePill, cellValue, humanize, timeAgo, useToast } from "../components/ui";
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

  return (
    <div className="stack">
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
          {lead.phone && (
            <a className="btn btn-sm" href={`https://wa.me/${lead.phone.replace(/[^\d]/g, "")}`} target="_blank" rel="noreferrer">
              💬 WhatsApp
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
