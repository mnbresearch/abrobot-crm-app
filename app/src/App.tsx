import { useApp } from "./lib/store";
import { match, useRoute } from "./lib/router";
import { Spinner } from "./components/ui";
import { Login } from "./routes/Login";
import { Onboarding } from "./routes/Onboarding";
import { Dashboard } from "./routes/Dashboard";
import { Leads } from "./routes/Leads";
import { LeadDetail } from "./routes/LeadDetail";
import { Pipeline } from "./routes/Pipeline";
import { Settings } from "./routes/Settings";

// Routes deliberately mirror the legacy app's URLs so both frontends can serve
// the same links during the takeover.
const NAV = [
  { path: "/", label: "Dashboard", icon: "📊" },
  { path: "/leads", label: null, icon: "👥" },   // label comes from the industry
  { path: "/pipeline", label: "Pipeline", icon: "🔀" },
  { path: "/settings", label: "Settings", icon: "⚙️", adminOnly: true },
];

export default function App() {
  const { loading, session, profile, org, ui, isAdmin, needsOnboarding, signOut, refresh } = useApp();
  const { path, navigate } = useRoute();

  if (loading) return <Spinner />;
  if (!session) return <Login />;

  if (!profile?.org_id) {
    return (
      <div className="auth-wrap">
        <div className="card auth-card">
          <h2>No workspace yet</h2>
          <p className="sub" style={{ marginTop: 7 }}>
            Your account isn't linked to an organisation. Ask an admin to invite you, or contact support.
          </p>
          <button className="btn" style={{ marginTop: 14 }} onClick={signOut}>Sign out</button>
        </div>
      </div>
    );
  }

  if (needsOnboarding) return <Onboarding onDone={() => { void refresh(); navigate("/"); }} />;

  const leadParams = match("/leads/:id", path);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">{ui.icon}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {org?.name ?? "AbroBot"}
            </div>
            <div className="sub" style={{ fontSize: 11, fontWeight: 500 }}>{ui.name}</div>
          </div>
        </div>

        {NAV.filter((n) => !n.adminOnly || isAdmin).map((n) => {
          const active = n.path === "/" ? path === "/" : path.startsWith(n.path);
          return (
            <button
              key={n.path}
              className={`nav-item${active ? " active" : ""}`}
              onClick={() => navigate(n.path)}
            >
              <span className="ico">{n.icon}</span>
              {n.label ?? ui.leadNounPlural}
            </button>
          );
        })}

        <div className="spacer" />
        <div className="nav-group">Signed in</div>
        <div style={{ padding: "0 10px 8px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
            {profile?.full_name}
          </div>
          <div className="sub" style={{ fontSize: 11.5 }}>{profile?.role.replace("_", " ")}</div>
        </div>
        <button className="nav-item" onClick={signOut}>
          <span className="ico">↩︎</span> Sign out
        </button>
      </aside>

      <main className="main">
        <header className="topbar">
          <div style={{ fontWeight: 700 }}>
            {leadParams ? ui.leadNoun : path === "/" ? "Dashboard" : titleFor(path, ui.leadNounPlural)}
          </div>
          <div className="row">
            {org?.plan && <span className="pill pill-muted">{org.plan}</span>}
          </div>
        </header>

        <div className="content">
          {path === "/" && <Dashboard navigate={navigate} />}
          {path === "/leads" && <Leads navigate={navigate} />}
          {leadParams && <LeadDetail id={leadParams.id} navigate={navigate} />}
          {path === "/pipeline" && <Pipeline navigate={navigate} />}
          {path === "/settings" && <Settings />}
          {!isKnown(path) && (
            <div className="empty">
              <div className="empty-icon">🧭</div>
              <div style={{ fontWeight: 700 }}>Page not found</div>
              <button className="btn" style={{ marginTop: 14 }} onClick={() => navigate("/")}>Go to dashboard</button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function isKnown(path: string): boolean {
  return (
    path === "/" ||
    path === "/leads" ||
    path === "/pipeline" ||
    path === "/settings" ||
    match("/leads/:id", path) !== null
  );
}

function titleFor(path: string, leadsLabel: string): string {
  if (path.startsWith("/leads")) return leadsLabel;
  if (path.startsWith("/pipeline")) return "Pipeline";
  if (path.startsWith("/settings")) return "Settings";
  return "AbroBot CRM";
}
