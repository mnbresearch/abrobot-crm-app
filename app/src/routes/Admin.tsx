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

/**
 * A member row as this screen needs it.
 *
 * Deliberately not the app's `Profile` type: this is a cross-tenant read and
 * only the five columns below are ever shown, so widening it would be widening
 * what the platform console pulls out of another company's user table.
 */
interface MemberRow {
  id: string;
  full_name: string | null;
  email: string;
  role: string;
  status: string;
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
  // The plan and audit reads had their errors discarded, which on THIS screen
  // produces two specific falsehoods:
  //
  //  - plan_limits failing left `plans` empty, so every price lookup missed and
  //    the header printed "₹0/mo" beside a list of real paying customers, while
  //    the Plans table rendered as no rows under copy saying these are the rows
  //    the server enforces.
  //  - admin_recent_actions failing printed "Nothing yet." directly under
  //    "Every cross-tenant change, however it was made." — an audit log
  //    claiming, wrongly, that nothing has happened.
  const [plansError, setPlansError] = useState<string | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [editing, setEditing] = useState<OrgRow | null>(null);
  // admin_set_member's UI. Kept here rather than on the tenant-facing Team
  // screen on purpose — see the comment above MemberModal.
  const [members, setMembers] = useState<OrgRow | null>(null);
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
    // Context reads don't block the screen, but their failure is still reported
    // in the card that would otherwise assert something false about them.
    if (p.error) setPlansError(p.error.message);
    else { setPlansError(null); setPlans((p.data as PlanRow[]) ?? []); }
    if (a.error) setAuditError(a.error.message);
    else { setAuditError(null); setAudit((a.data as AuditRow[]) ?? []); }
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
  // Every term in that sum comes from `plans`. With no plan rows the sum is
  // structurally zero, not measured zero — and "₹0/mo" printed next to "7
  // paying" is worse than printing nothing, because it looks like a reading.
  const mrrKnown = plans.length > 0;

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1>Platform admin</h1>
          <p className="sub" style={{ marginTop: 2 }}>
            {orgs.length} organisation{orgs.length === 1 ? "" : "s"} · {paying.length} paying
            {mrrKnown
              ? ` · ₹${mrr.toLocaleString("en-IN")}/mo from listed plans`
              : " · plan prices unavailable, so no MRR figure"}
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
                      <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => setMembers(o)}>
                        Members
                      </button>
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
        {/* Error before empty. An audit log that says "Nothing yet." when it
            simply could not be read is the one thing a log must never do — the
            sentence above promises it records everything. */}
        {auditError ? (
          <LoadError message={auditError} onRetry={() => void load()} />
        ) : audit.length === 0 ? (
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
        {/* An empty table under that sentence reads as "the server enforces no
            limits at all". It also silently empties the plan picker in the Plan
            modal and zeroes the MRR line in the header, so the failure is named
            once, here, where the data belongs. */}
        {plansError ? (
          <>
            <LoadError message={plansError} onRetry={() => void load()} />
            <p className="sub" style={{ fontSize: 12.5, marginTop: 8 }}>
              Plan rows couldn't be read, so the table is not empty — it is unknown. The MRR
              figure is withheld above for the same reason, and the plan picker in{" "}
              <b>Plan</b> will have nothing to choose from until this read succeeds.
            </p>
          </>
        ) : (
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
        )}
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
      {members && (
        <MemberModal
          org={members}
          onClose={() => setMembers(null)}
          onDone={async () => { setMembers(null); await load(); }}
          toast={toast}
        />
      )}
      {toast.node}
    </div>
  );
}

/**
 * admin_set_member — change a member's role or status in ANY organisation.
 *
 * ── Why this is here and not on Team.tsx ────────────────────────────────────
 * Team.tsx already lets an org admin change roles and statuses inside their own
 * organisation, through a plain `profiles` UPDATE that RLS and
 * trg_guard_profile_changes both police. admin_set_member is a different
 * animal: it is `security definer`, it checks is_super_admin() rather than
 * anything about the target org, and it deliberately sets
 * app.profile_bootstrap so the guard trigger stands aside. It exists for the
 * case Team.tsx structurally cannot serve — "the only admin left the company",
 * where there is nobody left inside the tenant who can promote anyone.
 *
 * Putting it on the tenant-facing screen would give a tenant admin a button
 * that is either useless (the function refuses them) or, if the platform owner
 * happens to be looking at that screen, a cross-tenant write hiding in the
 * middle of an ordinary team list. It belongs in the console whose entire
 * premise is "this reaches across every organisation".
 *
 * ── What is deliberately NOT offered ────────────────────────────────────────
 * Granting super_admin. The function would accept it — the role enum has three
 * values and it casts whatever it is given — but a platform role handed out
 * from a dropdown, against a list of other companies' staff, is a mistake with
 * no natural blast radius. Doing it is rare enough to be worth an explicit
 * SQL statement and a moment's thought.
 */
