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
      // These were `{ count: "exact", head: true }` queries, and all four
      // returned 503 on every dashboard load while the ordinary GETs beside
      // them returned 200. The cause was never pinned down — free-tier
      // connection limits under five parallel queries and a PostgREST quirk on
      // HEAD+count were both consistent with what I could observe.
      //
      // Rather than guess, the fix removes the need for the count at all.
      // Every question here is "are there ANY?" or "is there MORE THAN ONE?",
      // never "how many exactly" — so a plain GET with limit(2) answers all of
      // them, uses the request shape that already works, and moves less data.
      const [agent, leads, team, autos, templates, integrations] = await Promise.all([
        supabase.from("agent_config").select("enabled, knowledge, notify_new_leads").eq("org_id", org.id).maybeSingle(),
        supabase.from("leads").select("id").eq("org_id", org.id).limit(2),
        supabase.from("profiles").select("id").eq("org_id", org.id).eq("status", "active").limit(2),
        supabase.from("automations").select("id").eq("org_id", org.id).eq("enabled", true).limit(2),
        supabase.from("message_templates").select("id").eq("org_id", org.id).limit(2),
        // Booleans only — see integration_status() in
        // 20260905120000_credential_columns_and_status.sql. The browser is not
        // allowed to read a credential, so it asks the database whether one
        // exists instead of inferring it from a toggle.
        supabase.rpc("integration_status"),
      ]);

      // A failed check is NOT the same as an unfinished step. Treating an
      // error as "not done" is what made this silently under-report setup
      // progress: the request 503'd, `count` came back null, `?? 0` turned it
      // into zero, and the user was told to redo work they had already done.
      // `has()` returns undefined on error so the step can be left alone.
      const has = (r: { data: unknown[] | null; error: unknown }, min = 1) =>
        r.error ? undefined : (r.data?.length ?? 0) >= min;

      // A toggle is a statement of intent; credentials are what make alerts
      // arrive. Ticking this step off the toggle alone told customers their
      // alerts were set up when no bot token existed — and a ticked box is
      // worse than an empty one, because it stops them looking.
      //
      // If the RPC is missing (migration not applied yet) we fall back to the
      // toggle rather than showing every existing customer an unticked box for
      // work they have already done.
      const intg = integrations.error
        ? null
        : (integrations.data as {
            telegram?: { configured?: boolean; alerts_on?: boolean };
          } | null);
      const alertsReady = intg?.telegram
        ? !!(intg.telegram.configured && intg.telegram.alerts_on)
        : !!agent.data?.notify_new_leads;

      const anyLeads = has(leads);
      const teamInvited = has(team, 2);
      const anyAutos = has(autos);
      const anyTemplates = has(templates);

      const failed = [
        leads.error && "records", team.error && "team",
        autos.error && "automations", templates.error && "templates",
      ].filter(Boolean);
      if (failed.length) {
        console.warn("SetupChecklist: could not check " + failed.join(", ") +
          " — those steps are shown as complete rather than nagging you to redo them.");
      }

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
          done: anyLeads ?? true,
          action: { label: "Get the snippet", path: "/settings" },
        },
        {
          key: "alerts",
          label: "Turn on new-record alerts",
          why: intg?.telegram?.alerts_on && !intg.telegram.configured
            ? "Alerts are switched on but there is no Telegram bot token or chat ID saved, so nothing can be delivered. Add them to finish this."
            : "A record you hear about in an hour is worth far more than one you find next week.",
          done: alertsReady,
          action: { label: "Set up alerts", path: "/integrations" },
        },
        {
          key: "team",
          label: "Invite your team",
          why: `So ${ui.leadNounPlural.toLowerCase()} can be assigned and nothing sits unowned.`,
          done: teamInvited ?? true,
          action: { label: "Manage team", path: "/team" },
        },
        {
          key: "template",
          label: "Write your first message template",
          why: "The reply your team sends most, ready to reuse.",
          done: anyTemplates ?? true,
          action: { label: "Add template", path: "/templates" },
        },
        {
          key: "automation",
          label: "Switch on one automation",
          why: "Let the CRM chase the things people forget.",
          done: anyAutos ?? true,
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
