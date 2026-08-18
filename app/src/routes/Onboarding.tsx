import { useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { getIndustry } from "../lib/industries";
import { useToast } from "../components/ui";

// The 90-second onboarding. Picking an industry seeds the pipeline, the custom
// fields and the AI agent persona in one call to apply_industry_pack(), so the
// user never sees a blank CRM.

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { industries, org, refresh } = useApp();
  const [picked, setPicked] = useState<string | null>(org?.industry_slug ?? null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const apply = async () => {
    if (!picked || !org) return;
    setSaving(true);
    // Seeding runs in Postgres, not here: it must be atomic and it must respect
    // the same authorisation rules whether it is called from this app, an edge
    // function, or psql.
    const { error } = await supabase.rpc("apply_industry_pack", { p_org_id: org.id, p_slug: picked });
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    await refresh();
    onDone();
  };

  const preview = picked ? getIndustry(picked) : null;

  return (
    <div style={{ maxWidth: 940, margin: "0 auto", padding: "44px 20px" }}>
      <div style={{ textAlign: "center", marginBottom: 30 }}>
        <div style={{ fontSize: 40 }}>👋</div>
        <h1 style={{ marginTop: 10 }}>What kind of business is {org?.name ?? "this"}?</h1>
        <p className="sub" style={{ marginTop: 7, fontSize: 15 }}>
          Pick one and your pipeline, fields and AI assistant are configured instantly.
          You can change any of it later.
        </p>
      </div>

      <div className="pick-grid">
        {industries.map((ind) => {
          const ui = getIndustry(ind.slug);
          const on = picked === ind.slug;
          return (
            <button
              key={ind.slug}
              className={`pick${on ? " selected" : ""}`}
              onClick={() => setPicked(ind.slug)}
              style={on && ui.accent ? { borderColor: ui.accent, boxShadow: `0 0 0 4px ${ui.accentSoft ?? "var(--brand-light)"}` } : undefined}
            >
              <div className="pick-icon">{ind.icon ?? ui.icon}</div>
              <div className="pick-name">{ind.name}</div>
              <div className="pick-tag">{ind.tagline}</div>
              <div className="sub" style={{ marginTop: 9, fontSize: 12 }}>
                Tracks <b>{ind.lead_noun_plural}</b>
              </div>
            </button>
          );
        })}
      </div>

      {preview && (
        <div className="card" style={{ marginTop: 24 }}>
          <div className="card-title">
            <h2>{preview.icon} What you'll get</h2>
          </div>
          <div className="grid grid-2">
            <div>
              <div className="label">Your dashboard will track</div>
              <div className="row-wrap">
                {preview.kpis.map((k) => (
                  <span key={k.key} className="pill">{k.icon} {k.label}</span>
                ))}
              </div>
            </div>
            <div>
              <div className="label">Quick actions on every record</div>
              <div className="row-wrap">
                {preview.quickActions.map((a) => (
                  <span key={a.key} className="pill pill-muted">{a.icon} {a.label}</span>
                ))}
              </div>
              {preview.tool !== "none" && (
                <>
                  <div className="label" style={{ marginTop: 13 }}>Built-in tool</div>
                  <span className="pill">🧰 {preview.toolLabel}</span>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="row" style={{ justifyContent: "center", marginTop: 24 }}>
        <button className="btn btn-primary" disabled={!picked || saving} onClick={apply} style={{ minWidth: 210 }}>
          {saving ? "Setting up…" : "Set up my CRM →"}
        </button>
      </div>
      {toast.node}
    </div>
  );
}
