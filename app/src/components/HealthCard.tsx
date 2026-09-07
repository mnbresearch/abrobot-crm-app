import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { FUNCTIONS_BASE, supabase } from "../lib/supabase";

// Surfaces the system-health probe in the app.
//
// This card exists because of a specific failure: the AI agent was returning
// an apology to every visitor for three days and nothing said so. A status
// nobody can see is a status nobody acts on.
//
// It stays silent when everything is fine — a health widget that is always
// shouting gets ignored, which defeats the point.

type Level = "ok" | "warn" | "fail";
interface Check { key: string; label: string; level: Level; detail: string }
interface OrgResult { org: string; name: string; status: Level; checks: Check[] }

export function HealthCard() {
  const { org } = useApp();
  const [result, setResult] = useState<OrgResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    void (async () => {
      try {
        // This fetch carried NO headers, and system-health requires either a
        // cron secret or a signed-in member — so it 401'd every single time,
        // set `unavailable`, and rendered null. The card that exists precisely
        // so a three-day silent outage is never repeated was itself silent, in
        // a way indistinguishable from "everything is healthy".
        //
        // (The function has been changed to accept a member JWT, which is what
        // makes sending one work at all.)
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        const r = await fetch(
          `${FUNCTIONS_BASE}/system-health?org=${encodeURIComponent(org.slug)}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        );
        if (!r.ok) { setUnavailable(true); return; }
        const j = await r.json();
        const first = j?.orgs?.[0];
        // Shape-check before trusting it. `result.checks.filter(...)` below is
        // unguarded, so a response without `checks` throws during render and
        // the ErrorBoundary takes out the whole dashboard — over a health
        // widget.
        if (!cancelled) {
          setResult(first && Array.isArray(first.checks) ? first : null);
        }
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    })();
    return () => { cancelled = true; };
  }, [org]);

  // Not deployed yet, or everything healthy → say nothing.
  if (unavailable || !result || result.status === "ok") return null;

  const failing = result.checks.filter((c) => c.level !== "ok");
  const isFail = result.status === "fail";
  const color = isFail ? "var(--red)" : "var(--amber)";

  return (
    <div
      className={`card${isFail ? " alert-pulse" : ""}`}
      style={{
        borderColor: color,
        borderWidth: 1.5,
        // Tokens, not hex — hardcoded light colours turned this into a glaring
        // white slab the moment dark mode existed.
        background: isFail ? "var(--red-soft)" : "var(--amber-soft)",
      }}
    >
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div style={{ fontSize: 20, lineHeight: 1.2 }}>{isFail ? "🚨" : "⚠️"}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color }}>
            {isFail ? "Something needs your attention" : "Worth a look"}
          </div>
          <div className="sub" style={{ marginTop: 2 }}>
            {failing.map((c) => c.label).join(" · ")}
          </div>

          {expanded && (
            <div style={{ marginTop: 11 }}>
              {failing.map((c) => (
                <div key={c.key} style={{ padding: "7px 0", borderTop: "1px solid var(--border)" }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {c.level === "fail" ? "🔴" : "🟡"} {c.label}
                  </div>
                  <div className="sub" style={{ fontSize: 12.5 }}>{c.detail}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="btn btn-sm" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Hide" : "Details"}
        </button>
      </div>
    </div>
  );
}
