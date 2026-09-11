import { useMemo, useState } from "react";
import { useApp, useLeads, useStageCounts } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, Empty, Modal, ScoreChip, Spinner, StagePill, useToast, LoadError, TruncationNotice } from "../components/ui";
import type { Lead } from "../lib/types";

// Drag-and-drop board over the org's own stages. Uses native HTML5 DnD rather
// than a library — it is a board of cards, not a reason to add a dependency.
//
// HTML5 `draggable` does not fire on touch devices AT ALL — no dragstart, no
// drop, nothing to polyfill around. So on the phone that most of these
// customers actually run their business from, the entire pipeline was
// read-only: you could see the board and could not move a single card. Drag is
// retained for mouse users, and every card additionally carries a "Move"
// control that opens a stage picker. That control is not a fallback for touch;
// it is also the keyboard path, which native DnD never provided either.

export function Pipeline({ navigate }: { navigate: (to: string) => void }) {
  const { org, ui, stages } = useApp();
  const { leads, loading, error, reload, setLeads, totalLeads, truncated } = useLeads(org?.id);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [moving, setMoving] = useState<Lead | null>(null);
  const toast = useToast();

  // Only queried when the board is showing a slice — below that the in-memory
  // counts are already the whole truth and N extra requests buy nothing.
  const exactCounts = useStageCounts(org?.id, stages.map((s) => s.key), truncated);

  const byStage = useMemo(() => {
    const m: Record<string, Lead[]> = {};
    stages.forEach((s) => { m[s.key] = []; });
    leads.forEach((l) => {
      const k = l.stage_key ?? l.stage;
      if (m[k]) m[k].push(l);
    });
    return m;
  }, [leads, stages]);

  // One mover, two entry points. Drag and the stage picker were never allowed
  // to drift into two slightly different update paths — the optimistic write,
  // the rollback and the activity log all have to behave identically whichever
  // one the customer used.
  const moveTo = async (id: string, stageKey: string) => {
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
    // Secondary to the stage move that already succeeded — so a failure here
    // must not undo it, but it must not be invisible either: the Activity
    // feed would quietly stop matching what happened.
    const { error: actErr } = await supabase.from("activities").insert({
      org_id: lead.org_id, lead_id: id, type: "stage_change", content: `Moved to ${label}.`,
    });
    if (actErr) console.warn("stage move logged nowhere:", actErr.message);
    toast.show(`Moved to ${label}`);
  };

  const drop = async (stageKey: string) => {
    setOverKey(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    await moveTo(id, stageKey);
  };

  if (loading) return <Spinner />;


  // An unread error here told the customer they have no records. store.tsx

  // documents that exact failure — "a customer with 4,000 records being told,

  // convincingly, that they have none" — and this screen ignored it anyway.

  if (error) return <LoadError message={error} onRetry={reload} />;

  if (stages.length === 0) {
    return <Card><Empty icon="🔀" title="No pipeline yet" hint="Pick an industry in Settings and your stages will be created." /></Card>;
  }

  return (
    <div className="stack">
      {/* This screen showed no truncation notice at all, so the board simply
          presented the newest page as the whole pipeline. */}
      <TruncationNotice
        loaded={leads.length}
        total={totalLeads}
        noun={ui.leadNounPlural.toLowerCase()}
        what={exactCounts
          ? "The column totals below are exact, but the cards shown are the most recent ones."
          : "The cards and column totals below cover only these."}
      />

      <div>
        <h1>Pipeline</h1>
        <p className="sub" style={{ marginTop: 2 }}>
          Drag a card, or tap <b>Move</b> on it, to change its stage.{" "}
          {(totalLeads ?? leads.length).toLocaleString("en-IN")} {ui.leadNounPlural.toLowerCase()}.
        </p>
      </div>

      <div className="board">
        {stages.map((s) => {
          const items = byStage[s.key] ?? [];
          // Exact when we have it; otherwise the page is the whole org and the
          // in-memory count is exact anyway.
          const total = exactCounts?.[s.key] ?? items.length;
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
                <span className="pill pill-muted" title={total === items.length ? undefined : `${items.length} shown of ${total}`}>
                  {total.toLocaleString("en-IN")}
                </span>
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
                  <div className="row" style={{ marginTop: 7, gap: 8 }}>
                    <ScoreChip score={l.score} />
                    <div className="spacer" />
                    {/* stopPropagation: the card itself opens the record, and a
                        tap that both moved a card and navigated away would be
                        the worst of both. */}
                    <button
                      className="btn btn-sm btn-ghost"
                      style={{ padding: "4px 9px" }}
                      onClick={(e) => { e.stopPropagation(); setMoving(l); }}
                      aria-label={`Move ${l.name} to another stage`}
                    >
                      Move ▾
                    </button>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {moving && (
        <Modal title={`Move ${moving.name}`} onClose={() => setMoving(null)}>
          <p className="sub" style={{ marginTop: -6, marginBottom: 12 }}>
            Currently in <StagePill stageKey={moving.stage_key ?? moving.stage} stages={stages} />
          </p>
          <div className="stack" style={{ gap: 6 }}>
            {stages.map((s) => {
              const current = (moving.stage_key ?? moving.stage) === s.key;
              return (
                <button
                  key={s.key}
                  className="nav-item"
                  disabled={current}
                  style={{ opacity: current ? 0.5 : 1, cursor: current ? "default" : "pointer" }}
                  onClick={() => { const l = moving; setMoving(null); void moveTo(l.id, s.key); }}
                >
                  <span className="ico">{s.is_won ? "🏆" : s.is_lost ? "✖️" : "•"}</span>
                  <span style={{ flex: 1, textAlign: "left" }}>{s.label}</span>
                  {current && <span className="sub" style={{ fontSize: 12 }}>current</span>}
                </button>
              );
            })}
          </div>
        </Modal>
      )}
      {toast.node}
    </div>
  );
}
