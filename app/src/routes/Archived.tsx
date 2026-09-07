import { useCallback, useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, Empty, LoadError, Spinner, useToast } from "../components/ui";

// Archived records, and the way back.
//
// The soft-delete migration shipped archive_lead / restore_lead /
// archived_leads, granted to `authenticated`, with a 30-day purge job — and
// not one of them had a caller. `deleted_at` appeared nowhere in the frontend.
// So "deletion is recoverable" was true of the database and invisible to the
// person who would need to recover something.
//
// A recovery path nobody can find is not a recovery path. This is that screen.

interface ArchivedRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  deleted_at: string;
  days_left: number;
}

export function Archived({ navigate }: { navigate: (to: string) => void }) {
  const { ui, isAdmin } = useApp();
  const [rows, setRows] = useState<ArchivedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await supabase.rpc("archived_leads");
    if (err) setError(err.message);
    else { setError(null); setRows((data as ArchivedRow[]) ?? []); }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const restore = async (row: ArchivedRow) => {
    setBusy(row.id);
    const { data, error: err } = await supabase.rpc("restore_lead", { p_lead_id: row.id });
    setBusy(null);
    if (err) { toast.error(err.message); return; }
    if (data && (data as { ok?: boolean }).ok === false) {
      toast.error(String((data as { reason?: string }).reason ?? "Could not restore"));
      return;
    }
    toast.show(`${row.name} restored`);
    await load();
  };

  if (loading) return <Spinner />;
  if (error) return <LoadError message={error} onRetry={() => void load()} />;

  return (
    <div className="stack">
      <div>
        <h1>Archived</h1>
        <p className="sub" style={{ marginTop: 2 }}>
          Hidden {ui.leadNounPlural.toLowerCase()}, kept for 30 days and then permanently deleted.
          Restoring brings back the record and its history.
        </p>
      </div>

      {rows.length === 0 ? (
        <Card>
          <Empty
            icon="🗄"
            title="Nothing archived"
            hint={`Archived ${ui.leadNounPlural.toLowerCase()} appear here, with the time left to restore them.`}
          />
        </Card>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{ui.leadNoun}</th><th>Contact</th><th>Archived</th><th>Time left</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ cursor: "default" }}>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td className="sub">{r.email ?? r.phone ?? "—"}</td>
                  <td className="sub">
                    {new Date(r.deleted_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                  </td>
                  <td>
                    {/* Red under a week: this is the only warning anyone gets
                        before the purge job removes the row for good. */}
                    <span className={r.days_left <= 7 ? "pill pill-red" : "pill pill-muted"}>
                      {r.days_left} day{r.days_left === 1 ? "" : "s"}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {isAdmin ? (
                      <button
                        className="btn btn-sm"
                        disabled={busy === r.id}
                        onClick={() => void restore(r)}
                      >
                        {busy === r.id ? "Restoring…" : "Restore"}
                      </button>
                    ) : (
                      <span className="sub" style={{ fontSize: 12 }}>Admins can restore</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate("/leads")}>
          ← Back to {ui.leadNounPlural.toLowerCase()}
        </button>
      </div>
      {toast.node}
    </div>
  );
}
