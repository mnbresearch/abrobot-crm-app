import { useCallback, useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, Empty, LoadError, Modal, Spinner, timeAgo, useToast } from "../components/ui";

/**
 * Platform admin console — every organisation, from one screen.
 *
 * Until now the only way to change a customer's plan, suspend an account, or
 * rescue an organisation whose only admin had left was to type UPDATE into the
 * Supabase SQL editor. That is not an access-control design; it is the absence
 * of one, and it left no record of who did what or why.
 *
 * Everything here goes through the admin_* functions, which each check
 * is_super_admin() themselves and write an admin_audit row. So the log is not
 * something this screen is trusted to keep — it is kept whether the action
 * comes from here, from psql, or from anywhere else.
 */

interface OrgRow {
  org_id: string;
  name: string;
  slug: string;
  plan: string;
  effective_plan: string;
  active: boolean;
  industry: string | null;
  members: number;
  records: number;
  ai_used: number | null;
  emails_used: number | null;
  whatsapp_used: number | null;
  period_end: string | null;
  created_at: string;
}

interface PlanRow {
  plan: string; label: string; price_inr: number | null; position: number;
  max_seats: number | null; max_leads: number | null; max_ai_messages: number | null;
  max_emails: number | null; max_whatsapp: number | null;
  max_automations: number | null; whatsapp: boolean; api_access: boolean;
}

interface AuditRow {
  created_at: string; actor_email: string | null; action: string;
  org_slug: string | null; detail: Record<string, unknown>;
}

