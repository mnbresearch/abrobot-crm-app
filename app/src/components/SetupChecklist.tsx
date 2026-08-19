import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";

// Guided setup. Disappears permanently once everything is done, rather than
// nagging established orgs — the goal is reaching first value, not a
// permanent scoreboard.
//
// Each step is verified against real data, not a "dismissed" flag. A checklist
// you can tick without doing the work teaches people to ignore checklists.

interface Step {
  key: string;
  label: string;
  why: string;
  done: boolean;
  action?: { label: string; path: string };
}

export function SetupChecklist({ navigate }: { navigate: (to: string) => void }) {
  const { org, ui, isAdmin } = useApp();
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!org || !isAdmin) return;
    void (async () => {
      const [agent, leads, team, autos, templates] = await Promise.all([
        supabase.from("agent_config").select("enabled, knowledge, notify_new_leads").eq("org_id", org.id).maybeSingle(),
        supabase.from("leads").select("id", { count: "exact", head: true }).eq("org_id", org.id),
        supabase.from("profiles").select("id", { count: "exact", head: true }).eq("org_id", org.id).eq("status", "active"),
        supabase.from("automations").select("id", { count: "exact", head: true }).eq("org_id", org.id).eq("enabled", true),
        supabase.from("message_templates").select("id", { count: "exact", head: true }).eq("org_id", org.id),
      ]);

      setSteps([
        {
          key: "industry",
          label: "Choose your industry",
          why: "Sets your pipeline, fields and AI persona in one go.",
          done: !!org.industry_slug,
          action: { label: "Choose", path: "/settings" },
        },
        {
          key: "knowledge",
          label: "Teach the AI assistant about your business",
          why: "Services, pricing, timings. Without this it can only answer in generalities.",
          done: !!(agent.data?.knowledge && agent.data.knowledge.trim().length > 40),
          action: { label: "Add knowledge", path: "/settings" },
        },
        {
          key: "widget",
          label: "Put the chat widget on your website",
          why: "One line of HTML. This is what turns visitors into records automatically.",
          done: (leads.count ?? 0) > 0,
          action: { label: "Get the snippet", path: "/settings" },
        },
        {
          key: "alerts",
          label: "Turn on new-record alerts",
          why: "A record you hear about in an hour is worth far more than one you find next week.",
          done: !!agent.data?.notify_new_leads,
          action: { label: "Set up alerts", path: "/settings" },
        },
        {
          key: "team",
          label: "Invite your team",
          why: `So ${ui.leadNounPlural.toLowerCase()} can be assigned and nothing sits unowned.`,
          done: (team.count ?? 0) > 1,
          action: { label: "Manage team", path: "/team" },
        },
        {
          key: "template",
          label: "Write your first message template",
          why: "The reply your team sends most, ready to reuse.",
          done: (templates.count ?? 0) > 0,
          action: { label: "Add template", path: "/templates" },
        },
        {
          key: "automation",
          label: "Switch on one automation",
          why: "Let the CRM chase the things people forget.",
          done: (autos.count ?? 0) > 0,
          action: { label: "See recipes", path: "/automations" },
        },
      ]);
    })();
  }, [org, isAdmin, ui.leadNounPlural]);

  if (!isAdmin || !steps || hidden) return null;

  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null; // finished — stop showing it

  const next = steps.find((s) => !s.done);
  const pct = Math.round((done / steps.length) * 100);

  return (
    <div className="card">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <div className="row">
            <h2>Finish setting up</h2>
            <span className="pill">{done}/{steps.length}</span>
          </div>
          <div style={{ height: 7, background: "#f0efed", borderRadius: 999, marginTop: 9, overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: "var(--industry)", borderRadius: 999, transition: "width .3s var(--ease)" }} />
          </div>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={() => setHidden(true)}>Hide</button>
      </div>

      <div style={{ marginTop: 15 }}>
        {steps.map((s) => (
          <div
            key={s.key}
            className="row"
            style={{
              padding: "9px 0", borderTop: "1px solid var(--border)", alignItems: "flex-start",
              opacity: s.done ? 0.55 : 1,
            }}
          >
            <div style={{ fontSize: 15, width: 20 }}>{s.done ? "✅" : "⬜"}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, textDecoration: s.done ? "line-through" : undefined }}>{s.label}</div>
              {!s.done && <div className="sub" style={{ fontSize: 12.5 }}>{s.why}</div>}
            </div>
            {!s.done && s.action && s.key === next?.key && (
              <button className="btn btn-sm btn-primary" onClick={() => navigate(s.action!.path)}>
                {s.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
