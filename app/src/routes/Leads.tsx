import { useMemo, useState } from "react";
import { useApp, useLeads } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, Empty, FieldInput, Modal, ScoreChip, Spinner, StagePill, cellValue, humanize, useToast } from "../components/ui";

// Columns are resolved at runtime: the industry registry proposes defaults,
// and any custom field marked show_in_list is appended. Nothing is hardcoded,
// which is what lets one screen serve a hospital and a car dealership.

export function Leads({ navigate }: { navigate: (to: string) => void }) {
  const { org, ui, stages, fields, profile } = useApp();
  const { leads, loading, reload } = useLeads(org?.id);
  const [q, setQ] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  const columns = useMemo(() => {
    const extra = fields.filter((f) => f.show_in_list).map((f) => f.key);
    return Array.from(new Set([...ui.listColumns.filter((c) => c !== "stage" && c !== "score"), ...extra]));
  }, [ui.listColumns, fields]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return leads.filter((l) => {
      if (stageFilter && (l.stage_key ?? l.stage) !== stageFilter) return false;
      if (!term) return true;
      return (
        l.name.toLowerCase().includes(term) ||
        (l.email ?? "").toLowerCase().includes(term) ||
        (l.phone ?? "").includes(term)
      );
    });
  }, [leads, q, stageFilter]);

  if (loading) return <Spinner />;

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1>{ui.leadNounPlural}</h1>
          <p className="sub" style={{ marginTop: 2 }}>
            {filtered.length} of {leads.length}
          </p>
        </div>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setAdding(true)}>+ {ui.addLabel}</button>
      </div>

      <div className="row row-wrap">
        <input
          className="input"
          style={{ maxWidth: 300 }}
          placeholder={`Search ${ui.leadNounPlural.toLowerCase()}…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="select" style={{ maxWidth: 200 }} value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
          <option value="">All stages</option>
          {stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <Empty
            icon={ui.icon}
            title={leads.length === 0 ? `No ${ui.leadNounPlural.toLowerCase()} yet` : "Nothing matches that filter"}
            hint={leads.length === 0 ? "They'll appear here automatically once your widget or webhook is live." : undefined}
          />
        </Card>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {columns.map((c) => <th key={c}>{humanize(c)}</th>)}
                <th>Stage</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id} onClick={() => navigate(`/leads/${l.id}`)}>
                  {columns.map((c) => (
                    <td key={c} style={c === "name" ? { fontWeight: 600 } : undefined}>{cellValue(l, c)}</td>
                  ))}
                  <td><StagePill stageKey={l.stage_key ?? l.stage} stages={stages} /></td>
                  <td><ScoreChip score={l.score} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <AddLead
          onClose={() => setAdding(false)}
          onSaved={async () => { setAdding(false); await reload(); toast.show(`${ui.leadNoun} added`); }}
          orgId={org!.id}
          userId={profile?.id ?? null}
        />
      )}
      {toast.node}
    </div>
  );
}

function AddLead({ orgId, userId, onClose, onSaved }: {
  orgId: string; userId: string | null; onClose: () => void; onSaved: () => void;
}) {
  const { ui, fields, stages } = useApp();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const first = stages[0]?.key ?? "new";

  const save = async () => {
    if (!name.trim()) { setErr("Name is required"); return; }
    if (!phone.trim() && !email.trim()) { setErr("Add a phone number or an email — one of the two is needed to follow up"); return; }
    setSaving(true);
    setErr(null);

    const { data, error } = await supabase.from("leads").insert({
      org_id: orgId,
      name: name.trim(),
      phone: phone.trim() || null,
      email: email.trim().toLowerCase() || null,
      source: "manual",
      stage_key: first,
      custom,
      assigned_to: userId,
      next_follow_up_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    }).select("id").single();

    setSaving(false);
    if (error) { setErr(error.message); return; }

    if (data?.id) {
      await supabase.from("activities").insert({
        org_id: orgId, lead_id: data.id, user_id: userId,
        type: "system", content: `${ui.leadNoun} added manually.`,
      });
    }
    onSaved();
  };

  return (
    <Modal title={ui.addLabel} onClose={onClose}>
      <div className="field">
        <label className="label">Name *</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label className="label">Phone</label>
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91…" />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="label">Email</label>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>

      {fields.slice(0, 6).map((f) => (
        <div className="field" key={f.id}>
          {f.type !== "checkbox" && <label className="label">{f.label}</label>}
          <FieldInput def={f} value={custom[f.key]} onChange={(v) => setCustom({ ...custom, [f.key]: v })} />
        </div>
      ))}

      {err && <p style={{ color: "var(--red)", fontSize: 13 }}>{err}</p>}

      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