export function Admin() {
  const { isSuperAdmin } = useApp();
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<OrgRow | null>(null);
  const [q, setQ] = useState("");
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    const [o, p, a] = await Promise.all([
      supabase.rpc("admin_list_orgs"),
      supabase.from("plan_limits").select("*").order("position"),
      supabase.rpc("admin_recent_actions", { p_limit: 50 }),
    ]);
    // The org list is the screen; the other two are context. Only the first
    // failing is worth blocking on.
    if (o.error) { setError(o.error.message); setLoading(false); return; }
    setError(null);
    setOrgs((o.data as OrgRow[]) ?? []);
    setPlans((p.data as PlanRow[]) ?? []);
    setAudit((a.data as AuditRow[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!isSuperAdmin) {
    return (
      <Card>
        <Empty
          icon="🔒"
          title="Platform admins only"
          hint="This screen reaches across every organisation, so it is limited to the platform owner."
        />
      </Card>
    );
  }

  if (loading) return <Spinner />;
  if (error) return <LoadError message={error} onRetry={() => void load()} />;

  const setActive = async (o: OrgRow, active: boolean) => {
    const verb = active ? "Reactivate" : "Suspend";
    const note = prompt(
      `${verb} ${o.name}?\n\n` +
      (active
        ? "Their team can sign in and work again."
        : "Their team keeps their data but cannot sign in. This is reversible.") +
      "\n\nReason (recorded in the audit log):",
    );
    if (note === null) return;   // cancelled — an empty string is a valid reason
    const { error: err } = await supabase.rpc("admin_set_org_active", {
      p_org_id: o.org_id, p_active: active, p_note: note || null,
    });
    if (err) { toast.error(err.message); return; }
    toast.show(`${o.name} ${active ? "reactivated" : "suspended"}`);
    await load();
  };

  const filtered = q.trim()
    ? orgs.filter((o) =>
        (o.name + " " + o.slug + " " + o.plan).toLowerCase().includes(q.trim().toLowerCase()))
    : orgs;

  const paying = orgs.filter((o) => !["free", "expired"].includes(o.effective_plan));
  const mrr = paying.reduce(
    (n, o) => n + (plans.find((p) => p.plan === o.effective_plan)?.price_inr ?? 0), 0);

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1>Platform admin</h1>
          <p className="sub" style={{ marginTop: 2 }}>
            {orgs.length} organisation{orgs.length === 1 ? "" : "s"} · {paying.length} paying ·
            {" "}₹{mrr.toLocaleString("en-IN")}/mo from listed plans
          </p>
        </div>
        <div className="spacer" />
        <input
          className="input"
          style={{ maxWidth: 240 }}
          placeholder="Search name, slug or plan"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn" onClick={() => void load()}>Refresh</button>
      </div>

      {/* MRR above counts the LISTED price of each org's effective plan. It is
          not revenue: enterprise is custom-priced, and an org set by hand has
          no payment behind it. Named rather than dressed up as a metric. */}

      <Card title="Organisations">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Organisation</th><th>Plan</th><th>Team</th><th>Records</th>
                <th>This month</th><th>Renews</th><th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => {
                // What they BOUGHT vs what applies today. A lapsed Growth
                // customer shows "growth → expired", which is the thing you
                // want to see before picking up the phone.
                const drifted = o.plan !== o.effective_plan;
                return (
                  <tr key={o.org_id} style={{ cursor: "default", opacity: o.active ? 1 : 0.55 }}>
                    <td>
                      <div style={{ fontWeight: 600 }}>
                        {o.name}{" "}
                        {!o.active && <span className="pill pill-red">suspended</span>}
                      </div>
                      <div className="sub" style={{ fontSize: 12 }}>
                        {o.slug}{o.industry ? ` · ${o.industry}` : ""} · joined {timeAgo(o.created_at)}
                      </div>
                    </td>
                    <td>
                      <span className={
                        o.effective_plan === "expired" ? "pill pill-red"
                        : o.effective_plan === "free" ? "pill pill-muted" : "pill pill-green"}>
                        {o.effective_plan}
                      </span>
                      {drifted && (
                        <div className="sub" style={{ fontSize: 11, marginTop: 3 }}>
                          bought: {o.plan}
                        </div>
                      )}
                    </td>
                    <td className="sub">{o.members}</td>
                    <td className="sub">{o.records.toLocaleString("en-IN")}</td>
                    <td className="sub" style={{ fontSize: 12 }}>
                      {o.ai_used ?? 0} AI · {o.emails_used ?? 0} email · {o.whatsapp_used ?? 0} WA
                    </td>
                    <td className="sub" style={{ fontSize: 12 }}>
                      {o.period_end
                        ? new Date(o.period_end).toLocaleDateString("en-IN",
                            { day: "numeric", month: "short", year: "numeric" })
                        : "—"}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn btn-sm" onClick={() => setEditing(o)}>Plan</button>
                      <button
                        className={`btn btn-sm${o.active ? " btn-danger" : ""}`}
                        style={{ marginLeft: 6 }}
                        onClick={() => void setActive(o, !o.active)}
                      >
                        {o.active ? "Suspend" : "Restore"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <p className="sub" style={{ marginTop: 12 }}>No organisation matches "{q}".</p>
        )}
      </Card>

      <Card title="Recent admin actions">
        <p className="sub" style={{ marginTop: -8, marginBottom: 10 }}>
          Every cross-tenant change, however it was made. When a customer asks who
          changed their plan and when, this is the answer.
        </p>
        {audit.length === 0 ? (
          <p className="sub">Nothing yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>When</th><th>Who</th><th>What</th><th>Organisation</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {audit.map((a, i) => (
                  <tr key={i} style={{ cursor: "default" }}>
                    <td className="sub" style={{ fontSize: 12 }}>{timeAgo(a.created_at)}</td>
                    <td className="sub" style={{ fontSize: 12 }}>{a.actor_email ?? "—"}</td>
                    <td><span className="pill pill-muted">{a.action}</span></td>
                    <td className="sub" style={{ fontSize: 12 }}>{a.org_slug ?? "—"}</td>
                    <td className="sub mono" style={{ fontSize: 11, maxWidth: 320, overflow: "hidden" }}>
                      {JSON.stringify(a.detail)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Plans">
        <p className="sub" style={{ marginTop: -8, marginBottom: 10 }}>
          What every customer sees on the pricing page and what the server enforces —
          the same rows. Changing a limit here changes both.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Plan</th><th>Price</th><th>Users</th><th>Records</th>
                <th>AI</th><th>Email</th><th>WhatsApp</th><th>Automations</th><th>API</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.plan} style={{ cursor: "default" }}>
                  <td style={{ fontWeight: 600 }}>{p.label}</td>
                  <td>{p.price_inr ? `₹${p.price_inr.toLocaleString("en-IN")}` : "—"}</td>
                  <td className="sub">{p.max_seats ?? "∞"}</td>
                  <td className="sub">{p.max_leads?.toLocaleString("en-IN") ?? "∞"}</td>
                  <td className="sub">{p.max_ai_messages?.toLocaleString("en-IN") ?? "∞"}</td>
                  <td className="sub">{p.max_emails?.toLocaleString("en-IN") ?? "∞"}</td>
                  <td className="sub">
                    {p.whatsapp ? (p.max_whatsapp?.toLocaleString("en-IN") ?? "∞") : "—"}
                  </td>
                  <td className="sub">{p.max_automations ?? "∞"}</td>
                  <td className="sub">{p.api_access ? "✓" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sub" style={{ fontSize: 12, marginTop: 10 }}>
          To change a price or limit, use <code>admin_set_plan_limits</code> in the SQL editor —
          it validates the field names and writes an audit row. Editing these from a form is
          deliberately not offered: a typo in a limit affects every customer on that plan at once.
        </p>
      </Card>

      {editing && (
        <PlanModal
          org={editing}
          plans={plans}
          onClose={() => setEditing(null)}
          onDone={async () => { setEditing(null); await load(); }}
          toast={toast}
        />
      )}
      {toast.node}
    </div>
  );
}

function PlanModal({
  org, plans, onClose, onDone, toast,
}: {
  org: OrgRow;
  plans: PlanRow[];
  onClose: () => void;
  onDone: () => Promise<void>;
  toast: ReturnType<typeof useToast>;
}) {
  const [plan, setPlan] = useState(org.plan);
  const [months, setMonths] = useState(1);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const parking = plan === "free" || plan === "expired";

  const apply = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc("admin_set_plan", {
      p_org_id: org.org_id, p_plan: plan, p_months: parking ? 0 : months,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    const r = data as { period_end?: string };
    toast.show(
      parking
        ? `${org.name} moved to ${plan}`
        : `${org.name} on ${plan} until ${r.period_end
            ? new Date(r.period_end).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
            : "—"}`,
    );
    await onDone();
  };

  return (
    <Modal title={`Plan — ${org.name}`} onClose={onClose}>
      <p className="sub" style={{ marginTop: -6 }}>
        Currently <b>{org.plan}</b>
        {org.effective_plan !== org.plan && <> (applying as <b>{org.effective_plan}</b>)</>}
        {org.period_end && <> · until {new Date(org.period_end).toLocaleDateString("en-IN")}</>}
      </p>

      <div className="field">
        <label className="label">Plan</label>
        <select className="select" value={plan} onChange={(e) => setPlan(e.target.value)}>
          {plans.map((p) => (
            <option key={p.plan} value={p.plan}>
              {p.label}{p.price_inr ? ` — ₹${p.price_inr.toLocaleString("en-IN")}/mo` : ""}
            </option>
          ))}
        </select>
      </div>

      {!parking && (
        <div className="field">
          <label className="label">Add months</label>
          <select className="select" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {[1, 3, 6, 12, 24].map((m) => (
              <option key={m} value={m}>{m} month{m === 1 ? "" : "s"}</option>
            ))}
          </select>
          <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
            Added to whatever they already have, not from today — so extending a live
            subscription cannot accidentally shorten it.
          </p>
        </div>
      )}

      {/* These two used to be described together as "read-only … capture, AI
          and sending stop". That is still exactly right for `expired`, but
          `free` stopped being read-only in
          20260911090000_tenant_agent_defaults.sql — it is now 50 records, 50 AI
          replies and 20 emails. An operator parking an org on free while
          believing it kills their widget will hand out the wrong answer on the
          phone, so the two are described separately. */}
      {parking && (
        <p className="sub" style={{ marginBottom: 12 }}>
          {plan === "free" ? (
            <>
              <b>Free</b> is a small working allowance, not a lock: 50 records, 50 AI replies and
              20 emails, one seat, no automations. Their data stays, they keep signing in, and
              capture and AI keep working up to those numbers. The subscription period is cleared.
            </>
          ) : (
            <>
              <b>Expired</b> is read-only: their data stays and they can still sign in and export,
              but capture, AI and sending stop. The subscription period is cleared.
            </>
          )}
        </p>
      )}

      <div className="field">
        <label className="label">Reason</label>
        <input
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. paid by bank transfer, invoice #1042"
        />
        <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
          Recorded in the audit log. Worth a sentence — in six months this is the only
          explanation of why a plan changed by hand.
        </p>
      </div>

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void apply()}>
          {busy ? "Applying…" : "Apply"}
        </button>
      </div>
    </Modal>
  );
}
