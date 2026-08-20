import { useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useApp, useLeads } from "../lib/store";
import { Card, Empty, Spinner, useToast } from "../components/ui";
import type { Lead, Profile } from "../lib/types";
import { supabase } from "../lib/supabase";
import { useEffect } from "react";

// Reports = analytics + the counsellor leaderboard + export, in one screen.
// The legacy app split these across /analytics, /reports and /leaderboard;
// they answer the same question and are better read together.

const RANGES = [
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
  { key: "365", label: "12 months" },
  { key: "all", label: "All time" },
] as const;

export function Reports() {
  const { org, ui, stages } = useApp();
  const { leads, loading } = useLeads(org?.id);
  const [range, setRange] = useState<string>("90");
  const [team, setTeam] = useState<Profile[]>([]);
  const toast = useToast();

  useEffect(() => {
    if (!org) return;
    void supabase.from("profiles").select("*").eq("org_id", org.id)
      .then(({ data }) => setTeam((data as Profile[]) ?? []));
  }, [org]);

  const scoped = useMemo(() => {
    if (range === "all") return leads;
    const cutoff = Date.now() - Number(range) * 86400000;
    return leads.filter((l) => new Date(l.created_at).getTime() >= cutoff);
  }, [leads, range]);

  const wonKeys = useMemo(() => new Set(stages.filter((s) => s.is_won).map((s) => s.key)), [stages]);
  const lostKeys = useMemo(() => new Set(stages.filter((s) => s.is_lost).map((s) => s.key)), [stages]);
  const keyOf = (l: Lead) => l.stage_key ?? l.stage;

  const overTime = useMemo(() => {
    const buckets: Record<string, { name: string; created: number; won: number }> = {};
    scoped.forEach((l) => {
      const d = new Date(l.created_at);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      buckets[k] ??= { name: k, created: 0, won: 0 };
      buckets[k].created++;
      if (wonKeys.has(keyOf(l))) buckets[k].won++;
    });
    return Object.values(buckets).sort((a, b) => a.name.localeCompare(b.name));
  }, [scoped, wonKeys]);

  const funnel = useMemo(
    () => stages.map((s) => ({ name: s.label, count: scoped.filter((l) => keyOf(l) === s.key).length })),
    [stages, scoped],
  );

  const bySource = useMemo(() => {
    const m: Record<string, number> = {};
    scoped.forEach((l) => { m[l.source] = (m[l.source] ?? 0) + 1; });
    return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [scoped]);

  // Leaderboard — per counsellor, with a conversion rate that only counts
  // decided records, so someone with a young pipeline isn't punished.
  const leaderboard = useMemo(() => {
    return team
      .map((p) => {
        const mine = scoped.filter((l) => l.assigned_to === p.id);
        const won = mine.filter((l) => wonKeys.has(keyOf(l))).length;
        const lost = mine.filter((l) => lostKeys.has(keyOf(l))).length;
        const decided = won + lost;
        return {
          id: p.id,
          name: p.full_name || p.email,
          role: p.role,
          total: mine.length,
          won,
          open: mine.length - won - lost,
          conv: decided === 0 ? null : Math.round((won / decided) * 100),
          avgScore: mine.length === 0 ? 0 : Math.round(mine.reduce((a, l) => a + l.score, 0) / mine.length),
        };
      })
      .sort((a, b) => b.won - a.won || b.total - a.total);
  }, [team, scoped, wonKeys, lostKeys]);

  const exportCsv = () => {
    const cols = ["name", "email", "phone", "source", "stage_key", "score", "created_at", "next_follow_up_at"];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [cols.join(",")].concat(
      scoped.map((l) => cols.map((c) => esc((l as unknown as Record<string, unknown>)[c])).join(",")),
    );
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${org?.slug ?? "leads"}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.show(`Exported ${scoped.length} rows`);
  };

  if (loading) return <Spinner />;

  const accent = ui.accent ?? "#b45309";
  const PIE = [accent, "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ef4444", "#78716c"];

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1>Reports</h1>
          <p className="sub" style={{ marginTop: 2 }}>{scoped.length} {ui.leadNounPlural.toLowerCase()} in range</p>
        </div>
        <div className="spacer" />
        <div className="row row-wrap">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className={`btn btn-sm${range === r.key ? " btn-primary" : ""}`}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
          <button className="btn btn-sm" onClick={exportCsv}>⬇ Export CSV</button>
        </div>
      </div>

      {scoped.length === 0 ? (
        <Card><Empty icon="📈" title="Nothing in this range" hint="Try a wider date range." /></Card>
      ) : (
        <>
          <Card title="Created vs won">
            <ResponsiveContainer width="100%" height={252}>
              <LineChart data={overTime} margin={{ top: 4, right: 8, bottom: 4, left: -18 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--muted)" }} />
                <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} allowDecimals={false} />
                <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid var(--border)", fontSize: 13, background: "var(--card)", color: "var(--text)", boxShadow: "var(--shadow-md)" }}
                  itemStyle={{ color: "var(--text)" }}
                  labelStyle={{ color: "var(--muted)" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="created" stroke={accent} strokeWidth={2.4} dot={false} name="Created" />
                <Line type="monotone" dataKey="won" stroke="#10b981" strokeWidth={2.4} dot={false} name="Won" />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          <div className="grid grid-2">
            <Card title="Funnel">
              <ResponsiveContainer width="100%" height={252}>
                <BarChart data={funnel} margin={{ top: 4, right: 4, bottom: 4, left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10.5, fill: "var(--muted)" }} interval={0} angle={-20} textAnchor="end" height={64} />
                  <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} allowDecimals={false} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid var(--border)", fontSize: 13, background: "var(--card)", color: "var(--text)", boxShadow: "var(--shadow-md)" }}
                  itemStyle={{ color: "var(--text)" }}
                  labelStyle={{ color: "var(--muted)" }} />
                  <Bar dataKey="count" fill={accent} radius={[7, 7, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card title="Sources">
              <ResponsiveContainer width="100%" height={252}>
                <PieChart>
                  <Pie data={bySource} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={88} label={{ fontSize: 11 }}>
                    {bySource.map((_, i) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid var(--border)", fontSize: 13, background: "var(--card)", color: "var(--text)", boxShadow: "var(--shadow-md)" }}
                  itemStyle={{ color: "var(--text)" }}
                  labelStyle={{ color: "var(--muted)" }} />
                </PieChart>
              </ResponsiveContainer>
            </Card>
          </div>

          <Card title="🏆 Team leaderboard">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Member</th><th>Assigned</th><th>Open</th><th>Won</th>
                    <th>Conversion</th><th>Avg score</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((r, i) => (
                    <tr key={r.id} style={{ cursor: "default" }}>
                      <td style={{ fontWeight: 600 }}>
                        {i === 0 && r.won > 0 ? "🥇 " : ""}{r.name}
                        <div className="sub" style={{ fontSize: 11.5 }}>{r.role.replace("_", " ")}</div>
                      </td>
                      <td className="mono">{r.total}</td>
                      <td className="mono">{r.open}</td>
                      <td className="mono">{r.won}</td>
                      <td className="mono">{r.conv === null ? "—" : `${r.conv}%`}</td>
                      <td className="mono">{r.avgScore}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sub" style={{ fontSize: 12, marginTop: 10 }}>
              Conversion counts only decided records (won ÷ won+lost), so a young pipeline isn't penalised.
            </p>
          </Card>
        </>
      )}
      {toast.node}
    </div>
  );
}
