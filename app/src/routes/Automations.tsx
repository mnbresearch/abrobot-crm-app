import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase, callFunction } from "../lib/supabase";
import { Card, Empty, Modal, Spinner, timeAgo, useToast } from "../components/ui";

// The automation builder.
//
// Design rule: every automation must read back as a sentence. If a manager
// cannot glance at the list and understand what will happen to their records,
// they will switch it all off — and an automation engine nobody trusts is
// worse than none, because it acts on customer data unattended.

type Op = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "is_empty" | "not_empty";

interface Condition { field: string; op: Op; value?: string | number | null }
interface ActionSpec { action: string; value?: string | number | null }

interface Automation {
  id: string;
  org_id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  trigger_value: number | null;
  conditions: Condition[];
  actions: ActionSpec[];
  cooldown_hours: number;
  run_count: number;
  last_run_at: string | null;
}

const TRIGGERS = [
  { key: "no_contact_for", label: "No contact for…", unit: "hours", def: 48 },
  { key: "follow_up_overdue", label: "Follow-up overdue by…", unit: "hours", def: 0 },
  { key: "score_above", label: "Score goes above…", unit: "points", def: 70 },
  { key: "score_below", label: "Score is below…", unit: "points", def: 30 },
  { key: "lead_created", label: "A record is created", unit: null, def: 0 },
  { key: "stage_changed", label: "The stage changes", unit: null, def: 0 },
];

// `label` is what the dropdown shows; `tpl` is how it reads back in the
// plain-English summary, with {v} substituted. Keeping them separate avoids
// the mangled phrasing you get from string-replacing a dropdown label.
const ACTIONS = [
  { key: "assign_round_robin", label: "Assign to least-loaded member", needs: null, tpl: "assign to the least-loaded member" },
  { key: "set_stage", label: "Move to stage", needs: "stage", tpl: "move to {v}" },
  { key: "set_follow_up", label: "Schedule follow-up in… hours", needs: "number", tpl: "schedule a follow-up in {v} hours" },
  { key: "add_tag", label: "Add tag", needs: "text", tpl: 'add the tag "{v}"' },
  { key: "add_note", label: "Add a note", needs: "text", tpl: "add a note" },
  { key: "notify_telegram", label: "Send Telegram alert", needs: null, tpl: "send a Telegram alert" },
  { key: "set_score", label: "Set score to", needs: "number", tpl: "set the score to {v}" },
];

const OPS: { key: Op; label: string }[] = [
  { key: "eq", label: "is" },
  { key: "neq", label: "is not" },
  { key: "gt", label: "is more than" },
  { key: "lt", label: "is less than" },
  { key: "contains", label: "contains" },
  { key: "is_empty", label: "is empty" },
  { key: "not_empty", label: "is not empty" },
];

// A few rules worth having on day one, phrased for the industry in question.
const RECIPES = [
  {
    name: "Chase silent hot records",
    trigger: "no_contact_for", trigger_value: 48,
    conditions: [{ field: "score", op: "gt" as Op, value: 60 }],
    actions: [{ action: "notify_telegram" }, { action: "set_follow_up", value: 4 }],
    why: "High-intent records going quiet is the most expensive failure mode in any pipeline.",
  },
  {
    name: "Round-robin new records",
    trigger: "lead_created", trigger_value: 0,
    conditions: [],
    actions: [{ action: "assign_round_robin" }],
    why: "Nothing sits unowned. Whoever has the lightest load picks it up.",
  },
  {
    name: "Flag stalled records",
    trigger: "no_contact_for", trigger_value: 168,
    conditions: [],
    actions: [{ action: "add_tag", value: "stalled" }, { action: "add_note", value: "No contact for a week." }],
    why: "A weekly sweep so dead weight is visible instead of quietly padding your pipeline.",
  },
  {
    name: "Escalate overdue follow-ups",
    trigger: "follow_up_overdue", trigger_value: 24,
    conditions: [],
    actions: [{ action: "notify_telegram" }],
    why: "A missed follow-up is a promise broken to someone who asked you for help.",
  },
];

