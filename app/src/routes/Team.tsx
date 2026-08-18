import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, Empty, Spinner, timeAgo, useToast } from "../components/ui";
import type { MemberStatus, Profile, UserRole } from "../lib/types";

const ROLES: UserRole[] = ["counsellor", "org_admin", "super_admin"];
const STATUSES: MemberStatus[] = ["pending", "active", "disabled"];

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
        <p className="sub" style={{ marginTop: 2 }}>{members.length} members</p>
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

      {isAdmin && (
        <Card title="Adding people">
          <p className="sub" style={{ marginTop: -8 }}>
            A new member signs in with their email on the login screen, which creates their account. Their
            profile then appears here as <b>pending</b> — set the role and switch them to <b>active</b> to
            grant access.
          </p>
          <p className="sub" style={{ marginTop: 10, fontSize: 12 }}>
            ⚠️ Before you activate your first <b>counsellor</b>, close the <code>agent_config</code> credential
            gap documented in RECOVERED-SCHEMA.md — active members can currently read the org's API keys.
          </p>
        </Card>
      )}
      {toast.node}
    </div>
  );
}
