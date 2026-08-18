import { useMemo, useState } from "react";
import { useApp, useLeads } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, Empty, ScoreChip, Spinner, useToast } from "../components/ui";
import type { Lead } from "../lib/types";

// Drag-and-drop board over the org's own stages. Uses native HTML5 DnD rather
// than a library — it is a board of cards, not a reason to add a dependency.

export function Pipeline({ navigate }: { navigate: (to: string) => void }) {
  const { org, ui, stages } = useApp();
  const { leads, loading, setLeads } = useLeads(org?.id);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const toast = useToast();

  const byStage = useMemo(() => {
    const m: Record<string, Lead[]> = {};
    stages.forEach((s) => { m[s.key] = []; });
    leads.forEach((l) => {
      const k = l.stage_key ?? l.stage;
      if (m[k]) m[k].push(l);
    });
    return m;
  }, [leads, stages]);

  const drop = async (stageKey: string) => {
    setOverKey(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;

    const lead = leads.find((l) => l.id === id);
    if (!lead || (lead.stage_key ?? lead.stage) === stageKey) return;

    // optimistic — the board should feel instant
    setLeads(leads.map((l) => (l.id === id ? { ...l, stage_key: stageKey } : l)));

    const label = stages.find((s) => s.key === stageKey)?.label ?? stageKey;
    const { error } = await supabase
      .from("leads")
      .update({ stage_key: stageKey, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (error) {
      setLeads(leads); // roll back
      toast.error(error.message);
      return;
    }
    await supabase.from("activities").insert({
      org_id: lead.org_id, lead_id: id, type: "stage_change", content: `Moved to ${label}.`,
    });
    toast.show(`Moved to ${label}`);
  };

  if (loading) return <Spinner />;

  if (stages.length === 0) {
    return <Card><Empty icon="🔀" title="No pipeline yet" hint="Pick an industry in Settings and your stages will be created." /></Card>;
  }

  return (
    <div className="stack">
      <div>
        <h1>Pipeline</h1>
        <p className="sub" style={{ marginTop: 2 }}>Drag a card to move it. {leads.length} {ui.leadNounPlural.toLowerCase()}.</p>
      </div>

      <div className="board">
        {stages.map((s) => {
          const items = byStage[s.key] ?? [];
          return (
            <div
              key={s.key}
              className={`board-col${overKey === s.key ? " drag-over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOverKey(s.key); }}
              onDragLeave={() => setOverKey((k) => (k === s.key ? null : k))}
              onDrop={() => void drop(s.key)}
            >
              <div className="board-col-head">
                <div style={{ fontWeight: 700, fontSize: 13 }}>
                  {s.is_won ? "🏆 " : s.is_lost ? "✖️ " : ""}{s.label}
                </div>
                <span className="pill pill-muted">{items.length}</span>
              </div>

              {items.length === 0 && <p className="sub" style={{ fontSize: 12, padding: "8px 2px" }}>Empty</p>}

              {items.map((l) => (
                <div
                  key={l.id}
                  className={`board-card${dragId === l.id ? " dragging" : ""}`}
                  draggable
                  onDragStart={() => setDragId(l.id)}
                  onDragEnd={() => { setDragId(null); setOverKey(null); }}
                  onClick={() => navigate(`/leads/${l.id}`)}
                >
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{l.name}</div>
                  <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>{l.phone ?? l.email ?? "—"}</div>
                  <div style={{ marginTop: 7 }}><ScoreChip score={l.score} /></div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {toast.node}
    </div>
  );
}
