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
import { Conversations } from "./routes/Conversations";
import { Reports } from "./routes/Reports";
import { Team } from "./routes/Team";
import { Activity } from "./routes/Activity";
import { Calendar } from "./routes/Calendar";
import { Templates } from "./routes/Templates";
import { Import } from "./routes/Import";
import { Automations } from "./routes/Automations";
import { CommandPalette } from "./components/CommandPalette";
import { CreateOrg } from "./routes/CreateOrg";
import { ShortcutsHelp } from "./components/ShortcutsHelp";
import { useTheme } from "./lib/theme";

// Routes mirror the legacy app's URLs so both frontends can serve the same
// links during the takeover. The legacy /analytics, /reports and /leaderboard
// are consolidated into /reports — they answered the same question, and three
// near-duplicate screens was part of what made the old app feel heavy.

interface NavItem {
  path: string;
  label: string | null;   // null = use the industry's plural noun
  icon: string;
  adminOnly?: boolean;
  group?: string;
}

const NAV: NavItem[] = [
  { path: "/", label: "Dashboard", icon: "📊" },
  { path: "/leads", label: null, icon: "👥" },
  { path: "/pipeline", label: "Pipeline", icon: "🔀" },
  { path: "/calendar", label: "Calendar", icon: "📅" },
  { path: "/conversations", label: "Conversations", icon: "💬", group: "Engage" },
  { path: "/templates", label: "Templates", icon: "📄", group: "Engage" },
  { path: "/automations", label: "Automations", icon: "⚡", group: "Engage", adminOnly: true },
  { path: "/reports", label: "Reports", icon: "📈", group: "Insight" },
  { path: "/activity", label: "Activity", icon: "🗂️", group: "Insight" },
  { path: "/team", label: "Team", icon: "🧑‍🤝‍🧑", group: "Manage" },
  { path: "/import", label: "Import", icon: "📥", group: "Manage", adminOnly: true },
  { path: "/settings", label: "Settings", icon: "⚙️", group: "Manage", adminOnly: true },
];

export default function App() {
  const { loading, session, profile, org, ui, isAdmin, needsOnboarding, signOut, refresh } = useApp();
  const { path, navigate } = useRoute();
  const { theme, cycle, resolved } = useTheme();

  if (loading) return <Spinner />;
  if (!session) return <Login />;

  // No organisation yet → self-serve signup. CreateOrg first checks for a
  // pending invite, so an invited teammate joins their team rather than
  // accidentally creating a second, empty organisation.
  if (!profile?.org_id) {
    return <CreateOrg onDone={() => { void refresh(); navigate("/"); }} />;
  }

  if (needsOnboarding) return <Onboarding onDone={() => { void refresh(); navigate("/"); }} />;

  const leadParams = match("/leads/:id", path);
  const visible = NAV.filter((n) => !n.adminOnly || isAdmin);

  let lastGroup: string | undefined;

  return (
    <div className="shell">
      <CommandPalette navigate={navigate} />
      <ShortcutsHelp navigate={navigate} cycleTheme={cycle} />
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

        {visible.map((n) => {
          const active = n.path === "/" ? path === "/" : path.startsWith(n.path);
          const header = n.group && n.group !== lastGroup ? n.group : null;
          lastGroup = n.group;
          return (
            <div key={n.path}>
              {header && <div className="nav-group">{header}</div>}
              <button className={`nav-item${active ? " active" : ""}`} onClick={() => navigate(n.path)}>
                <span className="ico">{n.icon}</span>
                {n.label ?? ui.leadNounPlural}
              </button>
            </div>
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
          <div style={{ fontWeight: 700 }}>{titleFor(path, ui.leadNoun, ui.leadNounPlural)}</div>
          <div className="row">
            <button
              className="btn btn-sm"
              onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
              title="Search everything (⌘K)"
            >
              🔍 Search <span className="kbd">⌘K</span>
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={cycle}
              title={`Theme: ${theme}${theme === "system" ? ` (${resolved})` : ""} — press T`}
              aria-label="Change theme"
            >
              {theme === "system" ? "🖥️" : resolved === "dark" ? "🌙" : "☀️"}
            </button>
            {org?.plan && <span className="pill pill-muted">{org.plan}</span>}
          </div>
        </header>

        {/* keyed on path so each route change replays the entrance animation */}
        <div className="content route-enter" key={path}>
          {path === "/" && <Dashboard navigate={navigate} />}
          {path === "/leads" && <Leads navigate={navigate} />}
          {leadParams && <LeadDetail id={leadParams.id} navigate={navigate} />}
          {path === "/pipeline" && <Pipeline navigate={navigate} />}
          {path === "/calendar" && <Calendar navigate={navigate} />}
          {path === "/conversations" && <Conversations navigate={navigate} />}
          {path === "/templates" && <Templates />}
          {path === "/automations" && <Automations />}
          {path === "/reports" && <Reports />}
          {path === "/activity" && <Activity navigate={navigate} />}
          {path === "/team" && <Team />}
          {path === "/import" && <Import navigate={navigate} />}
          {path === "/settings" && <Settings />}

          {!isKnown(path) && (
            <div className="empty">
              <div className="empty-icon">🧭</div>
              <div style={{ fontWeight: 700 }}>Page not found</div>
              <p className="sub" style={{ marginTop: 6 }}>
                This route may still be served by the previous version of the app.
              </p>
              <button className="btn" style={{ marginTop: 14 }} onClick={() => navigate("/")}>Go to dashboard</button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

const KNOWN = [
  "/", "/leads", "/pipeline", "/calendar", "/conversations",
  "/templates", "/automations", "/reports", "/activity", "/team", "/import", "/settings",
];

function isKnown(path: string): boolean {
  return KNOWN.includes(path) || match("/leads/:id", path) !== null;
}

function titleFor(path: string, leadNoun: string, leadsLabel: string): string {
  if (match("/leads/:id", path)) return leadNoun;
  if (path === "/") return "Dashboard";
  if (path.startsWith("/leads")) return leadsLabel;
  const found = KNOWN.find((k) => k !== "/" && path.startsWith(k));
  if (!found) return "AbroBot CRM";
  return found.slice(1).replace(/^\w/, (c) => c.toUpperCase());
}
