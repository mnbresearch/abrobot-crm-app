import { useState } from "react";
import { supabase } from "../lib/supabase";

// Magic-link only. No password field by design: passwords are the single
// biggest support and breach surface in a small SaaS, and Supabase's OTP flow
// removes the need to store or reset them.

export function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    const clean = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) { setErr("Enter a valid email address"); return; }
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: clean,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setSent(true);
  };

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="row" style={{ marginBottom: 18 }}>
          <div className="brand-mark">🎓</div>
          <div style={{ fontWeight: 800, fontSize: 17 }}>AbroBot CRM</div>
        </div>

        {sent ? (
          <>
            <h2>Check your email</h2>
            <p className="sub" style={{ marginTop: 7 }}>
              We sent a sign-in link to <b>{email}</b>. It expires in an hour.
            </p>
            <button className="btn" style={{ marginTop: 14 }} onClick={() => setSent(false)}>
              Use a different email
            </button>
          </>
        ) : (
          <>
            <h2>Sign in</h2>
            <p className="sub" style={{ marginTop: 5, marginBottom: 15 }}>
              We'll email you a link — no password to remember.
            </p>
            <div className="field">
              <label className="label">Work email</label>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
                placeholder="you@company.com"
                autoFocus
              />
            </div>
            {err && <p style={{ color: "var(--red)", fontSize: 13 }}>{err}</p>}
            <button className="btn btn-primary" style={{ width: "100%" }} onClick={send} disabled={busy}>
              {busy ? "Sending…" : "Send sign-in link"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
