import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, Empty, Spinner, timeAgo, useToast } from "../components/ui";
import type { MemberStatus, Profile, UserRole } from "../lib/types";

const ROLES: UserRole[] = ["counsellor", "org_admin", "super_admin"];
const STATUSES: MemberStatus[] = ["pending", "active", "disabled"];

interface Invite {
  id: string;
  email: string;
  role: UserRole;
  accepted_at: string | null;
  created_at: string;
}

/**
 * Invites.
 *
 * An admin cannot create someone else's login — only Supabase Auth can. So an
 * invite records intent: when that email signs in, accept_invite() attaches
 * them to this org with the role chosen here. That keeps identity with the
 * auth provider and authorisation with us, which is the right split.
 */
function InviteCard({ onChanged }: { onChanged: () => void }) {
  const { org, profile } = useApp();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("counsellor");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = async () => {
    if (!org) return;
    const { data } = await supabase.from("invites").select("*").eq("org_id", org.id).order("created_at", { ascending: false });
    setInvites((data as Invite[]) ?? []);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [org]);

  const invite = async () => {
    const clean = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) { toast.error("Enter a valid email address"); return; }
    if (!org) return;
    setBusy(true);
    const { error } = await supabase.from("invites").upsert(
      { org_id: org.id, email: clean, role, invited_by: profile?.id ?? null, accepted_at: null },
      { onConflict: "org_id,email" },
    );
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setEmail("");
    await load();
    onChanged();
    toast.show("Invite created");
  };

  const revoke = async (id: string) => {
    const { error } = await supabase.from("invites").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    await load();
    toast.show("Invite revoked");
  };

  const pending = invites.filter((i) => !i.accepted_at);

  return (
    <>
      <Card title="Invite a teammate">
        <div className="row row-wrap" style={{ marginBottom: 6 }}>
          <input
            className="input"
            style={{ maxWidth: 300 }}
            type="email"
            placeholder="colleague@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void invite(); }}
          />
          <select className="select" style={{ maxWidth: 170 }} value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            <option value="counsellor">Counsellor</option>
            <option value="org_admin">Admin</option>
          </select>
          <button className={`btn btn-primary${busy ? " btn-busy" : ""}`} onClick={invite} disabled={busy}>
            {busy ? "Inviting…" : "Send invite"}
          </button>
        </div>

        <p className="sub" style={{ fontSize: 12.5, marginTop: 10 }}>
          They sign in at <b>{window.location.host}</b> with this exact email and join automatically —
          no admin step afterwards. Send them the link yourself; we don't email it for you yet.
        </p>

        {pending.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="label">Waiting to join</div>
            {pending.map((i) => (
              <div key={i.id} className="row" style={{ justifyContent: "space-between", padding: "7px 0", borderTop: "1px solid var(--border)" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{i.email}</div>
                  <div className="sub" style={{ fontSize: 12 }}>as {i.role.replace("_", " ")} · {timeAgo(i.created_at)}</div>
                </div>
                <button className="btn btn-sm btn-danger" onClick={() => void revoke(i.id)}>Revoke</button>
              </div>
            ))}
          </div>
        )}
      </Card>
      {toast.node}
    </>
  );
}

export function Team() {
  const { org, profile, isAdmin } = useApp();
  const [members, setMembers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  const load = async () => {
    if (!org) return;
    const { data } = await supabase.from("profiles").select("*").eq("org_id", org.id).order("created_at");
    setMembers((data as Profile[]) ?? []);
    setLoading(false);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [org]);

  const update = async (id: string, patch: Partial<Profile>) => {
    const { error } = await supabase.from("profiles").update(patch).eq("id", id);
    if (error) { toast.error(error.message); return; }
    await load();
    toast.show("Updated");
  };

  if (loading) return <Spinner />;

  return (
    <div className="stack">
      <div>
        <h1>Team</h1>
        <p className="sub" style={{ marginTop: 2 }}>
          {members.length} {members.length === 1 ? "member" : "members"}
        </p>
      </div>

      {!isAdmin && (
        <Card>
          <p className="sub">You can see your team here. Only admins can change roles or access.</p>
        </Card>
      )}

      {members.length === 0 ? (
        <Card><Empty icon="👥" title="No members yet" /></Card>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Member</th><th>Role</th><th>Status</th><th>Joined</th></tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isMe = m.id === profile?.id;
                return (
                  <tr key={m.id} style={{ cursor: "default" }}>
                    <td>
                      <div style={{ fontWeight: 600 }}>
                        {m.full_name || "—"} {isMe && <span className="pill pill-muted">you</span>}
                      </div>
                      <div className="sub" style={{ fontSize: 12 }}>{m.email}</div>
                    </td>
                    <td>
                      {isAdmin && !isMe ? (
                        <select
                          className="select"
                          style={{ maxWidth: 160 }}
                          value={m.role}
                          onChange={(e) => void update(m.id, { role: e.target.value as UserRole })}
                        >
                          {ROLES.map((r) => <option key={r} value={r}>{r.replace("_", " ")}</option>)}
                        </select>
                      ) : (
                        <span className="pill">{m.role.replace("_", " ")}</span>
                      )}
                    </td>
                    <td>
                      {isAdmin && !isMe ? (
                        <select
                          className="select"
                          style={{ maxWidth: 140 }}
                          value={m.status}
                          onChange={(e) => void update(m.id, { status: e.target.value as MemberStatus })}
                        >
                          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : (
                        <span className={m.status === "active" ? "pill pill-green" : m.status === "disabled" ? "pill pill-red" : "pill pill-muted"}>
                          {m.status}
                        </span>
                      )}
                    </td>
                    <td className="sub">{timeAgo(m.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {isAdmin && <InviteCard onChanged={load} />}
      {toast.node}
    </div>
  );
}
