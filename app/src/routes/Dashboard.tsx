import { useMemo } from "react";
import { BarChart, Bar, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import { useApp, useLeads, useStageCounts } from "../lib/store";
import { computeKpi } from "../lib/industries";
import type { KpiDef } from "../lib/industries";
import { AnimatedNumber, Card, Empty, ScoreChip, Skeleton, StagePill, timeAgo, LoadError, TruncationNotice } from "../components/ui";
import { HealthCard } from "../components/HealthCard";
import { SetupChecklist } from "../components/SetupChecklist";
import type { Lead } from "../lib/types";

// The dashboard reshapes itself entirely from the industry registry: which
// numbers matter, what they are called, and what the funnel looks like. A
// hospital sees "Currently Admitted"; a recruiter sees "Offers Out".

/**
 * A KPI computed from exact server-side stage counts, or null if this kind
 * cannot be derived from them.
 *
 * Every KPI on this screen was counted over the loaded page and rendered as if
 * it were the org's total, so a 5,000-record customer read their dashboard as a
 * description of 1,000 records with nothing saying so. Three of the seven kinds
 * are pure functions of per-stage counts, and those are made exact here for the
 * cost of a few head-only count requests. The rest depend on per-row dates or
 * custom-field values that no count query can reach — those are labelled as
 * covering the loaded records rather than quietly overstated.
 */
function exactKpi(def: KpiDef, counts: Record<string, number>, stages: { key: string; is_won: boolean; is_lost: boolean }[]): { value: string; raw: number } | null {
  const fmt = (n: number) => n.toLocaleString("en-IN");
  const sum = (pick: (s: typeof stages[number]) => boolean) =>
    stages.filter(pick).reduce((n, s) => n + (counts[s.key] ?? 0), 0);

  switch (def.kind) {
    case "total": {
      const n = sum((s) => !s.is_won && !s.is_lost);
      return { value: fmt(n), raw: n };
    }
    case "stage_count": {
      const n = counts[def.stageKey ?? ""] ?? 0;
      return { value: fmt(n), raw: n };
    }
    case "conversion": {
      const won = sum((s) => s.is_won);
      const decided = won + sum((s) => s.is_lost);
      const pct = decided === 0 ? 0 : Math.round((won / decided) * 100);
      return { value: `${pct}%`, raw: pct };
    }
    default:
      return null;
  }
}

export function Dashboard({ navigate }: { navigate: (to: string) => void }) {
  const { org, ui, stages } = useApp();
  const { leads, loading, error: leadsError, reload, truncated, totalLeads } = useLeads(org?.id);

  const stageMeta = useMemo(
    () => stages.map((s) => ({ key: s.key, is_won: s.is_won, is_lost: s.is_lost })),
    [stages],
  );

  const exactCounts = useStageCounts(org?.id, stages.map((s) => s.key), truncated);

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

  if (loading) return <Skeleton kind="page" />;
  if (leadsError) return <LoadError message={leadsError} onRetry={() => void reload()} />;

  const accent = ui.accent ?? "#b45309";
  const PIE = [accent, "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ef4444", "#78716c"];

  return (
    <div className="stack">
      <TruncationNotice
        loaded={leads.length}
        total={totalLeads}
        noun={ui.leadNounPlural.toLowerCase()}
        what={exactCounts
          ? "Stage and conversion figures below are exact; the charts and the ranked list cover these records."
          : "The figures and charts below cover only these."}
      />

      <div>
        <h1>{ui.icon} {org?.name}</h1>
        <p className="sub" style={{ marginTop: 3 }}>{ui.dashboardNote}</p>
      </div>

      {/* Both render nothing when there's nothing to say. */}
      <HealthCard />
      <SetupChecklist navigate={navigate} />

      <div className="grid grid-kpi stagger">
        {ui.kpis.map((k) => {
          const exact = exactCounts ? exactKpi(k, exactCounts, stageMeta) : null;
          const { value, raw } = exact ?? computeKpi(k, leads, stageMeta);
          // Only the numbers we could NOT make exact get qualified. Labelling
          // an exact figure "of the N loaded" would be its own kind of lie.
          const partial = truncated && !exact;
          // Overdue is the one number that should feel uncomfortable when it
          // isn't zero — everything else stays in the industry accent.
          const isAlert = k.kind === "overdue" && raw > 0;
          return (
            <div className={`kpi${isAlert ? " kpi-alert" : ""}`} key={k.key}>
              {/* icon in its own element so the flex gap applies — bare text
                  nodes collapse against the label */}
              <div className="kpi-label"><span aria-hidden="true">{k.icon}</span><span>{k.label}</span></div>
              <div className="kpi-value" style={isAlert ? undefined : { color: accent }}>
                <AnimatedNumber value={value} />
                {partial && <span className="sub" style={{ fontSize: 13, fontWeight: 600 }}>&nbsp;+</span>}
              </div>
              {partial ? (
                <div className="kpi-hint" title="This figure needs each record's dates or field values, which cannot be counted without reading the rows.">
                  {k.hint ? `${k.hint} · ` : ""}of the {leads.length.toLocaleString("en-IN")} loaded
                </div>
              ) : k.hint ? <div className="kpi-hint">{k.hint}</div> : null}
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
                  <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid var(--border)", fontSize: 13, background: "var(--card)", color: "var(--text)", boxShadow: "var(--shadow-md)" }}
                  itemStyle={{ color: "var(--text)" }}
                  labelStyle={{ color: "var(--muted)" }} />
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
                  <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid var(--border)", fontSize: 13, background: "var(--card)", color: "var(--text)", boxShadow: "var(--shadow-md)" }}
                  itemStyle={{ color: "var(--text)" }}
                  labelStyle={{ color: "var(--muted)" }} />
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
