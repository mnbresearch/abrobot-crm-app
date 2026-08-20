import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { getIndustry } from "../lib/industries";
import { Card, Empty, Modal, useToast } from "../components/ui";
import type { AgentConfig, FieldDef, FieldType, PipelineStage } from "../lib/types";

type Tab = "industry" | "pipeline" | "fields" | "agent" | "install" | "usage";

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "industry", label: "Industry", icon: "🏭" },
  { key: "pipeline", label: "Pipeline", icon: "🔀" },
  { key: "fields", label: "Fields", icon: "🧩" },
  { key: "agent", label: "AI Agent", icon: "🤖" },
  { key: "install", label: "Install Widget", icon: "🚀" },
  { key: "usage", label: "Plan & Usage", icon: "📊" },
];

interface UsageMetric { used: number; limit: number | null }
interface UsageSnapshot {
  plan: string; label: string; period: string;
  ai_messages: UsageMetric; leads: UsageMetric;
  seats: UsageMetric; automations: UsageMetric;
  whatsapp: boolean;
}

function UsageTab() {
  const { org } = useApp();
  const [snap, setSnap] = useState<UsageSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!org) return;
    void supabase.rpc("usage_snapshot", { p_org_id: org.id }).then(({ data, error }) => {
      if (error) setErr(error.message);
      else setSnap(data as UsageSnapshot);
    });
  }, [org]);

  if (err) {
    return (
      <Card title="Plan & usage">
        <p className="sub">
          Couldn't load usage: {err}
        </p>
        <p className="sub" style={{ fontSize: 12, marginTop: 8 }}>
          This needs migration <code>20260819090000_automations_and_plan_limits.sql</code> to be applied.
        </p>
      </Card>
    );
  }
  if (!snap) return <Card><p className="sub">Loading…</p></Card>;

  const Meter = ({ label, m, unit }: { label: string; m: UsageMetric; unit?: string }) => {
    const pct = m.limit ? Math.min(100, Math.round((m.used / m.limit) * 100)) : 0;
    const color = pct >= 90 ? "var(--red)" : pct >= 70 ? "var(--amber)" : "var(--green)";
    return (
      <div style={{ marginBottom: 15 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span style={{ fontWeight: 600 }}>{label}</span>
          <span className="mono sub">
            {m.used.toLocaleString("en-IN")}{m.limit ? ` / ${m.limit.toLocaleString("en-IN")}` : " · unlimited"}{unit ? ` ${unit}` : ""}
          </span>
        </div>
        {m.limit !== null && (
          <div style={{ height: 7, background: "#f0efed", borderRadius: 999, marginTop: 5, overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 999 }} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="stack">
      <Card title={`Plan — ${snap.label}`}>
        <p className="sub" style={{ marginTop: -8, marginBottom: 15 }}>
          AI messages reset monthly. Current period {snap.period}.
        </p>
        <Meter label="AI chat messages" m={snap.ai_messages} />
        <Meter label="Records" m={snap.leads} />
        <Meter label="Active team members" m={snap.seats} />
        <Meter label="Active automations" m={snap.automations} />
        <div className="row" style={{ marginTop: 4 }}>
          <span className={snap.whatsapp ? "pill pill-green" : "pill pill-muted"}>
            {snap.whatsapp ? "✓ WhatsApp included" : "WhatsApp not on this plan"}
          </span>
        </div>
      </Card>
      <Card title="How limits work">
        <p className="sub" style={{ marginTop: -8 }}>
          Limits are enforced on the server, inside the edge functions — not in this browser. When the AI
          message allowance runs out the assistant switches to a polite hand-off message and still captures
          the visitor's contact details, so you never lose the enquiry itself.
        </p>
      </Card>
    </div>
  );
}

export function Settings() {
  const { isAdmin } = useApp();
  const [tab, setTab] = useState<Tab>("industry");

  if (!isAdmin) {
    return (
      <Card>
        <Empty icon="🔒" title="Admins only" hint="Ask an org admin to change these settings." />
      </Card>
    );
  }

  return (
    <div className="stack">
      <h1>Settings</h1>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab${tab === t.key ? " active" : ""}`} onClick={() => setTab(t.key)}>
            <span aria-hidden="true" style={{ marginRight: 6 }}>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>
      {tab === "industry" && <IndustryTab />}
      {tab === "pipeline" && <PipelineTab />}
      {tab === "fields" && <FieldsTab />}
      {tab === "agent" && <AgentTab />}
      {tab === "install" && <InstallTab />}
      {tab === "usage" && <UsageTab />}
    </div>
  );
}

// ── industry ────────────────────────────────────────────────────────────────
function IndustryTab() {
  const { industries, org, refresh } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const toast = useToast();

  const apply = async (slug: string) => {
    if (!org) return;
    setBusy(slug);
    setConfirm(null);
    const { error } = await supabase.rpc("apply_industry_pack", { p_org_id: org.id, p_slug: slug });
    setBusy(null);
    if (error) { toast.error(error.message); return; }
    await refresh();
    toast.show("Industry applied");
  };

  return (
    <>
      <Card title="Your industry">
        <p className="sub" style={{ marginTop: -8, marginBottom: 14 }}>
          Switching adds the new industry's stages and fields. Your existing stages, fields and data are
          kept — nothing is deleted.
        </p>
        <div className="pick-grid">
          {industries.map((ind) => {
            const ui = getIndustry(ind.slug);
            const on = org?.industry_slug === ind.slug;
            return (
              <button
                key={ind.slug}
                className={`pick${on ? " selected" : ""}`}
                onClick={() => (on ? undefined : setConfirm(ind.slug))}
                disabled={busy !== null}
              >
                <div className="pick-icon">{ind.icon ?? ui.icon}</div>
                <div className="pick-name">{ind.name}</div>
                <div className="pick-tag">{ind.tagline}</div>
                {on && <div className="pill" style={{ marginTop: 9 }}>Current</div>}
              </button>
            );
          })}
        </div>
      </Card>

      {confirm && (
        <Modal title="Switch industry?" onClose={() => setConfirm(null)}>
          <p>
            This adds <b>{industries.find((i) => i.slug === confirm)?.name}</b> stages and fields to your
            workspace and re-themes the interface.
          </p>
          <p className="sub">
            Existing {} records keep their current stage. Any stage or field you already have with the same
            key is left untouched.
          </p>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void apply(confirm)}>Switch</button>
          </div>
        </Modal>
      )}
      {toast.node}
    </>
  );
}

// ── pipeline ────────────────────────────────────────────────────────────────
function PipelineTab() {
  const { stages, org, refresh } = useApp();
  const [rows, setRows] = useState<PipelineStage[]>(stages);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => setRows(stages), [stages]);

  const update = (id: string, patch: Partial<PipelineStage>) =>
    setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    setRows(next.map((r, idx) => ({ ...r, position: idx })));
  };

  const save = async () => {
    setSaving(true);
    for (const [i, r] of rows.entries()) {
      await supabase.from("pipeline_stages")
        .update({ label: r.label, position: i, is_won: r.is_won, is_lost: r.is_lost })
        .eq("id", r.id);
    }
    setSaving(false);
    await refresh();
    toast.show("Pipeline saved");
  };

  const add = async () => {
    if (!org) return;
    const key = `stage_${Date.now().toString(36)}`;
    const { error } = await supabase.from("pipeline_stages").insert({
      org_id: org.id, key, label: "New stage", position: rows.length,
    });
    if (error) { toast.error(error.message); return; }
    await refresh();
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from("pipeline_stages").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    await refresh();
    toast.show("Stage removed");
  };

  return (
    <>
      <Card
        title="Pipeline stages"
        action={<button className="btn btn-sm" onClick={add}>+ Add stage</button>}
      >
        <p className="sub" style={{ marginTop: -8, marginBottom: 14 }}>
          Renaming a stage is safe — records are linked by an internal key, not the label. Mark exactly one
          stage as Won and one as Lost so conversion rates compute correctly.
        </p>

        {rows.map((r, i) => (
          <div className="row" style={{ gap: 8, marginBottom: 9 }} key={r.id}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <button className="btn btn-sm btn-ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">▲</button>
              <button className="btn btn-sm btn-ghost" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="Move down">▼</button>
            </div>
            <input className="input" value={r.label} onChange={(e) => update(r.id, { label: e.target.value })} />
            <label className="row btn btn-sm" style={{ whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={r.is_won} onChange={(e) => update(r.id, { is_won: e.target.checked, is_lost: false })} />
              Won
            </label>
            <label className="row btn btn-sm" style={{ whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={r.is_lost} onChange={(e) => update(r.id, { is_lost: e.target.checked, is_won: false })} />
              Lost
            </label>
            <button className="btn btn-sm btn-danger" onClick={() => void remove(r.id)} aria-label="Delete stage">🗑</button>
          </div>
        ))}

        <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save pipeline"}
          </button>
        </div>
      </Card>
      {toast.node}
    </>
  );
}

// ── custom fields ───────────────────────────────────────────────────────────
const FIELD_TYPES: FieldType[] = ["text", "textarea", "number", "currency", "date", "select", "multiselect", "checkbox", "email", "phone", "url"];

function FieldsTab() {
  const { fields, org, refresh, ui } = useApp();
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  const toggleList = async (f: FieldDef) => {
    const { error } = await supabase.from("field_defs").update({ show_in_list: !f.show_in_list }).eq("id", f.id);
    if (error) { toast.error(error.message); return; }
    await refresh();
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from("field_defs").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    await refresh();
    toast.show("Field removed");
  };

  return (
    <>
      <Card
        title="Custom fields"
        action={<button className="btn btn-sm" onClick={() => setAdding(true)}>+ Add field</button>}
      >
        <p className="sub" style={{ marginTop: -8, marginBottom: 14 }}>
          These appear on every {ui.leadNoun.toLowerCase()} record. Tick "In list" to show one as a column
          in the {ui.leadNounPlural.toLowerCase()} table.
        </p>

        {fields.length === 0 ? (
          <Empty icon="🧩" title="No custom fields" hint="Add the things your team actually asks about." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Label</th><th>Type</th><th>In list</th><th></th></tr>
              </thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f.id} style={{ cursor: "default" }}>
                    <td style={{ fontWeight: 600 }}>{f.label}</td>
                    <td><span className="pill pill-muted">{f.type}</span></td>
                    <td>
                      <input type="checkbox" checked={f.show_in_list} onChange={() => void toggleList(f)} />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn btn-sm btn-danger" onClick={() => void remove(f.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {adding && org && (
        <AddField
          orgId={org.id}
          onClose={() => setAdding(false)}
          onSaved={async () => { setAdding(false); await refresh(); toast.show("Field added"); }}
        />
      )}
      {toast.node}
    </>
  );
}

function AddField({ orgId, onClose, onSaved }: { orgId: string; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [options, setOptions] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!label.trim()) { setErr("Give the field a label"); return; }
    const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (!key) { setErr("Use at least one letter or number"); return; }
    const { error } = await supabase.from("field_defs").insert({
      org_id: orgId, key, label: label.trim(), type,
      options: type === "select" || type === "multiselect"
        ? options.split(",").map((o) => o.trim()).filter(Boolean)
        : [],
    });
    if (error) { setErr(error.message); return; }
    onSaved();
  };

  return (
    <Modal title="Add field" onClose={onClose}>
      <div className="field">
        <label className="label">Label</label>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Department" autoFocus />
      </div>
      <div className="field">
        <label className="label">Type</label>
        <select className="select" value={type} onChange={(e) => setType(e.target.value as FieldType)}>
          {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      {(type === "select" || type === "multiselect") && (
        <div className="field">
          <label className="label">Options (comma separated)</label>
          <input className="input" value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Cardiology, Orthopaedics, ENT" />
        </div>
      )}
      {err && <p style={{ color: "var(--red)", fontSize: 13 }}>{err}</p>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Add</button>
      </div>
    </Modal>
  );
}

// ── AI agent ────────────────────────────────────────────────────────────────
function AgentTab() {
  const { org, ui } = useApp();
  const [cfg, setCfg] = useState<Partial<AgentConfig> | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!org) return;
    void supabase
      .from("agent_config")
      // Deliberately NOT selecting the credential columns. This screen has no
      // reason to read them, and not selecting them means they never reach the
      // browser. See RECOVERED-SCHEMA.md on the agent_config exposure.
      .select("org_id, enabled, agent_name, greeting, welcome_message, knowledge, persona, tone, quick_replies, cta_text, widget_color, widget_position, away_message, notify_new_leads, nurture_enabled")
      .eq("org_id", org.id)
      .single()
      .then(({ data }) => setCfg((data as Partial<AgentConfig>) ?? { org_id: org.id, enabled: true }));
  }, [org]);

  const save = async () => {
    if (!org || !cfg) return;
    setSaving(true);
    const { error } = await supabase.from("agent_config").upsert({ ...cfg, org_id: org.id }, { onConflict: "org_id" });
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.show("Agent saved");
  };

  if (!cfg) return <Card><p className="sub">Loading…</p></Card>;

  const set = (patch: Partial<AgentConfig>) => setCfg({ ...cfg, ...patch });

  return (
    <>
      <div className="grid grid-2">
        <Card title="Assistant">
          <div className="field">
            <label className="row" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={cfg.enabled !== false} onChange={(e) => set({ enabled: e.target.checked })} />
              <span style={{ fontWeight: 600 }}>Chat widget enabled</span>
            </label>
          </div>
          <div className="field">
            <label className="label">Assistant name</label>
            <input className="input" value={cfg.agent_name ?? ""} onChange={(e) => set({ agent_name: e.target.value })} placeholder={`${org?.name} Assistant`} />
          </div>
          <div className="field">
            <label className="label">Greeting</label>
            <input className="input" value={cfg.greeting ?? ""} onChange={(e) => set({ greeting: e.target.value })} placeholder="Hi! How can we help?" />
          </div>
          <div className="field">
            <label className="label">Persona</label>
            <textarea className="textarea" value={cfg.persona ?? ""} onChange={(e) => set({ persona: e.target.value })} />
            <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
              Pre-filled from your industry pack, including its safety guardrails. Edit with care —
              the {ui.name.toLowerCase()} persona is written to avoid giving advice it shouldn't.
            </p>
          </div>
          <div className="field">
            <label className="label">Knowledge / instructions</label>
            <textarea className="textarea" value={cfg.knowledge ?? ""} onChange={(e) => set({ knowledge: e.target.value })} placeholder="Services, pricing, timings, locations…" />
          </div>
          <div className="field">
            <label className="label">Quick replies (comma separated)</label>
            <input className="input" value={cfg.quick_replies ?? ""} onChange={(e) => set({ quick_replies: e.target.value })} />
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </Card>

        <Card title="Preview">
          <WidgetPreview
            name={cfg.agent_name || `${org?.name} Assistant`}
            greeting={cfg.greeting || "Hi! How can we help?"}
            color={cfg.widget_color || (ui.accent ?? "#b45309")}
            replies={(cfg.quick_replies ?? "").split(",").map((s) => s.trim()).filter(Boolean)}
          />
          <div className="field" style={{ marginTop: 14 }}>
            <label className="label">Widget colour</label>
            <input className="input" type="color" value={cfg.widget_color || (ui.accent ?? "#b45309")} onChange={(e) => set({ widget_color: e.target.value })} style={{ height: 42, padding: 4 }} />
          </div>
          <div className="field">
            <label className="row" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={!!cfg.notify_new_leads} onChange={(e) => set({ notify_new_leads: e.target.checked })} />
              <span>Telegram alert on every new {ui.leadNoun.toLowerCase()}</span>
            </label>
          </div>
          <div className="field">
            <label className="row" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={cfg.nurture_enabled !== false} onChange={(e) => set({ nurture_enabled: e.target.checked })} />
              <span>Automated follow-up emails</span>
            </label>
          </div>
        </Card>
      </div>
      {toast.node}
    </>
  );
}

function WidgetPreview({ name, greeting, color, replies }: { name: string; greeting: string; color: string; replies: string[] }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden", background: "var(--bg)" }}>
      <div style={{ background: color, color: "#fff", padding: "13px 15px", fontWeight: 700 }}>
        {name}
        <div style={{ fontWeight: 400, fontSize: 12, opacity: 0.9 }}>Typically replies instantly</div>
      </div>
      <div style={{ padding: 15, minHeight: 128 }}>
        <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: "9px 12px", display: "inline-block", maxWidth: "88%" }}>
          {greeting}
        </div>
        {replies.length > 0 && (
          <div className="row-wrap" style={{ marginTop: 11 }}>
            {replies.slice(0, 4).map((r) => (
              <span key={r} className="pill" style={{ background: "#fff", border: `1px solid ${color}`, color }}>{r}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── install ─────────────────────────────────────────────────────────────────
function InstallTab() {
  const { org, ui } = useApp();
  const [copied, setCopied] = useState<string | null>(null);
  const base = window.location.origin;

  const snippet = `<script src="${base}/widget.js" data-org="${org?.slug ?? "your-org"}" defer></script>`;
  const webhook = `${import.meta.env.VITE_SUPABASE_URL ?? "https://pomsltnrxvbcafwtbtlc.supabase.co"}/functions/v1/lead-webhook?key=YOUR_KEY`;

  const copy = async (text: string, which: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="stack">
      <Card title="🚀 Put the assistant on your website">
        <p className="sub" style={{ marginTop: -8, marginBottom: 13 }}>
          Paste this one line before <code>&lt;/body&gt;</code>. It works on any site — WordPress, Shopify,
          Wix, Webflow, or hand-written HTML.
        </p>
        <div className="code">{snippet}</div>
        <div className="row" style={{ marginTop: 11 }}>
          <button className="btn btn-primary" onClick={() => void copy(snippet, "widget")}>
            {copied === "widget" ? "✓ Copied" : "Copy snippet"}
          </button>
        </div>
        <ol className="sub" style={{ marginTop: 15, paddingLeft: 18, lineHeight: 1.75 }}>
          <li>Copy the line above.</li>
          <li>Paste it into your site's footer or custom-code area.</li>
          <li>Publish. The assistant appears immediately — no build, no plugin.</li>
          <li>Every conversation that leaves a phone or email becomes a {ui.leadNoun.toLowerCase()} here automatically.</li>
        </ol>
      </Card>

      <Card title="🔗 Send leads from anywhere else">
        <p className="sub" style={{ marginTop: -8, marginBottom: 13 }}>
          Point any form, ad platform or automation at this URL and the {ui.leadNoun.toLowerCase()} lands in
          your pipeline — scored, assigned and alerted. Create a key under webhook keys first.
        </p>
        <div className="code">{webhook}</div>
        <div className="row" style={{ marginTop: 11 }}>
          <button className="btn" onClick={() => void copy(webhook, "hook")}>
            {copied === "hook" ? "✓ Copied" : "Copy webhook URL"}
          </button>
        </div>
        <p className="sub" style={{ marginTop: 13, fontSize: 12 }}>
          Accepts JSON with any of: <code>name</code>, <code>email</code>, <code>phone</code>,
          <code> message</code>, <code>country</code>, <code>course</code>. WhatsApp (Meta and Twilio
          shapes) is detected automatically.
        </p>
      </Card>
    </div>
  );
}
