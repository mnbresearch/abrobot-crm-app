import { useMemo } from "react";
import { BarChart, Bar, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import { useApp, useLeads } from "../lib/store";
import { computeKpi } from "../lib/industries";
import { Card, Empty, ScoreChip, Spinner, StagePill, timeAgo } from "../components/ui";
import type { Lead } from "../lib/types";

// The dashboard reshapes itself entirely from the industry registry: which
// numbers matter, what they are called, and what the funnel looks like. A
// hospital sees "Currently Admitted"; a recruiter sees "Offers Out".

export function Dashboard({ navigate }: { navigate: (to: string) => void }) {
  const { org, ui, stages } = useApp();
  const { leads, loading } = useLeads(org?.id);

  const stageMeta = useMemo(
    () => stages.map((s) => ({ key: s.key, is_won: s.is_won, is_lost: s.is_lost })),
    [stages],
  );

  const funnel = useMemo(
    () =>
      stages
        .filter((s) => !s.is_lost)
        .map((s) => ({
          name: s.label,
          count: leads.filter((l) => (l.stage_key ?? l.stage) === s.key).length,
        })),
    [stages, leads],
  );

  const bySource = useMemo(() => {
    const m: Record<string, number> = {};
    leads.forEach((l) => { m[l.source] = (m[l.source] ?? 0) + 1; });
    return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [leads]);

  // "What should I do right now" — the ranked list the CRM should lead with,
  // rather than making someone go hunting through filters.
  const priority = useMemo(() => {
    const wonLost = new Set(stages.filter((s) => s.is_won || s.is_lost).map((s) => s.key));
    const now = Date.now();
    return leads
      .filter((l) => !wonLost.has(l.stage_key ?? l.stage))
      .map((l) => {
        const due = l.next_follow_up_at ? new Date(l.next_follow_up_at).getTime() : null;
        const overdueDays = due && due < now ? Math.floor((now - due) / 86400000) : 0;
        return { lead: l, urgency: l.score + overdueDays * 12 + (due && due <= now ? 25 : 0) };
      })
      .sort((a, b) => b.urgency - a.urgency)
      .slice(0, 8);
  }, [leads, stages]);

  if (loading) return <Spinner />;

  const accent = ui.accent ?? "#b45309";
  const PIE = [accent, "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ef4444", "#78716c"];

  return (
    <div className="stack">
      <div>
        <h1>{ui.icon} {org?.name}</h1>
        <p className="sub" style={{ marginTop: 3 }}>{ui.dashboardNote}</p>
      </div>

      <div className="grid grid-kpi">
        {ui.kpis.map((k) => {
          const { value } = computeKpi(k, leads, stageMeta);
          return (
            <div className="kpi" key={k.key}>
              <div className="kpi-label">{k.icon} {k.label}</div>
              <div className="kpi-value" style={{ color: accent }}>{value}</div>
              {k.hint && <div className="kpi-hint">{k.hint}</div>}
            </div>
          );
        })}
      </div>

      {leads.length === 0 ? (
        <Card>
          <Empty
            icon={ui.icon}
            title={`No ${ui.leadNounPlural.toLowerCase()} yet`}
            hint="Install the website chat widget or connect a webhook, and they'll start arriving here automatically."
            action={<button className="btn btn-primary" onClick={() => navigate("/settings")}>Set up lead capture →</button>}
          />
        </Card>
      ) : (
        <>
          <Card title={`🔥 Work on these next`}>
            <p className="sub" style={{ marginTop: -8, marginBottom: 12 }}>
              Ranked by score and how overdue the follow-up is.
            </p>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{ui.leadNoun}</th>
                    <th>Stage</th>
                    <th>Score</th>
                    <th>Follow-up</th>
                  </tr>
                </thead>
                <tbody>
                  {priority.map(({ lead }) => (
                    <PriorityRow key={lead.id} lead={lead} onClick={() => navigate(`/leads/${lead.id}`)} stages={stages} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid grid-2">
            <Card title="Pipeline">
              <ResponsiveContainer width="100%" height={252}>
                <BarChart data={funnel} margin={{ top: 4, right: 4, bottom: 4, left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--muted)" }} interval={0} angle={-18} textAnchor="end" height={62} />
                  <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} allowDecimals={false} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid var(--border)", fontSize: 13 }} />
                  <Bar dataKey="count" fill={accent} radius={[7, 7, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card title="Where they come from">
              <ResponsiveContainer width="100%" height={252}>
                <PieChart>
                  <Pie data={bySource} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={88} label={{ fontSize: 11 }}>
                    {bySource.map((_, i) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid var(--border)", fontSize: 13 }} />
                </PieChart>
              </ResponsiveContainer>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function PriorityRow({ lead, onClick, stages }: { lead: Lead; onClick: () => void; stages: ReturnType<typeof useApp>["stages"] }) {
  const due = lead.next_follow_up_at ? new Date(lead.next_follow_up_at) : null;
  const overdue = due ? due.getTime() < Date.now() : false;
  return (
    <tr onClick={onClick}>
      <td>
        <div style={{ fontWeight: 600 }}>{lead.name}</div>
        <div className="sub" style={{ fontSize: 12 }}>{lead.phone ?? lead.email ?? "—"}</div>
      </td>
      <td><StagePill stageKey={lead.stage_key ?? lead.stage} stages={stages} /></td>
      <td><ScoreChip score={lead.score} /></td>
      <td>
        {due ? (
          <span className={overdue ? "pill pill-red" : "pill pill-muted"}>
            {overdue ? "Overdue " : ""}{timeAgo(lead.next_follow_up_at)}
          </span>
        ) : <span className="sub">—</span>}
      </td>
    </tr>
  );
}