export function Automations() {
  const { org, ui, stages, fields, isAdmin } = useApp();
  const [rows, setRows] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Automation> | null>(null);
  const [testing, setTesting] = useState(false);
  const toast = useToast();

  const load = async () => {
    if (!org) return;
    const { data } = await supabase.from("automations").select("*").eq("org_id", org.id).order("created_at");
    setRows((data as Automation[]) ?? []);
    setLoading(false);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [org]);

  const save = async () => {
    if (!org || !editing) return;
    if (!editing.name?.trim()) { toast.error("Give the rule a name"); return; }
    if (!editing.actions?.length) { toast.error("Add at least one action"); return; }

    const payload = {
      org_id: org.id,
      name: editing.name.trim(),
      enabled: editing.enabled ?? true,
      trigger: editing.trigger ?? "no_contact_for",
      trigger_value: Number(editing.trigger_value ?? 0),
      conditions: editing.conditions ?? [],
      actions: editing.actions,
      cooldown_hours: Number(editing.cooldown_hours ?? 24),
    };
    const { error } = editing.id
      ? await supabase.from("automations").update(payload).eq("id", editing.id)
      : await supabase.from("automations").insert(payload);
    if (error) { toast.error(error.message); return; }
    setEditing(null);
    await load();
    toast.show("Rule saved");
  };

  const toggle = async (a: Automation) => {
    const next = !a.enabled;
    // Optimistic: the pill flips immediately. Reloading alone was leaving the
    // card showing the old state even though the write had succeeded, which
    // reads as "the button is broken" — the worst possible impression for a
    // control that arms something acting on customer records.
    setRows((rs) => rs.map((r) => (r.id === a.id ? { ...r, enabled: next } : r)));

    const { error } = await supabase.from("automations").update({ enabled: next }).eq("id", a.id);
    if (error) {
      setRows((rs) => rs.map((r) => (r.id === a.id ? { ...r, enabled: a.enabled } : r))); // roll back
      toast.error(error.message);
      return;
    }
    toast.show(next ? "Rule is now active" : "Rule paused");
    await load();
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from("automations").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    await load();
    toast.show("Rule deleted");
  };

  // Dry run against real records — see what would happen before arming it.
  const dryRun = async () => {
    if (!org) return;
    setTesting(true);
    try {
      const r = await callFunction<{ fired: number; report: { automation: string; lead: string }[] }>(
        "run-automations", { org: org.slug, dry_run: true },
      );
      toast.show(
        r.fired === 0
          ? "Nothing would fire right now"
          : `${r.fired} action(s) would fire — e.g. ${r.report[0]?.automation} on ${r.report[0]?.lead}`,
      );
    } catch (e) {
      toast.error((e as Error).message);
    }
    setTesting(false);
  };

  const describe = (a: Automation | Partial<Automation>): string => {
    const t = TRIGGERS.find((x) => x.key === a.trigger);
    const trig = t?.unit ? `${t.label.replace("…", "")} ${a.trigger_value} ${t.unit}` : t?.label ?? "";
    const conds = (a.conditions ?? []).map((c) => {
      const f = c.field.replace(/^custom\./, "").replace(/_/g, " ");
      const op = OPS.find((o) => o.key === c.op)?.label ?? c.op;
      return c.op === "is_empty" || c.op === "not_empty" ? `${f} ${op}` : `${f} ${op} ${c.value}`;
    });
    const acts = (a.actions ?? []).map((x) => {
      const spec = ACTIONS.find((y) => y.key === x.action);
      if (!spec) return x.action;
      const label = stages.find((s) => s.key === x.value)?.label ?? String(x.value ?? "");
      return spec.tpl.replace("{v}", label);
    });
    return `${trig}${conds.length ? ` and ${conds.join(", and ")}` : ""} → ${acts.join(", then ")}`;
  };

  if (loading) return <Spinner />;

  if (!isAdmin) {
    return <Card><Empty icon="🔒" title="Admins only" hint="Automations act on everyone's records, so only admins can change them." /></Card>;
  }

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1>Automations</h1>
          <p className="sub" style={{ marginTop: 2 }}>
            Rules that run on your {ui.leadNounPlural.toLowerCase()} without anyone remembering to.
          </p>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={dryRun} disabled={testing}>
          {testing ? "Testing…" : "▶ Test run"}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => setEditing({ trigger: "no_contact_for", trigger_value: 48, conditions: [], actions: [], enabled: true, cooldown_hours: 24 })}
        >
          + New rule
        </button>
      </div>

      {rows.length === 0 ? (
        <Card>
          <Empty
            icon="⚡"
            title="No automations yet"
            hint="Start from one of the recipes below — each is a rule most teams end up writing anyway."
          />
        </Card>
      ) : (
        <div className="stack">
          {rows.map((a) => (
            <Card
              key={a.id}
              title={
                <div className="row">
                  <h2>{a.name}</h2>
                  <span className={a.enabled ? "pill pill-green" : "pill pill-muted"}>
                    {a.enabled ? "active" : "paused"}
                  </span>
                </div>
              }
              action={
                <div className="row">
                  <button className="btn btn-sm" onClick={() => void toggle(a)}>{a.enabled ? "Pause" : "Resume"}</button>
                  <button className="btn btn-sm" onClick={() => setEditing(a)}>Edit</button>
                  <button className="btn btn-sm btn-danger" onClick={() => void remove(a.id)}>🗑</button>
                </div>
              }
            >
              <p style={{ margin: 0 }}>{describe(a)}</p>
              <p className="sub" style={{ fontSize: 12, marginTop: 7 }}>
                Won't touch the same record twice within {a.cooldown_hours}h
                {a.last_run_at ? ` · last checked ${timeAgo(a.last_run_at)}` : " · not run yet"}
              </p>
            </Card>
          ))}
        </div>
      )}

      <Card title="Recipes">
        <p className="sub" style={{ marginTop: -8, marginBottom: 13 }}>
          One click to add. Everything is editable afterwards, and new rules start paused so nothing
          touches your records until you say so.
        </p>
        <div className="grid grid-2">
          {RECIPES.map((r) => (
            <div key={r.name} className="card" style={{ background: "var(--bg)" }}>
              <div style={{ fontWeight: 700 }}>{r.name}</div>
              <p className="sub" style={{ fontSize: 12.5, marginTop: 4 }}>{r.why}</p>
              <button
                className="btn btn-sm"
                style={{ marginTop: 9 }}
                onClick={() => setEditing({ ...r, enabled: false, cooldown_hours: 24 })}
              >
                Use this
              </button>
            </div>
          ))}
        </div>
      </Card>

      {editing && (
        <Modal title={editing.id ? "Edit rule" : "New rule"} onClose={() => setEditing(null)} wide>
          <div className="field">
            <label className="label">Name</label>
            <input className="input" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus />
          </div>

          <div className="field">
            <label className="label">When</label>
            <div className="row" style={{ gap: 9 }}>
              <select
                className="select"
                value={editing.trigger}
                onChange={(e) => {
                  const t = TRIGGERS.find((x) => x.key === e.target.value)!;
                  setEditing({ ...editing, trigger: t.key, trigger_value: t.def });
                }}
              >
                {TRIGGERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              {TRIGGERS.find((t) => t.key === editing.trigger)?.unit && (
                <input
                  className="input"
                  type="number"
                  style={{ maxWidth: 120 }}
                  value={editing.trigger_value ?? 0}
                  onChange={(e) => setEditing({ ...editing, trigger_value: Number(e.target.value) })}
                />
              )}
            </div>
          </div>

          <div className="field">
            <label className="label">Only if (optional)</label>
            {(editing.conditions ?? []).map((c, i) => (
              <div className="row" style={{ gap: 7, marginBottom: 7 }} key={i}>
                <select
                  className="select"
                  value={c.field}
                  onChange={(e) => setEditing({ ...editing, conditions: editing.conditions!.map((x, j) => j === i ? { ...x, field: e.target.value } : x) })}
                >
                  <option value="score">score</option>
                  <option value="source">source</option>
                  <option value="stage">stage</option>
                  <option value="email">email</option>
                  <option value="phone">phone</option>
                  {fields.map((f) => <option key={f.key} value={`custom.${f.key}`}>{f.label}</option>)}
                </select>
                <select
                  className="select"
                  style={{ maxWidth: 150 }}
                  value={c.op}
                  onChange={(e) => setEditing({ ...editing, conditions: editing.conditions!.map((x, j) => j === i ? { ...x, op: e.target.value as Op } : x) })}
                >
                  {OPS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
                {c.op !== "is_empty" && c.op !== "not_empty" && (
                  <input
                    className="input"
                    value={String(c.value ?? "")}
                    onChange={(e) => setEditing({ ...editing, conditions: editing.conditions!.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })}
                  />
                )}
                <button className="btn btn-sm btn-ghost" onClick={() => setEditing({ ...editing, conditions: editing.conditions!.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
            <button
              className="btn btn-sm"
              onClick={() => setEditing({ ...editing, conditions: [...(editing.conditions ?? []), { field: "score", op: "gt", value: 50 }] })}
            >
              + Add condition
            </button>
          </div>

          <div className="field">
            <label className="label">Then</label>
            {(editing.actions ?? []).map((a, i) => {
              const spec = ACTIONS.find((x) => x.key === a.action);
              return (
                <div className="row" style={{ gap: 7, marginBottom: 7 }} key={i}>
                  <select
                    className="select"
                    value={a.action}
                    onChange={(e) => setEditing({ ...editing, actions: editing.actions!.map((x, j) => j === i ? { action: e.target.value, value: null } : x) })}
                  >
                    {ACTIONS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </select>
                  {spec?.needs === "stage" && (
                    <select
                      className="select"
                      style={{ maxWidth: 170 }}
                      value={String(a.value ?? "")}
                      onChange={(e) => setEditing({ ...editing, actions: editing.actions!.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })}
                    >
                      <option value="">choose…</option>
                      {stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  )}
                  {(spec?.needs === "number" || spec?.needs === "text") && (
                    <input
                      className="input"
                      style={{ maxWidth: 170 }}
                      type={spec.needs === "number" ? "number" : "text"}
                      value={String(a.value ?? "")}
                      onChange={(e) => setEditing({ ...editing, actions: editing.actions!.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })}
                    />
                  )}
                  <button className="btn btn-sm btn-ghost" onClick={() => setEditing({ ...editing, actions: editing.actions!.filter((_, j) => j !== i) })}>✕</button>
                </div>
              );
            })}
            <button
              className="btn btn-sm"
              onClick={() => setEditing({ ...editing, actions: [...(editing.actions ?? []), { action: "notify_telegram" }] })}
            >
              + Add action
            </button>
          </div>

          <div className="field">
            <label className="label">Don't repeat within (hours)</label>
            <input
              className="input"
              type="number"
              style={{ maxWidth: 140 }}
              value={editing.cooldown_hours ?? 24}
              onChange={(e) => setEditing({ ...editing, cooldown_hours: Number(e.target.value) })}
            />
            <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
              Stops a rule firing repeatedly on the same record.
            </p>
          </div>

          {(editing.actions ?? []).length > 0 && (
            <div style={{ background: "var(--industry-soft)", borderRadius: 12, padding: 12, marginBottom: 13 }}>
              <div className="label" style={{ marginBottom: 3 }}>In plain English</div>
              {describe(editing)}
            </div>
          )}

          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}>Save rule</button>
          </div>
        </Modal>
      )}
      {toast.node}
    </div>
  );
}
