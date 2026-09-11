import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "./lib/store";
import { match, useRoute } from "./lib/router";
import { LoadError, Spinner } from "./components/ui";
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
import { Archived } from "./routes/Archived";
import { Admin } from "./routes/Admin";
import { Automations } from "./routes/Automations";
import { Integrations } from "./routes/Integrations";
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
  // A tenant's admin is not the platform owner. Separate flag, because
  // conflating them is how the Platform console would appear in every
  // customer's sidebar.
  superAdminOnly?: boolean;
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
  { path: "/archived", label: "Archived", icon: "🗄", group: "Manage", adminOnly: true },
  { path: "/integrations", label: "Integrations", icon: "🔌", group: "Manage", adminOnly: true },
  { path: "/settings", label: "Settings", icon: "⚙️", group: "Manage", adminOnly: true },
  { path: "/admin", label: "Platform", icon: "🛠", group: "Manage", superAdminOnly: true },
];

export default function App() {
  const {
    loading, session, profile, org, ui, isAdmin, isSuperAdmin, needsOnboarding,
    loadError, signOut, refresh,
  } = useApp();   // plan is read by <PlanPill/> from the same context
  const { path, navigate } = useRoute();
  const { theme, cycle, resolved } = useTheme();

  // ── mobile drawer ────────────────────────────────────────────────────────
  const [navOpen, setNavOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  const closeNav = useCallback(() => {
    setNavOpen(false);
    // Focus goes back to the control that opened the drawer. Without this it
    // lands on <body> and the next Tab restarts from the top of the document,
    // which for a keyboard or switch user means re-traversing the entire page
    // after every single navigation.
    //
    // OUTSIDE the state updater, deliberately. Updaters have to be pure —
    // StrictMode double-invokes them in development, so a focus() call in there
    // fires twice per close, and React is free to re-run or discard an updater
    // at any point. `navOpen` guards it because closeNav also runs on every
    // desktop navigation, where the toggle is display:none and yanking focus at
    // it would silently drop focus to <body>.
    if (navOpen) toggleRef.current?.focus();
  }, [navOpen]);

  // Escape closes. Bound at the window rather than the drawer because focus
  // may legitimately be inside it or on the toggle.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeNav(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen, closeNav]);

  // Move focus INTO the drawer when it opens, so the first Tab continues
  // through the nav instead of through the page behind the backdrop.
  useEffect(() => {
    if (!navOpen) return;
    const first = sidebarRef.current?.querySelector<HTMLElement>("button, a, [tabindex]:not([tabindex='-1'])");
    first?.focus();
  }, [navOpen]);

  // The page behind a full-height overlay must not scroll under it — on iOS
  // that reads as the drawer itself being broken, because the content moves
  // while the drawer does not.
  useEffect(() => {
    if (!navOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [navOpen]);

  // Above the breakpoint the sidebar is permanently visible and `.open` does
  // nothing — but this component's state would still say "open", and the
  // scroll lock above is keyed on it. Rotating a tablet to landscape with the
  // drawer open therefore left the page unscrollable with no visible cause and
  // no control on screen to undo it (.nav-toggle is display:none there).
  useEffect(() => {
    const mq = window.matchMedia?.("(min-width: 821px)");
    if (!mq) return;
    const onChange = () => { if (mq.matches) setNavOpen(false); };
    // Safari before 14 implements MediaQueryList as an EventTarget in name only:
    // matchMedia exists, addEventListener does not, and calling it throws. The
    // `?.` above already concedes that matchMedia might be missing, so assuming
    // the modern listener API one line later was inconsistent — and the throw
    // would take down the whole App render, not just the drawer.
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

  // Close on navigate. This is the whole reason navigation goes through one
  // function: a drawer left open over the screen you just asked for is the
  // most common way a hand-rolled mobile nav ends up feeling broken.
  const go = useCallback((to: string) => {
    navigate(to);
    closeNav();
  }, [navigate, closeNav]);

  if (loading) return <Spinner />;

  // Signed out wins over every other state, and it has to be tested FIRST.
  // The error card used to come before this line, and the most common cause of
  // a shell load failure is an expired refresh token: the profile read 401s,
  // loadError is set, and the user was pinned on an error card whose only
  // control was Retry — which re-ran the same request with the same dead token
  // and failed identically, forever. No sign-out, no way to the login form, and
  // nothing on screen saying the session was the problem.
  if (!session) return <Login />;

  // The shell's own load failed. Previously this state did not exist: a failed
  // profile read left profile null, which is indistinguishable from "no
  // organisation yet", and an existing customer was shown the CREATE
  // ORGANISATION form — one click from a second, empty workspace.
  //
  // Sign out is offered alongside Retry regardless, because a session can be
  // rejected by the server while the client still believes it holds one, and
  // that case is indistinguishable from an outage until you try it.
  if (loadError) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <LoadError
            message={loadError}
            onRetry={() => void refresh()}
            onSignOut={() => void signOut()}
          />
        </div>
      </div>
    );
  }

  // No organisation yet → self-serve signup. CreateOrg first checks for a
  // pending invite, so an invited teammate joins their team rather than
  // accidentally creating a second, empty organisation.
  if (!profile?.org_id) {
    return <CreateOrg onDone={() => { void refresh(); navigate("/"); }} />;
  }

  if (needsOnboarding) return <Onboarding onDone={() => { void refresh(); navigate("/"); }} />;

  const leadParams = match("/leads/:id", path);
  const visible = NAV.filter((n) =>
    (!n.adminOnly || isAdmin) && (!n.superAdminOnly || isSuperAdmin));

  let lastGroup: string | undefined;

  return (
    <div className="shell">
      <CommandPalette navigate={go} />
      <ShortcutsHelp navigate={go} cycleTheme={cycle} />

      {/* Rendered only while open, so it costs nothing on desktop where the
          drawer never opens.

          A <div>, not a <button>. aria-hidden on an interactive element is a
          direct contradiction: the button stayed in the accessibility tree's
          focus order for some AT while being announced to none of it, which is
          the WCAG 4.1.2 failure "focusable element hidden from assistive
          technology". The dimmed area is pure decoration — every user already
          has two announced ways out (the ✕ toggle and Escape) — so it is
          correctly non-interactive to AT and click-to-close for a mouse. */}
      {navOpen && <div className="nav-backdrop" aria-hidden="true" onClick={closeNav} />}

      <aside
        ref={sidebarRef}
        className={`sidebar${navOpen ? " open" : ""}`}
        id="app-nav"
        aria-label="Main navigation"
      >
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
              <button
                className={`nav-item${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => go(n.path)}
              >
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
          <div className="row" style={{ gap: 10, minWidth: 0 }}>
            <button
              ref={toggleRef}
              className="btn btn-sm btn-ghost nav-toggle"
              onClick={() => (navOpen ? closeNav() : setNavOpen(true))}
              aria-expanded={navOpen}
              aria-controls="app-nav"
              aria-label={navOpen ? "Close menu" : "Open menu"}
            >
              {navOpen ? "✕" : "☰"}
            </button>
            <div className="truncate" style={{ fontWeight: 700 }}>
              {titleFor(path, ui.leadNoun, ui.leadNounPlural)}
            </div>
          </div>
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
            <PlanPill />
          </div>
        </header>

        {/* keyed on path so each route change replays the entrance animation */}
        <div className="content route-enter" key={path}>
          {path === "/" && <Dashboard navigate={go} />}
          {path === "/leads" && <Leads navigate={go} />}
          {leadParams && <LeadDetail id={leadParams.id} navigate={go} />}
          {path === "/pipeline" && <Pipeline navigate={go} />}
          {path === "/calendar" && <Calendar navigate={go} />}
          {path === "/conversations" && <Conversations navigate={go} />}
          {path === "/templates" && <Templates />}
          {path === "/automations" && <Automations />}
          {path === "/reports" && <Reports />}
          {path === "/activity" && <Activity navigate={go} />}
          {path === "/team" && <Team />}
          {path === "/import" && <Import navigate={go} />}
          {path === "/archived" && <Archived navigate={go} />}
          {path === "/integrations" && <Integrations />}
          {path === "/settings" && <Settings />}
          {path === "/admin" && <Admin />}

          {!isKnown(path) && (
            <div className="empty">
              <div className="empty-icon">🧭</div>
              <div style={{ fontWeight: 700 }}>Page not found</div>
              <p className="sub" style={{ marginTop: 6 }}>
                This route may still be served by the previous version of the app.
              </p>
              <button className="btn" style={{ marginTop: 14 }} onClick={() => go("/")}>Go to dashboard</button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * The plan badge, showing what APPLIES rather than what was bought.
 *
 * This read `org.plan`, which is the purchase record and never changes on its
 * own. A Growth customer whose access lapsed last week saw "growth" in the
 * corner of every screen while `effective_plan()` — the function every
 * server-side guard consults — had already moved them to "expired". So the
 * badge asserted they were fine, and the app then refused to save a record with
 * no explanation on screen that reconciled the two.
 *
 * Falls back to the purchased plan when usage_snapshot could not be read, which
 * is no worse than the old behaviour and never blank.
 */
function PlanPill() {
  const { org, plan } = useApp();
  if (!plan) return org?.plan ? <span className="pill pill-muted">{org.plan}</span> : null;

  const lapsed = plan.isExpired || plan.notActivated;
  const drifted = plan.effective !== plan.purchased;
  return (
    <span
      className={plan.isExpired ? "pill pill-red" : plan.notActivated ? "pill pill-muted" : "pill pill-green"}
      title={
        drifted
          ? `You bought ${plan.purchased}; ${plan.effective} is what currently applies. See Settings → Plan & usage.`
          : plan.label
      }
    >
      {plan.effective}{lapsed && drifted ? ` (was ${plan.purchased})` : ""}
    </span>
  );
}

const KNOWN = [
  "/", "/leads", "/pipeline", "/calendar", "/conversations",
  "/templates", "/automations", "/reports", "/activity", "/team", "/import", "/archived",
  "/integrations", "/settings", "/admin",
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
