import { useEffect, useMemo, useState } from "react";
import { BarChart, Bar, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import { useApp, useLeads, useStageCounts } from "../lib/store";
import { supabase } from "../lib/supabase";
import { computeKpi } from "../lib/industries";
import type { KpiDef } from "../lib/industries";
import { AnimatedNumber, Card, Empty, ScoreChip, Skeleton, StagePill, timeAgo, LoadError, TruncationNotice } from "../components/ui";
import { HealthCard } from "../components/HealthCard";
import { SetupChecklist } from "../components/SetupChecklist";
import { ExecutiveRescueModal } from "../components/ExecutiveRescueModal";
import { analyzeRevenueLeakage, formatCurrencyINR, type AtRiskDeal, type LeakageRiskType } from "../lib/revenueLeakage";
import type { Lead, Profile } from "../lib/types";

// The dashboard reshapes itself entirely from the industry registry: which
// numbers matter, what they are called, and what the funnel looks like. A
// hospital sees "Currently Admitted"; a recruiter sees "Offers Out".

/**
 * A KPI computed from exact server-side stage counts, or null if this kind
 * cannot be derived from them.
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
  const { org, ui, stages, isAdmin, profile } = useApp();
  const { leads, loading, error: leadsError, reload, truncated, totalLeads, setLeads } = useLeads(org?.id);
  const [securityStats, setSecurityStats] = useState<{ total: number; latestFlag: string | null } | null>(null);
  const [members, setMembers] = useState<Profile[]>([]);
  const [rescuingDeal, setRescuingDeal] = useState<AtRiskDeal | null>(null);
  const [riskFilter, setRiskFilter] = useState<"all" | LeakageRiskType>("all");

  const [dashboardMode, setDashboardMode] = useState<"cockpit" | "war_room">(() => {
    try {
      const saved = localStorage.getItem("abrobot_dashboard_mode");
      if (saved === "cockpit" || saved === "war_room") return saved;
    } catch {}
    return "cockpit";
  });

  const handleModeChange = (mode: "cockpit" | "war_room") => {
    setDashboardMode(mode);
    try {
      localStorage.setItem("abrobot_dashboard_mode", mode);
    } catch {}
  };

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;

    // Load active team members for rep matrix and executive rescue assignments
    void supabase
      .from("profiles")
      .select("*")
      .eq("org_id", org.id)
      .eq("status", "active")
      .order("full_name")
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        setMembers(data as Profile[]);
      });

    // Check cybersecurity defense flags
    void supabase
      .from("conversations")
      .select("id, security_flag")
      .eq("org_id", org.id)
      .not("security_flag", "is", null)
      .limit(100)
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        setSecurityStats({
          total: data.length,
          latestFlag: data[0]?.security_flag ?? null,
        });
      });

    return () => { cancelled = true; };
  }, [org?.id]);

  const stageMeta = useMemo(
    () => stages.map((s) => ({ key: s.key, is_won: s.is_won, is_lost: s.is_lost })),
    [stages],
  );

  const exactCounts = useStageCounts(org?.id, stages.map((s) => s.key), truncated);

  // Autonomous Revenue Leakage & Pipeline Forecast Intelligence
  const leakageReport = useMemo(() => {
    return analyzeRevenueLeakage(leads, stages, members);
  }, [leads, stages, members]);

  const filteredAtRiskDeals = useMemo(() => {
    if (riskFilter === "all") return leakageReport.atRiskDeals;
    return leakageReport.atRiskDeals.filter((d) => d.riskType === riskFilter);
  }, [leakageReport.atRiskDeals, riskFilter]);

  const handleDealRescued = (updatedLead: Lead) => {
    setLeads(leads.map((l) => (l.id === updatedLead.id ? updatedLead : l)));
  };

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

  // Rep Cockpit: "What should I do right now"
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

  // Quota bar calculations
  const targetQuota = leakageReport.forecast.targetQuota;
  const committedVal = leakageReport.forecast.committedValue;
  const likelyVal = leakageReport.forecast.likelyValue;
  const committedPct = Math.min(100, Math.round((committedVal / targetQuota) * 100));
  const likelyPct = Math.min(100, Math.round((likelyVal / targetQuota) * 100));

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

      {/* Top Header with Dual Mode Switcher */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 14 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 style={{ margin: 0 }}>{ui.icon} {org?.name}</h1>
            {dashboardMode === "war_room" && (
              <span className={`pill ${leakageReport.healthStatus === "critical" ? "pill-red" : leakageReport.healthStatus === "attention" ? "pill-amber" : "pill-green"}`} style={{ fontSize: 11, fontWeight: 700 }}>
                {leakageReport.healthStatus === "critical" ? "🔴 Critical Leakage Alert" : leakageReport.healthStatus === "attention" ? "🟡 Attention Needed" : "🟢 Revenue Protected"}
              </span>
            )}
          </div>
          <p className="sub" style={{ marginTop: 4 }}>
            {dashboardMode === "war_room"
              ? "Autonomous Revenue Leakage Engine · Real-Time Pipeline Decay Telemetry & 1-Click Executive Rescue"
              : ui.dashboardNote}
          </p>
        </div>

        {/* Segmented Control */}
        <div
          style={{
            display: "inline-flex",
            background: "var(--bg-2)",
            padding: 4,
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            gap: 4,
          }}
        >
          <button
            type="button"
            className={`btn btn-sm ${dashboardMode === "cockpit" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => handleModeChange("cockpit")}
            style={{ fontSize: 13, fontWeight: 600 }}
          >
            🧑‍💼 Rep Daily Cockpit
          </button>
          <button
            type="button"
            className={`btn btn-sm ${dashboardMode === "war_room" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => handleModeChange("war_room")}
            style={{ fontSize: 13, fontWeight: 600, position: "relative" }}
          >
            🏛️ Executive War Room
            {leakageReport.atRiskDeals.length > 0 && (
              <span
                className="pill pill-red"
                style={{
                  marginLeft: 6,
                  padding: "1px 6px",
                  fontSize: 10,
                  borderRadius: 999,
                }}
              >
                {leakageReport.atRiskDeals.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* RENDER MODE: EXECUTIVE WAR ROOM */}
      {dashboardMode === "war_room" ? (
        <div className="stack" style={{ gap: 20 }}>
          {/* Revenue Telemetry Alert Strip */}
          <div
            className="card"
            style={{
              background:
                leakageReport.healthStatus === "critical"
                  ? "linear-gradient(135deg, rgba(239, 68, 68, 0.08), rgba(245, 158, 11, 0.04))"
                  : leakageReport.healthStatus === "attention"
                  ? "linear-gradient(135deg, rgba(245, 158, 11, 0.08), rgba(59, 130, 246, 0.04))"
                  : "linear-gradient(135deg, rgba(16, 185, 129, 0.08), rgba(59, 130, 246, 0.04))",
              borderLeft: `4px solid ${
                leakageReport.healthStatus === "critical"
                  ? "var(--red)"
                  : leakageReport.healthStatus === "attention"
                  ? "var(--amber)"
                  : "var(--green)"
              }`,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 14,
              padding: "14px 20px",
            }}
          >
            <div className="row" style={{ gap: 14, alignItems: "center" }}>
              <span style={{ fontSize: 28 }}>
                {leakageReport.healthStatus === "critical" ? "🚨" : leakageReport.healthStatus === "attention" ? "⚠️" : "🛡️"}
              </span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14.5 }}>
                  {leakageReport.healthStatus === "critical"
                    ? `Critical Revenue Decay Detected · ${formatCurrencyINR(leakageReport.totalAtRiskValue)} At Immediate Risk`
                    : leakageReport.healthStatus === "attention"
                    ? `Pipeline Velocity Warning · ${formatCurrencyINR(leakageReport.totalAtRiskValue)} Requires Executive Action`
                    : "Zero Uncontrolled Revenue Decay · Pipeline Operating at High Velocity"}
                </div>
                <div className="sub" style={{ fontSize: 12.5, marginTop: 2 }}>
                  {leakageReport.healthStatus === "healthy"
                    ? `Current pipeline leakage rate is at ${leakageReport.leakageRatePct}% (industry target < 15%). Deal momentum is sustained.`
                    : `${leakageReport.leakageRatePct}% of active pipeline value is stalling in SLA silence or overdue promises. Immediate intervention can recover up to 40% of at-risk deals.`}
                </div>
              </div>
            </div>
            {leakageReport.atRiskDeals.length > 0 && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setRescuingDeal(leakageReport.atRiskDeals[0])}
                style={{ fontWeight: 700, fontSize: 12.5 }}
              >
                ⚡ Rescue Highest Value Deal ({formatCurrencyINR(leakageReport.atRiskDeals[0].estimatedValue, true)}) →
              </button>
            )}
          </div>

          {/* 4 Executive Metric Cards */}
          <div className="grid grid-kpi stagger">
            <div className="kpi">
              <div className="kpi-label"><span aria-hidden="true">💼</span><span>Total Active Pipeline</span></div>
              <div className="kpi-value" style={{ color: accent }}>
                {formatCurrencyINR(leakageReport.totalPipelineValue, true)}
              </div>
              <div className="kpi-hint">Across loaded active deals</div>
            </div>

            <div className={`kpi ${leakageReport.totalAtRiskValue > 0 ? "kpi-alert" : ""}`}>
              <div className="kpi-label"><span aria-hidden="true">📉</span><span>Revenue at Risk</span></div>
              <div className="kpi-value" style={{ color: leakageReport.totalAtRiskValue > 0 ? "var(--red)" : "var(--green)" }}>
                {formatCurrencyINR(leakageReport.totalAtRiskValue, true)}
              </div>
              <div className="kpi-hint">
                {leakageReport.leakageRatePct}% leakage rate ({leakageReport.atRiskDeals.length} deals)
              </div>
            </div>

            <div className="kpi">
              <div className="kpi-label"><span aria-hidden="true">🔮</span><span>Predictive Forecast</span></div>
              <div className="kpi-value" style={{ color: "var(--blue)" }}>
                {formatCurrencyINR(leakageReport.forecast.likelyValue, true)}
              </div>
              <div className="kpi-hint">
                Committed: {formatCurrencyINR(leakageReport.forecast.committedValue, true)}
              </div>
            </div>

            <div className="kpi">
              <div className="kpi-label"><span aria-hidden="true">⏱️</span><span>Avg Lead Dwell Time</span></div>
              <div className="kpi-value">
                {leakageReport.atRiskDeals.length > 0
                  ? `${Math.round(leakageReport.atRiskDeals.reduce((a, b) => a + b.dwellDays, 0) / leakageReport.atRiskDeals.length)}d`
                  : "0d"}
              </div>
              <div className="kpi-hint">In current pipeline stage</div>
            </div>
          </div>

          {/* Predictive Quota Forecaster Progress Bar */}
          <Card title="🎯 Predictive Quarter Close Forecast & Quota Attainment">
            <div className="stack" style={{ gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
                <div>
                  <strong>Target Quota:</strong> {formatCurrencyINR(targetQuota)}
                </div>
                <div className="sub">
                  Committed: <strong>{formatCurrencyINR(committedVal)} ({committedPct}%)</strong> · Likely Close: <strong>{formatCurrencyINR(likelyVal)} ({likelyPct}%)</strong>
                </div>
              </div>

              {/* Multi-segment progress bar */}
              <div
                style={{
                  height: 18,
                  width: "100%",
                  background: "var(--track)",
                  borderRadius: 999,
                  overflow: "hidden",
                  position: "relative",
                  display: "flex",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${committedPct}%`,
                    background: "var(--green)",
                    transition: "width 0.3s ease",
                  }}
                  title={`Committed: ${formatCurrencyINR(committedVal)}`}
                />
                <div
                  style={{
                    height: "100%",
                    width: `${Math.max(0, likelyPct - committedPct)}%`,
                    background: "var(--blue)",
                    opacity: 0.85,
                    transition: "width 0.3s ease",
                  }}
                  title={`Likely Salvaged: ${formatCurrencyINR(likelyVal - committedVal)}`}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, marginTop: 2 }}>
                <div className="row" style={{ gap: 14 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--green)" }} /> Committed (High Confidence)
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--blue)" }} /> Rescuable Upside (40% Probable)
                  </span>
                </div>
                <div style={{ color: leakageReport.forecast.gapToQuota > 0 ? "var(--red)" : "var(--green)", fontWeight: 600 }}>
                  {leakageReport.forecast.gapToQuota > 0
                    ? `Gap to Quota: ${formatCurrencyINR(leakageReport.forecast.gapToQuota)}`
                    : "✓ Target Quota Fully Covered!"}
                </div>
              </div>
            </div>
          </Card>

          {/* At-Risk Deals Radar Table */}
          <Card title="⚡ At-Risk Revenue Radar: High-Priority Intervention Queue">
            {/* Filter Pills */}
            <div className="row" style={{ gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
              <button
                type="button"
                className={`btn btn-sm ${riskFilter === "all" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setRiskFilter("all")}
              >
                All At-Risk ({leakageReport.atRiskDeals.length})
              </button>
              <button
                type="button"
                className={`btn btn-sm ${riskFilter === "sla_breach" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setRiskFilter("sla_breach")}
              >
                SLA Silence &gt;48h ({leakageReport.riskTypeBreakdown.sla_breach.count})
              </button>
              <button
                type="button"
                className={`btn btn-sm ${riskFilter === "overdue_followup" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setRiskFilter("overdue_followup")}
              >
                Missed Commitments ({leakageReport.riskTypeBreakdown.overdue_followup.count})
              </button>
              <button
                type="button"
                className={`btn btn-sm ${riskFilter === "velocity_stalled" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setRiskFilter("velocity_stalled")}
              >
                Velocity Stalled ({leakageReport.riskTypeBreakdown.velocity_stalled.count})
              </button>
              <button
                type="button"
                className={`btn btn-sm ${riskFilter === "unassigned_revenue" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setRiskFilter("unassigned_revenue")}
              >
                Unassigned Revenue ({leakageReport.riskTypeBreakdown.unassigned_revenue.count})
              </button>
            </div>

            {filteredAtRiskDeals.length === 0 ? (
              <Empty
                icon="🛡️"
                title="No at-risk revenue detected"
                hint={
                  riskFilter === "all"
                    ? "All active opportunities are within their expected SLA window and velocity thresholds."
                    : "No deals matching this risk condition."
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Opportunity / Lead</th>
                      <th>Stage</th>
                      <th>Risk Diagnosis</th>
                      <th>Assigned Rep</th>
                      <th>Deal Value</th>
                      <th style={{ textAlign: "right" }}>Executive Rescue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAtRiskDeals.map((deal) => (
                      <tr key={deal.lead.id}>
                        <td>
                          <div
                            style={{ fontWeight: 600, cursor: "pointer", color: "var(--ink)" }}
                            onClick={() => navigate(`/leads/${deal.lead.id}`)}
                          >
                            {deal.lead.name}
                          </div>
                          <div className="sub" style={{ fontSize: 12 }}>
                            {deal.lead.phone ?? deal.lead.email ?? "—"}
                          </div>
                        </td>
                        <td>
                          <StagePill stageKey={deal.lead.stage_key ?? deal.lead.stage} stages={stages} />
                        </td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span className={`pill ${deal.severity === "critical" ? "pill-red" : "pill-amber"}`} style={{ fontSize: 11 }}>
                              {deal.riskTitle}
                            </span>
                          </div>
                          <div className="sub" style={{ fontSize: 11.5, marginTop: 2 }}>
                            {deal.riskDetail}
                          </div>
                        </td>
                        <td>
                          <span style={{ fontWeight: 500, fontSize: 13 }}>{deal.assignedMemberName}</span>
                        </td>
                        <td>
                          <span style={{ fontWeight: 700, color: "var(--red)", fontSize: 13.5 }}>
                            {formatCurrencyINR(deal.estimatedValue)}
                          </span>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => setRescuingDeal(deal)}
                            style={{
                              fontSize: 12,
                              padding: "4px 10px",
                              fontWeight: 700,
                              background: deal.severity === "critical" ? "var(--red)" : undefined,
                              borderColor: deal.severity === "critical" ? "var(--red)" : undefined,
                            }}
                          >
                            ⚡ Rescue Deal
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Rep Dwell Time & Pipeline Risk Matrix */}
          <Card title="👥 Sales Rep Pipeline Dwell & Leakage Matrix">
            <p className="sub" style={{ marginTop: -8, marginBottom: 12 }}>
              Executive audit of pipeline ownership, team workload distribution, and leakage exposure per rep.
            </p>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Team Member</th>
                    <th>Total Assigned Value</th>
                    <th>At-Risk Deals</th>
                    <th>At-Risk Value</th>
                    <th>Leakage Rate</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {leakageReport.repMatrix.map((r, i) => {
                    const repRate = r.totalAssignedValue > 0
                      ? Math.round((r.atRiskValue / r.totalAssignedValue) * 100)
                      : 0;
                    const isLeaking = repRate > 30 || r.atRiskCount >= 3;
                    return (
                      <tr key={r.memberId ?? `unassigned-${i}`}>
                        <td style={{ fontWeight: 600 }}>{r.memberName}</td>
                        <td>{formatCurrencyINR(r.totalAssignedValue)}</td>
                        <td>
                          <span className={r.atRiskCount > 0 ? "pill pill-amber" : "pill pill-muted"}>
                            {r.atRiskCount} {r.atRiskCount === 1 ? "deal" : "deals"}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600, color: r.atRiskValue > 0 ? "var(--red)" : "inherit" }}>
                          {formatCurrencyINR(r.atRiskValue)}
                        </td>
                        <td>{repRate}%</td>
                        <td>
                          <span className={`pill ${isLeaking ? "pill-red" : r.atRiskCount > 0 ? "pill-amber" : "pill-green"}`}>
                            {isLeaking ? "High Risk" : r.atRiskCount > 0 ? "Attention" : "Healthy"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : (
        /* RENDER MODE: REP DAILY COCKPIT (Original flow) */
        <>
          {/* Both render nothing when there's nothing to say. */}
          <HealthCard />
          <SetupChecklist navigate={navigate} />

          {securityStats && securityStats.total > 0 && (
            <div
              className="card"
              style={{
                background: "linear-gradient(135deg, rgba(16, 185, 129, 0.05), rgba(59, 130, 246, 0.05))",
                borderLeft: "4px solid var(--green)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 12,
                padding: "12px 18px",
              }}
            >
              <div className="row" style={{ gap: 12, alignItems: "center" }}>
                <span style={{ fontSize: 24 }}>🛡️</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                    AI Cybersecurity Shield Active · {securityStats.total} {securityStats.total === 1 ? "Probe" : "Probes"} Deflected
                  </div>
                  <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>
                    Malicious C++ code queries &amp; prompt injection attacks intercepted at gateway. Zero LLM leakage.
                  </div>
                </div>
              </div>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => navigate("/conversations")}
                style={{ fontWeight: 600, fontSize: 12 }}
              >
                Review Deflected Chats →
              </button>
            </div>
          )}

          <div className="grid grid-kpi stagger">
            {ui.kpis.map((k) => {
              const exact = exactCounts ? exactKpi(k, exactCounts, stageMeta) : null;
              const { value, raw } = exact ?? computeKpi(k, leads, stageMeta);
              const partial = truncated && !exact;
              const isAlert = k.kind === "overdue" && raw > 0;
              return (
                <div className={`kpi${isAlert ? " kpi-alert" : ""}`} key={k.key}>
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
                hint={isAdmin
                  ? "Install the website chat widget or connect a webhook, and they'll start arriving here automatically."
                  : "They'll arrive here automatically once an admin installs the website chat widget or connects a webhook — ask your admin to set up lead capture."}
                action={isAdmin
                  ? <button className="btn btn-primary" onClick={() => navigate("/settings")}>Set up lead capture →</button>
                  : undefined}
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
        </>
      )}

      {/* 1-Click Executive Rescue Intervention Modal */}
      {rescuingDeal && (
        <ExecutiveRescueModal
          deal={rescuingDeal}
          members={members}
          org={org}
          profile={profile}
          onClose={() => setRescuingDeal(null)}
          onSuccess={handleDealRescued}
        />
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
