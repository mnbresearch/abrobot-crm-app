import { useCallback, useEffect, useState } from "react";
import { supabase, callFunction } from "../lib/supabase";
import { Card, Empty, Spinner, timeAgo, useToast } from "../components/ui";

/**
 * Platform screen additions (super admin only, rendered from Admin.tsx):
 *
 *   ProductAnalyticsCard  — the signup → onboarding → checkout → paid funnel,
 *                           activation, payments and API usage, from
 *                           analytics_overview() (20261013100000).
 *   CheckoutRecoveryCard  — abandoned-checkout reminders: settings, a dry run,
 *                           a test send, and the send log (20261013110000 and
 *                           the checkout-recovery function).
 *
 * Both say plainly when their migration has not been applied, rather than
 * showing zeros that look like measurements.
 */

interface Overview {
  days: number;
  client_events_since: string | null;
  funnel: { step: string; count: number; basis: string }[];
  activation: { new_workspaces: number; with_a_record: number; with_a_second_member: number; users_signed_in_in_period: number };
  payments: { started: number; paid: number; failed: number; dropped: number; pending: number; refunded: number; revenue_inr: number; abandoned: number };
  api: { active_keys: number; orgs_with_keys: number; keys_used_in_period: number; total_calls: number };
  top_events: { event: string; source: string; count: number }[];
  top_features: { route: string; users: number; views: number }[];
}

const notApplied = (msg: string) => /could not find the function|does not exist|PGRST202|42P01|42883/i.test(msg);

function pct(n: number, d: number) {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : "—";
}

