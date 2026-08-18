import { useEffect, useMemo, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, Empty, Spinner, humanize, timeAgo } from "../components/ui";
import type { Activity as ActivityRow } from "../lib/types";

// Org-wide activity feed, grouped by day. Answers "what has the team done".

interface Row extends ActivityRow {
  leads?: { name: string } | null;
  profiles?: { full_name: string } | null;
}

const TYPES = ["", "call", "whatsapp", "email", "meeting", "note", "stage_change", "system"];

const ICONS: Record<string, string> = {
  note: "📝", call: "📞", whatsapp: "💬", email: "✉️", meeting: "🤝",
  stage_change: "🔀", assignment: "👤", system: "⚙️",
};

export function Activity({ navigate }: { navigate: (to: string) => void }) {
  const { org } = useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!org) return;
    void (async () => {
      // Joins mirror the legacy app's shape: activities → leads and profiles.
      const { data } = await supabase
        .from("activities")
        .select("*, leads:lead_id(name), profiles:user_id(full_name)")
        .eq("org_id", org.id)
        .order("created_at", { ascending: false })
        .limit(300);
      setRows((data as Row[]) ?? []);
      setLoading(false);
    })();
  }, [org]);

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
        <Card><Empty icon="🗂️" title="Nothing logged yet" hint="Calls, notes and stage changes will appear here." /></Card>
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
