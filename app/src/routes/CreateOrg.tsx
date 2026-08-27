import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { getIndustry } from "../lib/industries";
import { useToast } from "../components/ui";

// Self-serve signup.
//
// Shown when a signed-in user has no organisation. Two paths converge here:
// someone who was invited (claimed automatically), and someone starting fresh.
//
// Industry is chosen HERE rather than in a later step, because it decides the
// pipeline, fields, terminology and AI persona. Asking first means the CRM is
// already shaped like their business the first time they see it — no empty
// shell to configure.

export function CreateOrg({ onDone }: { onDone: () => void }) {
  const { industries, refresh, signOut, profile } = useApp();
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkingInvite, setCheckingInvite] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

  // An invited teammate should never see the "create an organisation" form —
  // they'd end up with their own empty org instead of joining their team.
  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase.rpc("accept_invite");
      if (!error && data?.ok) {
        await refresh();
        onDone();
        return;
      }
      setCheckingInvite(false);
    })();
  }, [refresh, onDone]);

  const create = async () => {
    if (!name.trim()) { setErr("What's your business called?"); return; }
    if (!industry) { setErr("Pick the closest industry — you can change it later"); return; }
    setBusy(true);
    setErr(null);

    const { data, error } = await supabase.rpc("create_organisation", {
      p_name: name.trim(),
      p_industry: industry,
    });

    setBusy(false);
    if (error) { setErr(error.message); return; }
    if (data && data.ok === false) { setErr(String(data.reason ?? "Could not create")); return; }

    await refresh();
    toast.show("Workspace ready");
    onDone();
  };

  if (checkingInvite) {
    return (
      <div className="center">
        <div className="spin" />
      </div>
    );
  }

  const preview = industry ? getIndustry(industry) : null;

  return (
    <div style={{ maxWidth: 940, margin: "0 auto", padding: "44px 20px" }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{ fontSize: 40 }}>🚀</div>
        <h1 style={{ marginTop: 10 }}>Set up your workspace</h1>
        <p className="sub" style={{ marginTop: 7, fontSize: 15 }}>
          Two questions, then your CRM is ready — pipeline, fields and AI assistant included.
        </p>
      </div>

      <div className="card" style={{ maxWidth: 520, margin: "0 auto 22px" }}>
        <label className="label">What's your business called?</label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sunrise Dental"
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter" && industry) void create(); }}
        />
        <p className="sub" style={{ fontSize: 12, marginTop: 6 }}>
          Signed in as {profile?.email}
        </p>
      </div>

      <h2 style={{ textAlign: "center", marginBottom: 14 }}>What kind of business is it?</h2>

      <div className="pick-grid">
        {industries.map((ind) => {
          const ui = getIndustry(ind.slug);
          const on = industry === ind.slug;
          return (
            <button
              key={ind.slug}
              className={`pick${on ? " selected" : ""}`}
              onClick={() => setIndustry(ind.slug)}
              style={on && ui.accent ? { borderColor: ui.accent, boxShadow: `0 0 0 4px ${ui.accentSoft ?? "var(--brand-light)"}` } : undefined}
            >
              <div className="pick-icon">{ind.icon ?? ui.icon}</div>
              <div className="pick-name">{ind.name}</div>
              <div className="pick-tag">{ind.tagline}</div>
              <div className="sub" style={{ marginTop: 8, fontSize: 12 }}>
                Tracks <b>{ind.lead_noun_plural}</b>
              </div>
            </button>
          );
        })}
      </div>

      {preview && (
        <div className="card" style={{ marginTop: 22 }}>
          <div className="card-title"><h2>{preview.icon} You'll start with</h2></div>
          <div className="grid grid-2">
            <div>
              <div className="label">Dashboard</div>
              <div className="row-wrap">
                {preview.kpis.map((k) => <span key={k.key} className="pill">{k.icon} {k.label}</span>)}
              </div>
            </div>
            <div>
              <div className="label">Quick actions</div>
              <div className="row-wrap">
                {preview.quickActions.map((a) => (
                  <span key={a.key} className="pill pill-muted">{a.icon} {a.label}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {err && (
        <p style={{ color: "var(--red)", textAlign: "center", marginTop: 16, fontWeight: 600 }}>{err}</p>
      )}

      <div className="row" style={{ justifyContent: "center", marginTop: 22, gap: 12 }}>
        <button
          className={`btn btn-primary${busy ? " btn-busy" : ""}`}
          disabled={busy || !name.trim() || !industry}
          onClick={create}
          style={{ minWidth: 230 }}
        >
          {busy ? "Setting up…" : "Create my workspace →"}
        </button>
      </div>

      <p className="sub" style={{ textAlign: "center", marginTop: 18, fontSize: 12.5 }}>
        Starts a 7-day free trial. No card needed.{" "}
        <button className="btn btn-ghost btn-sm" onClick={signOut}>Sign out</button>
      </p>
      {toast.node}
    </div>
  );
}
