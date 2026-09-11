import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, Empty, Spinner, timeAgo, useToast } from "../components/ui";
import type { MemberStatus, Profile, UserRole } from "../lib/types";

// super_admin is a PLATFORM role, not a tenant one. Offering it in this
// dropdown invited an org admin to promote their own user to it. Whether
// or not RLS refuses the write, it should never be selectable here.
const ROLES: UserRole[] = ["counsellor", "org_admin"];
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
  const { org, profile, plan } = useApp();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("counsellor");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = async () => {
    if (!org) return;
    const { data, error } = await supabase.from("invites").select("*").eq("org_id", org.id).order("created_at", { ascending: false });
    // An unread error rendered no "Waiting to join" list — which reads as "that
    // invite was never created" and invites the admin to send it a second time,
    // or to conclude the invite system is broken and chase the person manually.
    if (error) { toast.error(`Could not load pending invites: ${error.message}`); return; }
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
    // Says what actually happened. "Invite created" left people expecting an
    // email to have gone out.
    toast.show(`Invite created for ${clean} — send them the link yourself`);
  };

  const revoke = async (id: string) => {
    const { error } = await supabase.from("invites").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    await load();
    toast.show("Invite revoked");
  };

  const pending = invites.filter((i) => !i.accepted_at);

  // Seat awareness. `max_seats` is enforced server-side at SIGN-IN, not at
  // invite time — so on free (max_seats = 1) every invite "succeeded", the
  // admin told their colleague they were in, and the colleague was refused
  // when they tried to log in. The admin heard about it from the colleague.
  // The arithmetic is: seats already taken, plus everyone still to accept.
  const seatsLimit = plan?.seatsLimit ?? null;
  const seatsUsed = plan?.seatsUsed ?? 0;
  const committed = seatsUsed + pending.length;
  const seatsFull = seatsLimit !== null && committed >= seatsLimit;

  return (
    <>
      <Card title="Invite a teammate">
        {seatsLimit !== null && (
          <div
            className="card"
            style={{
              marginBottom: 14, padding: 12, background: "var(--bg)",
              borderColor: seatsFull ? "var(--amber)" : "var(--border)",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 13 }}>
              {seatsFull ? "⚠️ No seats left on your plan" : `${committed} of ${seatsLimit} seats used`}
            </div>
            <p className="sub" style={{ fontSize: 12.5, marginTop: 3 }}>
              {seatsFull
                ? `Your ${plan?.effective ?? "current"} plan allows ${seatsLimit} ${seatsLimit === 1 ? "person" : "people"}, and you have ${seatsUsed} active${pending.length ? ` plus ${pending.length} waiting to join` : ""}. You can still create an invite, but whoever you send it to will be turned away at sign-in until you upgrade — so tell them, or upgrade first.`
                : `Active members and pending invites both count. ${seatsLimit - committed} left.`}
            </p>
          </div>
        )}

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
          {/* "Send invite" was a straight untruth: nothing is sent. No email,
              no SMS, no notification — the button writes a row that waits for
              that address to sign in, and the small print two lines below
              admitted as much. An admin who reads the button and not the small
              print waits for a colleague who was never contacted. */}
          <button className={`btn btn-primary${busy ? " btn-busy" : ""}`} onClick={invite} disabled={busy}>
            {busy ? "Creating…" : "Create invite"}
          </button>
        </div>

        <p className="sub" style={{ fontSize: 12.5, marginTop: 10 }}>
          <b>No email is sent — you need to tell them yourself.</b> This reserves their place.
          Ask them to sign in at <b>{window.location.host}</b> using this exact address and they
          join automatically, with no further step from you.
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
    // Returning here without clearing `loading` left the spinner up forever,
    // because `load` only re-runs when `org` changes and `org` is what is
    // missing. Same shape as the bug in useLeads.
    if (!org) { setLoading(false); return; }
    const { data, error } = await supabase.from("profiles").select("*").eq("org_id", org.id).order("created_at");
    // An unread error rendered "No members yet" to an organisation that has a
    // team — and the obvious response to that screen is to re-invite people
    // who are already there.
    if (error) toast.error(`Could not load your team: ${error.message}`);
    else setMembers((data as Profile[]) ?? []);
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