export function ProductAnalyticsCard() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: d, error } = await supabase.rpc("analytics_overview", { p_days: days });
    setLoading(false);
    if (error) { setErr(error.message); setData(null); return; }
    setErr(null);
    setData(d as Overview);
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  return (
    <Card
      title="Product analytics"
      action={
        <div className="row" style={{ gap: 6 }}>
          {[7, 30, 90].map((d) => (
            <button key={d} className={`btn btn-sm${days === d ? " btn-primary" : ""}`} onClick={() => setDays(d)}>{d} days</button>
          ))}
        </div>
      }
    >
      {loading && !data ? <Spinner /> : err ? (
        <p className="sub">
          {notApplied(err)
            ? "Not set up yet — apply supabase/migrations/20261013100000_product_analytics.sql."
            : `Couldn't load analytics: ${err}`}
        </p>
      ) : data && (
        <>
          <p className="sub" style={{ marginTop: -8, fontSize: 12.5 }}>
            First-party only. Workspace, onboarding and payment steps are counted from the database tables
            themselves, so they include history. Browser steps (visits, sign-in links) only exist since{" "}
            {data.client_events_since ? new Date(data.client_events_since).toLocaleDateString() : "— none recorded yet"}.
            Visitors with Do Not Track or Global Privacy Control on are not counted.
          </p>

          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="data">
              <thead><tr><th>Step</th><th>Count</th><th>From previous</th><th>Counted from</th></tr></thead>
              <tbody>
                {data.funnel.map((f, i) => (
                  <tr key={f.step}>
                    <td style={{ fontWeight: 600 }}>{f.step}</td>
                    <td className="mono">{f.count}</td>
                    <td className="sub">{i === 0 ? "" : pct(f.count, data.funnel[i - 1].count)}</td>
                    <td className="sub" style={{ fontSize: 12 }}>{f.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-2" style={{ marginTop: 14, gap: 14 }}>
            <div>
              <h3 style={{ fontSize: 14 }}>Activation</h3>
              <p className="sub" style={{ fontSize: 13 }}>
                {data.activation.new_workspaces} new workspaces · {data.activation.with_a_record} with a record ·{" "}
                {data.activation.with_a_second_member} with a teammate · {data.activation.users_signed_in_in_period} users signed in
              </p>
              <h3 style={{ fontSize: 14, marginTop: 10 }}>Payments</h3>
              <p className="sub" style={{ fontSize: 13 }}>
                {data.payments.started} checkouts · {data.payments.paid} paid (₹{Number(data.payments.revenue_inr).toLocaleString("en-IN")}) ·{" "}
                {data.payments.failed} failed · {data.payments.dropped} dropped · {data.payments.pending} never finished ·{" "}
                {data.payments.refunded} refunded · <b>{data.payments.abandoned} abandoned</b>
              </p>
              <h3 style={{ fontSize: 14, marginTop: 10 }}>API</h3>
              <p className="sub" style={{ fontSize: 13 }}>
                {data.api.active_keys} active keys in {data.api.orgs_with_keys} workspaces · {data.api.keys_used_in_period} used in period ·{" "}
                {Number(data.api.total_calls).toLocaleString("en-IN")} calls all-time
              </p>
            </div>
            <div>
              <h3 style={{ fontSize: 14 }}>Most-used screens</h3>
              {data.top_features.length === 0
                ? <p className="sub" style={{ fontSize: 13 }}>No screen views recorded yet.</p>
                : data.top_features.slice(0, 8).map((f) => (
                    <div key={f.route} className="row" style={{ fontSize: 13, padding: "2px 0" }}>
                      <code>{f.route}</code><div className="spacer" />
                      <span className="sub">{f.users} users · {f.views} views</span>
                    </div>
                  ))}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

interface RecoverySettings {
  enabled: boolean; dry_run: boolean; first_delay_minutes: number;
  repeat_after_hours: number; max_attempts: number; test_recipient: string | null; updated_at: string;
}
interface Followup {
  id: string; recipient_email: string; attempt: number; mode: string; status: string;
  error: string | null; created_at: string;
}
interface DryRun { would_send: number; candidates: { org: string; plan: string; email: string; started_at: string; attempt: number }[] }

export function CheckoutRecoveryCard() {
  const toast = useToast();
  const [s, setS] = useState<RecoverySettings | null>(null);
  const [log, setLog] = useState<Followup[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dry, setDry] = useState<DryRun | null>(null);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.from("checkout_recovery_settings").select("*").eq("id", true).maybeSingle(),
      supabase.from("checkout_followups").select("id, recipient_email, attempt, mode, status, error, created_at")
        .order("created_at", { ascending: false }).limit(20),
    ]);
    if (a.error) { setErr(a.error.message); return; }
    setErr(null);
    setS(a.data as RecoverySettings);
    setLog(b.error ? [] : ((b.data as Followup[]) ?? []));
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (patch: Partial<RecoverySettings>) => {
    if (!s) return;
    setBusy("save");
    // .select() so an RLS refusal (204, no error) is not reported as saved.
    const { data, error } = await supabase.from("checkout_recovery_settings")
      .update(patch).eq("id", true).select("id");
    setBusy(null);
    if (error) { toast.error(error.message); return; }
    if (!data?.length) { toast.error("Not saved — only a platform admin can change this."); return; }
    toast.show("Saved");
    await load();
  };

  const run = async (mode: "dry_run" | "test") => {
    setBusy(mode);
    try {
      const r = await callFunction<DryRun & { to?: string }>("checkout-recovery", { mode });
      if (mode === "dry_run") { setDry(r); toast.show(`${r.would_send} would be emailed — nothing was sent`); }
      else toast.show(`Test email sent to ${r.to}`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBusy(null);
  };

  if (err) {
    return (
      <Card title="Abandoned-checkout reminders">
        <p className="sub">
          {notApplied(err)
            ? "Not set up yet — apply supabase/migrations/20261013110000_checkout_recovery.sql and deploy the checkout-recovery function."
            : `Couldn't load: ${err}`}
        </p>
      </Card>
    );
  }
  if (!s) return <Card title="Abandoned-checkout reminders"><Spinner /></Card>;

  return (
    <Card title="Abandoned-checkout reminders">
      {toast.node}
      <p className="sub" style={{ marginTop: -8, fontSize: 12.5 }}>
        Emails the admin who started an upgrade but didn't finish paying. Decided from the payments table (written only by
        the verified Cashfree webhook), never from a browser redirect. Skips anyone who has since paid, is already on that
        plan or higher, unsubscribed, or got any reminder in the last 20 hours. Each email carries a one-click opt-out.
      </p>

      <div className="row row-wrap" style={{ gap: 14, marginTop: 12 }}>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={s.enabled} disabled={busy !== null}
            onChange={(e) => void save({ enabled: e.target.checked })} />
          <span>Enabled</span>
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={s.dry_run} disabled={busy !== null}
            onChange={(e) => void save({ dry_run: e.target.checked })} />
          <span>Dry run (log only, send nothing)</span>
        </label>
        <span className={`pill ${s.enabled && !s.dry_run ? "pill-green" : "pill-muted"}`}>
          {!s.enabled ? "off" : s.dry_run ? "dry run" : "live"}
        </span>
      </div>

      <div className="row row-wrap" style={{ gap: 10, marginTop: 10, fontSize: 13 }}>
        <label>First reminder after{" "}
          <select className="input" style={{ width: 110, display: "inline-block" }} value={s.first_delay_minutes}
            onChange={(e) => void save({ first_delay_minutes: Number(e.target.value) })}>
            <option value={60}>1 hour</option><option value={120}>2 hours</option>
            <option value={360}>6 hours</option><option value={1440}>24 hours</option>
          </select>
        </label>
        <label>Second after{" "}
          <select className="input" style={{ width: 110, display: "inline-block" }} value={s.repeat_after_hours}
            onChange={(e) => void save({ repeat_after_hours: Number(e.target.value) })}>
            <option value={24}>1 day</option><option value={48}>2 days</option><option value={72}>3 days</option>
          </select>
        </label>
        <label>At most{" "}
          <select className="input" style={{ width: 80, display: "inline-block" }} value={s.max_attempts}
            onChange={(e) => void save({ max_attempts: Number(e.target.value) })}>
            <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
          </select>{" "}emails
        </label>
      </div>

      <div className="row row-wrap" style={{ gap: 8, marginTop: 12 }}>
        <input className="input" style={{ maxWidth: 260 }} type="email" placeholder="Test recipient (your own address)"
          defaultValue={s.test_recipient ?? ""}
          onBlur={(e) => {
            const v = e.target.value.trim().toLowerCase();
            if (v !== (s.test_recipient ?? "")) void save({ test_recipient: v || null });
          }} />
        <button className="btn btn-sm" disabled={busy !== null || !s.test_recipient} onClick={() => void run("test")}>
          {busy === "test" ? "Sending…" : "Send test (sample data)"}
        </button>
        <button className="btn btn-sm" disabled={busy !== null} onClick={() => void run("dry_run")}>
          {busy === "dry_run" ? "Checking…" : "Dry run now"}
        </button>
      </div>

      {dry && (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ fontSize: 14 }}>Would email {dry.would_send} now</h3>
          {dry.candidates.map((c) => (
            <div key={c.email + c.started_at} className="sub" style={{ fontSize: 12.5 }}>
              {c.org} · {c.plan} · {c.email} · started {timeAgo(c.started_at)} · reminder {c.attempt}
            </div>
          ))}
        </div>
      )}

      <h3 style={{ fontSize: 14, marginTop: 14 }}>Recent</h3>
      {log.length === 0 ? (
        <Empty icon="✉️" title="Nothing sent or logged yet" />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>When</th><th>To</th><th>#</th><th>Mode</th><th>Status</th></tr></thead>
            <tbody>
              {log.map((f) => (
                <tr key={f.id}>
                  <td className="sub">{timeAgo(f.created_at)}</td>
                  <td>{f.recipient_email}</td>
                  <td>{f.attempt}</td>
                  <td className="sub">{f.mode === "dry_run" ? "dry run" : f.mode}</td>
                  <td>
                    <span className={`pill ${f.status === "sent" ? "pill-green" : f.status === "failed" ? "pill-red" : "pill-muted"}`}
                      title={f.error ?? undefined}>{f.status === "would_send" ? "would send" : f.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