function MemberModal({
  org, onClose, onDone, toast,
}: {
  org: OrgRow;
  onClose: () => void;
  onDone: () => Promise<void>;
  toast: ReturnType<typeof useToast>;
}) {
  const [rows, setRows] = useState<MemberRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [role, setRole] = useState("");     // "" = leave unchanged
  const [status, setStatus] = useState(""); // "" = leave unchanged
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void supabase.from("profiles")
      .select("id, full_name, email, role, status")
      .eq("org_id", org.org_id)
      .order("created_at")
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) { setListError(error.message); setRows([]); return; }
        setListError(null);
        setRows((data as MemberRow[]) ?? []);
      });
    return () => { cancelled = true; };
  }, [org.org_id]);

  // admin_list_orgs counts ACTIVE members server-side, so a disagreement
  // between that count and what came back here is meaningful: the profiles
  // policies are not written in any migration in this repo, and nothing
  // guarantees they expose another tenant's rows to a super admin. An empty
  // list next to "4 members" is a failed read, not an empty organisation, and
  // saying so is the difference between "this org has nobody" and "paste the
  // user id you already have".
  const listLooksIncomplete = rows !== null && rows.length === 0 && org.members > 0;
  const selected = rows?.find((r) => r.id === id) ?? null;

  const apply = async () => {
    const target = id.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
      toast.error("Pick a member, or paste their user id (a uuid).");
      return;
    }
    if (!role && !status) { toast.error("Choose a new role or a new status — otherwise there is nothing to change."); return; }
    if (!note.trim()) { toast.error("Give a reason. This is a cross-tenant change and the audit row is the only explanation that will exist."); return; }

    setBusy(true);
    const { data, error } = await supabase.rpc("admin_set_member", {
      p_profile_id: target,
      // null means "leave alone" — the function coalesces each one against the
      // current value, so sending "" would try to cast an empty string to the
      // role enum and fail.
      p_role: role || null,
      p_status: status || null,
      p_note: note.trim(),
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    const r = data as { role?: string; status?: string } | null;
    toast.show(
      `${selected?.email ?? target} is now ${r?.role ?? (role || "unchanged")} · ${r?.status ?? (status || "unchanged")}`,
    );
    await onDone();
  };

  return (
    <Modal title={`Members — ${org.name}`} onClose={onClose} wide>
      <p className="sub" style={{ marginTop: -6, lineHeight: 1.8 }}>
        The recovery path for an organisation that has locked itself out — most often because
        its only admin left. Every change here is written to the audit log with your email
        against it.
      </p>

      {rows === null ? (
        <p className="sub" style={{ marginTop: 12 }}>Loading members…</p>
      ) : (
        <>
          {listError && (
            <p style={{ color: "var(--red)", fontSize: 13, marginTop: 10, lineHeight: 1.8 }}>
              Couldn't read this organisation's members: {listError}. You can still act on
              someone by pasting their user id below.
            </p>
          )}
          {listLooksIncomplete && !listError && (
            <p style={{ color: "var(--amber)", fontSize: 13, marginTop: 10, lineHeight: 1.8 }}>
              No member rows came back, but this organisation is counted as having{" "}
              {org.members} active {org.members === 1 ? "member" : "members"} — so this list is
              unavailable rather than empty. Paste the user id below instead; the change itself
              does not depend on this read.
            </p>
          )}

          {rows.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="data">
                <thead><tr><th /><th>Member</th><th>Role</th><th>Status</th></tr></thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id} style={{ cursor: "pointer" }} onClick={() => setId(m.id)}>
                      <td>
                        <input
                          type="radio"
                          name="admin-member"
                          checked={id === m.id}
                          onChange={() => setId(m.id)}
                          aria-label={`Select ${m.email}`}
                        />
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{m.full_name || "—"}</div>
                        <div className="sub" style={{ fontSize: 12 }}>{m.email}</div>
                      </td>
                      <td><span className="pill pill-muted">{m.role.replace("_", " ")}</span></td>
                      <td>
                        <span className={m.status === "active" ? "pill pill-green" : m.status === "disabled" ? "pill pill-red" : "pill pill-muted"}>
                          {m.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="field" style={{ marginTop: 14 }}>
        <label className="label" htmlFor="admin-member-id">User id</label>
        <input
          id="admin-member-id"
          className="input mono"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
        />
        <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
          Filled in by picking a row above. It is editable because the list is the part that can
          fail, and the action should not depend on it.
        </p>
      </div>

      <div className="row row-wrap" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1, minWidth: 180 }}>
          <label className="label" htmlFor="admin-member-role">New role</label>
          <select id="admin-member-role" className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">Leave unchanged</option>
            <option value="counsellor">counsellor</option>
            <option value="org_admin">org admin</option>
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 180 }}>
          <label className="label" htmlFor="admin-member-status">New status</label>
          <select id="admin-member-status" className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Leave unchanged</option>
            <option value="pending">pending</option>
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </select>
        </div>
      </div>

      <p className="sub" style={{ fontSize: 12, marginTop: -4, marginBottom: 12, lineHeight: 1.8 }}>
        <b>super_admin is not offered here.</b> It is a platform role, not a tenant one, and
        granting it hands someone read and write on every organisation — rare enough to be worth
        a deliberate SQL statement rather than a dropdown. Promoting someone to <b>org admin</b>{" "}
        is what unlocks a tenant that has lost its last admin. Note that the plan's seat limit is
        not consulted by this function, so reactivating a member can put an organisation over its
        seat count.
      </p>

      <div className="field">
        <label className="label" htmlFor="admin-member-note">Reason</label>
        <input
          id="admin-member-note"
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. sole admin left, promoting M. Rao on the owner's written request"
        />
        <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
          Required. In six months this audit row is the only record of why someone else's
          permissions were changed from outside their company.
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
