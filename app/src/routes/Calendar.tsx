import { useMemo, useState } from "react";
import { useApp, useLeads } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, Empty, ScoreChip, Spinner, StagePill, useToast } from "../components/ui";
import type { Lead } from "../lib/types";

// Follow-up calendar. A month grid plus the selected day's list, because the
// question people actually ask is "who am I calling today".

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function Calendar({ navigate }: { navigate: (to: string) => void }) {
  const { org, ui, stages } = useApp();
  const { leads, loading, reload } = useLeads(org?.id);
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState(() => iso(new Date()));
  const toast = useToast();

  const openLeads = useMemo(() => {
    const done = new Set(stages.filter((s) => s.is_won || s.is_lost).map((s) => s.key));
    return leads.filter((l) => !done.has(l.stage_key ?? l.stage) && l.next_follow_up_at);
  }, [leads, stages]);

  const byDay = useMemo(() => {
    const m: Record<string, Lead[]> = {};
    openLeads.forEach((l) => {
      const k = iso(new Date(l.next_follow_up_at!));
      (m[k] ??= []).push(l);
    });
    return m;
  }, [openLeads]);

  // Month grid starting Monday
  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first);
    const dow = (first.getDay() + 6) % 7; // Mon = 0
    start.setDate(first.getDate() - dow);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [cursor]);

  const reschedule = async (lead: Lead, days: number) => {
    const next = new Date();
    next.setDate(next.getDate() + days);
    const { error } = await supabase
      .from("leads")
      .update({ next_follow_up_at: next.toISOString() })
      .eq("id", lead.id);
    if (error) { toast.error(error.message); return; }
    await reload();
    toast.show(`${lead.name} moved to ${next.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`);
  };

  if (loading) return <Spinner />;

  const today = iso(new Date());
  const dayList = byDay[selected] ?? [];

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1>Calendar</h1>
          <p className="sub" style={{ marginTop: 2 }}>{openLeads.length} scheduled follow-ups</p>
        </div>
        <div className="spacer" />
        <div className="row">
          <button className="btn btn-sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>←</button>
          <b style={{ minWidth: 150, textAlign: "center" }}>
            {cursor.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}
          </b>
          <button className="btn btn-sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>→</button>
          <button className="btn btn-sm" onClick={() => { setCursor(new Date()); setSelected(today); }}>Today</button>
        </div>
      </div>

      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 5 }}>
          {DAYS.map((d) => (
            <div key={d} className="sub" style={{ textAlign: "center", fontSize: 11, fontWeight: 700, padding: "3px 0" }}>{d}</div>
          ))}
          {cells.map((d) => {
            const k = iso(d);
            const items = byDay[k] ?? [];
            const otherMonth = d.getMonth() !== cursor.getMonth();
            const isToday = k === today;
            const isSel = k === selected;
            const overdue = k < today && items.length > 0;
            return (
              <button
                key={k}
                onClick={() => setSelected(k)}
                style={{
                  minHeight: 62, borderRadius: 10, padding: 6, textAlign: "left", cursor: "pointer",
                  border: isSel ? "2px solid var(--industry)" : "1px solid var(--border)",
                  background: isToday ? "var(--industry-soft)" : "var(--card)",
                  opacity: otherMonth ? 0.4 : 1,
                }}
              >
                <div style={{ fontWeight: isToday ? 800 : 600, fontSize: 12.5 }}>{d.getDate()}</div>
                {items.length > 0 && (
                  <div
                    className={overdue ? "pill pill-red" : "pill"}
                    style={{ fontSize: 10.5, marginTop: 3, padding: "1px 7px" }}
                  >
                    {items.length}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </Card>

      <Card title={new Date(selected).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}>
        {dayList.length === 0 ? (
          <Empty icon="📅" title="Nothing scheduled" hint="Pick another day, or set a follow-up from a record." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>{ui.leadNoun}</th><th>Stage</th><th>Score</th><th>Reschedule</th></tr>
              </thead>
              <tbody>
                {dayList.map((l) => (
                  <tr key={l.id}>
                    <td onClick={() => navigate(`/leads/${l.id}`)}>
                      <div style={{ fontWeight: 600 }}>{l.name}</div>
                      <div className="sub" style={{ fontSize: 12 }}>{l.phone ?? l.email ?? "—"}</div>
                    </td>
                    <td onClick={() => navigate(`/leads/${l.id}`)}>
                      <StagePill stageKey={l.stage_key ?? l.stage} stages={stages} />
                    </td>
                    <td onClick={() => navigate(`/leads/${l.id}`)}><ScoreChip score={l.score} /></td>
                    <td>
                      <div className="row">
                        <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); void reschedule(l, 1); }}>+1d</button>
                        <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); void reschedule(l, 3); }}>+3d</button>
                        <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); void reschedule(l, 7); }}>+1w</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {toast.node}
    </div>
  );
}
