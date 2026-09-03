import { useEffect, useMemo, useState } from "react";
import { useApp, useLeads } from "../lib/store";
import { supabase } from "../lib/supabase";
import {
  Card, Empty, FieldInput, Modal, ScoreChip, Skeleton, StagePill,
  cellValue, humanize, useToast, LoadError } from "../components/ui";
import type { Lead } from "../lib/types";

// Columns are resolved at runtime: the industry registry proposes defaults and
// any custom field marked show_in_list is appended. Nothing is hardcoded,
// which is what lets one screen serve a hospital and a car dealership.

type SortKey = "created" | "score" | "name" | "follow_up";

export function Leads({ navigate }: { navigate: (to: string) => void }) {
  const { org, ui, stages, fields, profile } = useApp();
  const { leads, loading, error: leadsError, reload } = useLeads(org?.id);
  const [q, setQ] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("created");
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toast = useToast();

  const columns = useMemo(() => {
    const extra = fields.filter((f) => f.show_in_list).map((f) => f.key);
    return Array.from(new Set([...ui.listColumns.filter((c) => c !== "stage" && c !== "score"), ...extra]));
  }, [ui.listColumns, fields]);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    leads.forEach((l) => (Array.isArray(l.tags) ? l.tags : []).forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [leads]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const rows = leads.filter((l) => {
      if (stageFilter && (l.stage_key ?? l.stage) !== stageFilter) return false;
      if (tagFilter && !(Array.isArray(l.tags) ? l.tags : []).includes(tagFilter)) return false;
      if (!term) return true;
      return (
        l.name.toLowerCase().includes(term) ||
        (l.email ?? "").toLowerCase().includes(term) ||
        (l.phone ?? "").includes(term)
      );
    });

    const sorted = [...rows];
    if (sort === "score") sorted.sort((a, b) => b.score - a.score);
    else if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "follow_up") {
      // Records with no follow-up sink to the bottom — an unscheduled record
      // isn't "due first", it's unplanned.
      sorted.sort((a, b) => {
        const av = a.next_follow_up_at ? new Date(a.next_follow_up_at).getTime() : Infinity;
        const bv = b.next_follow_up_at ? new Date(b.next_follow_up_at).getTime() : Infinity;
        return av - bv;
      });
    } else sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return sorted;
  }, [leads, q, stageFilter, tagFilter, sort]);

  // Selecting rows then filtering them away would leave invisible records in
  // the selection — and a bulk action would hit records the user can't see.
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(filtered.map((l) => l.id));
      const next = new Set(Array.from(prev).filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filtered]);

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const bulkUpdate = async (patch: Record<string, unknown>, label: string) => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const { error } = await supabase.from("leads").update(patch).in("id", ids);
    if (error) { toast.error(error.message); return; }
    if (org) {
      await supabase.from("activities").insert(
        ids.map((id) => ({
          org_id: org.id, lead_id: id, user_id: profile?.id ?? null,
          type: "system" as const, content: `${label} (bulk action).`,
        })),
      );
    }
    setSelected(new Set());
    await reload();
    toast.show(`${ids.length} updated`);
  };

  if (loading) return <Skeleton kind="table" />;
  if (leadsError) return <LoadError message={leadsError} onRetry={() => void reload()} />;

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1>{ui.leadNounPlural}</h1>
          <p className="sub" style={{ marginTop: 2 }}>
            {filtered.length === leads.length
              ? `${leads.length} total`
              : `${filtered.length} of ${leads.length}`}
          </p>
        </div>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setAdding(true)}>+ {ui.addLabel}</button>
      </div>

      <div className="row row-wrap">
        <input
          className="input"
          style={{ maxWidth: 280 }}
          placeholder={`Search ${ui.leadNounPlural.toLowerCase()}…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="select" style={{ maxWidth: 180 }} value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
          <option value="">All stages</option>
          {stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        {allTags.length > 0 && (
          <select className="select" style={{ maxWidth: 160 }} value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
            <option value="">All tags</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <select className="select" style={{ maxWidth: 170 }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="created">Newest first</option>
          <option value="score">Highest score</option>
          <option value="follow_up">Follow-up soonest</option>
          <option value="name">Name A–Z</option>
        </select>
        {(q || stageFilter || tagFilter) && (
          <button className="btn btn-sm btn-ghost" onClick={() => { setQ(""); setStageFilter(""); setTagFilter(""); }}>
            Clear
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <Card>
          <Empty
            icon={ui.icon}
            title={leads.length === 0 ? `No ${ui.leadNounPlural.toLowerCase()} yet` : "Nothing matches that filter"}
            hint={leads.length === 0
              ? "They'll appear here automatically once your widget or webhook is live."
              : "Try clearing the filters."}
          />
        </Card>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 34 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={selected.size > 0 && selected.size === filtered.length}
                    ref={(el) => {
                      // Partial selection gets the indeterminate dash rather
                      // than an unchecked box, which would imply "none".
                      if (el) el.indeterminate = selected.size > 0 && selected.size < filtered.length;
                    }}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(filtered.map((l) => l.id)) : new Set())
                    }
                  />
                </th>
                {columns.map((c) => <th key={c}>{humanize(c)}</th>)}
                <th>Stage</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr
                  key={l.id}
                  className={selected.has(l.id) ? "selected" : undefined}
                  onClick={() => navigate(`/leads/${l.id}`)}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${l.name}`}
                      checked={selected.has(l.id)}
                      onChange={() => toggleRow(l.id)}
                    />
                  </td>
                  {columns.map((c) => (
                    <td key={c} style={c === "name" ? { fontWeight: 600 } : undefined}>
                      {c === "name" ? (
                        <div>
                          <div>{l.name}</div>
                          {Array.isArray(l.tags) && l.tags.length > 0 && (
                            <div className="row-wrap" style={{ gap: 4, marginTop: 3 }}>
                              {l.tags.slice(0, 3).map((t) => (
                                <span key={t} className="pill pill-muted" style={{ fontSize: 10.5, padding: "1px 7px" }}>{t}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : cellValue(l, c)}
                    </td>
                  ))}
                  <td><StagePill stageKey={l.stage_key ?? l.stage} stages={stages} /></td>
                  <td><ScoreChip score={l.score} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected.size > 0 && (
        <div className="bulkbar">
          <b>{selected.size} selected</b>
          <select
            className="select"
            style={{ maxWidth: 150, background: "transparent", borderColor: "rgba(255,255,255,.2)" }}
            defaultValue=""
            onChange={(e) => {
              if (!e.target.value) return;
              const label = stages.find((s) => s.key === e.target.value)?.label ?? e.target.value;
              void bulkUpdate({ stage_key: e.target.value, updated_at: new Date().toISOString() }, `Moved to ${label}`);
              e.target.value = "";
            }}
          >
            <option value="">Move to…</option>
            {stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <button
            className="btn btn-sm"
            onClick={() => void bulkUpdate({ assigned_to: profile?.id ?? null }, "Assigned")}
          >
            Assign to me
          </button>
          <button
            className="btn btn-sm"
            onClick={() => {
              const at = new Date(); at.setDate(at.getDate() + 1);
              void bulkUpdate({ next_follow_up_at: at.toISOString() }, "Follow-up set for tomorrow");
            }}
          >
            Follow up tomorrow
          </button>
          <button className="btn btn-sm btn-ghost" style={{ color: "inherit" }} onClick={() => setSelected(new Set())}>
            Clear
          </button>
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
  const [dupe, setDupe] = useState<Lead | null>(null);

  const first = stages[0]?.key ?? "new";

  // Duplicate check as you type. Finding out you created a second record for
  // someone after the fact is the most common way CRM data rots.
  useEffect(() => {
    const term = email.trim().toLowerCase() || phone.trim();
    if (term.length < 5) { setDupe(null); return; }
    const t = setTimeout(async () => {
      let query = supabase.from("leads").select("id, name, email, phone, stage_key, stage, score").eq("org_id", orgId);
      query = email.trim() ? query.eq("email", email.trim().toLowerCase()) : query.eq("phone", phone.trim());
      const { data } = await query.limit(1);
      setDupe((data?.[0] as Lead) ?? null);
    }, 400);
    return () => clearTimeout(t);
  }, [email, phone, orgId]);

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

      {dupe && (
        <div
          className="card"
          style={{ background: "var(--amber-soft)", borderColor: "var(--amber)", marginBottom: 14, padding: 12 }}
        >
          <div style={{ fontWeight: 700, fontSize: 13 }}>⚠️ Already in your CRM</div>
          <div className="sub" style={{ fontSize: 12.5, marginTop: 3 }}>
            <b>{dupe.name}</b> has the same {email.trim() ? "email" : "phone"}. Saving will create a second record.
          </div>
        </div>
      )}

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
          {saving ? "Saving…" : dupe ? "Save anyway" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
