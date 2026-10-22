import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, Empty, Spinner, humanize, timeAgo , LoadError } from "../components/ui";
import type { Activity as ActivityRow } from "../lib/types";

// Org-wide activity feed, grouped by day. Answers "what has the team done".

interface Row extends ActivityRow {
  leads?: { name: string } | null;
  profiles?: { full_name: string } | null;
}

// Every value of the activity_type enum. "assignment" was missing, so the
// rows automations and reassignments write could be seen under "All types"
// but never filtered to — the one question "who moved my leads?" had no answer.
const TYPES = ["", "call", "whatsapp", "email", "meeting", "note", "stage_change", "assignment", "system"];

const ICONS: Record<string, string> = {
  note: "📝", call: "📞", whatsapp: "💬", email: "✉️", meeting: "🤝",
  stage_change: "🔀", assignment: "👤", system: "⚙️",
};

export function Activity({ navigate }: { navigate: (to: string) => void }) {
  const { org } = useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  // A named loader rather than an effect body, so the error card can offer
  // Try again. It had no retry at all: one dropped request left the page on
  // an error with no way back short of reloading the whole app.
  const load = useCallback(async () => {
    if (!org) { setLoading(false); return; }   // never leave the spinner up forever
    setLoading(true);
    // Joins mirror the legacy app's shape: activities → leads and profiles.
    const { data, error: loadErr } = await supabase
      .from("activities")
      .select("*, leads:lead_id(name), profiles:user_id(full_name)")
      .eq("org_id", org.id)
      .order("created_at", { ascending: false })
      .limit(300);
    // An unread error rendered "Nothing logged yet", which reads as "you have
    // no history" rather than "we could not check".
    if (loadErr) setError(loadErr.message);
    else { setError(null); setRows((data as Row[]) ?? []); }
    setLoading(false);
  }, [org]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => (filter ? rows.filter((r) => r.type === filter) : rows), [rows, filter]);

  const byDay = useMemo(() => {
    const groups: { day: string; items: Row[] }[] = [];
    filtered.forEach((r) => {
      const d = new Date(r.created_at);
      const day = d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.items.push(r);
      else groups.push({ day, items: [r] });
    });
    return groups;
  }, [filtered]);

  if (loading) return <Spinner />;

  if (error) return <LoadError message={error} onRetry={() => void load()} />;

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1>Activity</h1>
          <p className="sub" style={{ marginTop: 2 }}>{filtered.length} events</p>
        </div>
        <div className="spacer" />
        <select className="select" style={{ maxWidth: 190 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
          {TYPES.map((t) => <option key={t} value={t}>{t ? humanize(t) : "All types"}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        // With a filter on, "Nothing logged yet" would claim the team has done
        // nothing at all when it is only this one type that is empty.
        filter && rows.length > 0 ? (
          <Card><Empty icon="🗂️" title={`No ${humanize(filter).toLowerCase()} events`} hint="Choose All types to see everything else." /></Card>
        ) : (
          <Card><Empty icon="🗂️" title="Nothing logged yet" hint="Calls, notes and stage changes will appear here." /></Card>
        )
      ) : (
        byDay.map((g) => (
          <Card key={g.day} title={g.day}>
            {g.items.map((r) => (
              <div
                key={r.id}
                style={{ display: "flex", gap: 11, padding: "9px 0", borderBottom: "1px solid var(--border)", cursor: r.lead_id ? "pointer" : "default" }}
                onClick={() => r.lead_id && navigate(`/leads/${r.lead_id}`)}
              >
                <div style={{ fontSize: 17 }}>{ICONS[r.type] ?? "•"}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.content}</div>
                  <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>
                    {r.leads?.name && <b>{r.leads.name}</b>}
                    {r.leads?.name ? " · " : ""}
                    {r.profiles?.full_name ?? "System"} · {timeAgo(r.created_at)}
                  </div>
                </div>
              </div>
            ))}
          </Card>
        ))
      )}
    </div>
  );
}
