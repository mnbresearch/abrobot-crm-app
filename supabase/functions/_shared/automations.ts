// AbroBot CRM — automation rule evaluation.
//
// Deliberately a small, closed expression language rather than anything
// eval-like. Three reasons:
//   1. it runs server-side with the service role, so arbitrary code is a
//      non-starter
//   2. every condition must be renderable back into plain English for the UI —
//      an automation a manager cannot read is one they will not trust
//   3. it keeps evaluation pure, so it can be unit tested without a database
//
// This module decides WHAT should happen. Applying it is the caller's job.

export type Op = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "is_empty" | "not_empty";

export interface Condition {
  field: string;
  op: Op;
  value?: string | number | boolean | null;
}

export type TriggerKind =
  | "lead_created" | "stage_changed" | "no_contact_for"
  | "follow_up_overdue" | "score_above" | "score_below";

export interface ActionSpec {
  action:
    | "set_stage" | "assign_to" | "assign_round_robin" | "set_score" | "add_tag"
    | "set_follow_up" | "notify_telegram" | "send_email_template" | "add_note";
  value?: string | number | null;
}

export interface Automation {
  id: string;
  org_id: string;
  name: string;
  enabled: boolean;
  trigger: TriggerKind;
  trigger_value: number | null;
  conditions: Condition[];
  actions: ActionSpec[];
  cooldown_hours: number;
  run_count?: number;
  last_run_at?: string | null;
}

// deno-lint-ignore no-explicit-any
export type LeadLike = Record<string, any>;

const HOUR = 3600_000;

/** Resolve a field path against a lead, including custom.* keys. */
export function readField(lead: LeadLike, field: string): unknown {
  if (field.startsWith("custom.")) return lead.custom?.[field.slice(7)];
  if (field === "stage") return lead.stage_key ?? lead.stage;
  return lead[field];
}

export function testCondition(lead: LeadLike, c: Condition): boolean {
  const raw = readField(lead, c.field);

  if (c.op === "is_empty") return raw === null || raw === undefined || raw === "";
  if (c.op === "not_empty") return !(raw === null || raw === undefined || raw === "");

  // Numeric comparison when both sides look numeric, string compare otherwise.
  const bothNumeric = typeof raw !== "boolean" && raw !== null && raw !== undefined &&
    !Number.isNaN(Number(raw)) && !Number.isNaN(Number(c.value));

  if (bothNumeric) {
    const a = Number(raw), b = Number(c.value);
    switch (c.op) {
      case "eq": return a === b;
      case "neq": return a !== b;
      case "gt": return a > b;
      case "gte": return a >= b;
      case "lt": return a < b;
      case "lte": return a <= b;
      case "contains": return String(a).includes(String(b));
    }
  }

  const a = String(raw ?? "").toLowerCase();
  const b = String(c.value ?? "").toLowerCase();
  switch (c.op) {
    case "eq": return a === b;
    case "neq": return a !== b;
    case "contains": return a.includes(b);
    // ordering comparisons on non-numeric values are meaningless — say no
    // rather than guessing, so a misconfigured rule stays inert.
    default: return false;
  }
}

export function conditionsPass(lead: LeadLike, conditions: Condition[]): boolean {
  return (conditions ?? []).every((c) => testCondition(lead, c));
}

/**
 * Does this automation's trigger fire for this lead right now?
 * `event` is supplied for event-driven calls (lead_created, stage_changed);
 * time-based triggers ignore it.
 */
export function triggerFires(
  a: Automation,
  lead: LeadLike,
  now = new Date(),
  event?: "lead_created" | "stage_changed",
): boolean {
  const v = Number(a.trigger_value ?? 0);

  switch (a.trigger) {
    case "lead_created":
      return event === "lead_created";

    case "stage_changed":
      return event === "stage_changed";

    case "score_above":
      return Number(lead.score ?? 0) > v;

    case "score_below":
      return Number(lead.score ?? 0) < v;

    case "follow_up_overdue": {
      if (!lead.next_follow_up_at) return false;
      const due = new Date(lead.next_follow_up_at).getTime();
      // v = grace hours past the due time
      return now.getTime() - due >= v * HOUR;
    }

    case "no_contact_for": {
      // Falls back to created_at when a lead has never been contacted —
      // otherwise brand-new leads would never trigger a chase rule.
      const last = lead.last_contacted_at ?? lead.created_at;
      if (!last) return false;
      return now.getTime() - new Date(last).getTime() >= v * HOUR;
    }
  }
}

/** Cooldown check — has this rule already fired for this lead recently? */
export function inCooldown(lastRunAt: string | null | undefined, cooldownHours: number, now = new Date()): boolean {
  if (!lastRunAt) return false;
  return now.getTime() - new Date(lastRunAt).getTime() < Math.max(0, cooldownHours) * HOUR;
}

/** Should this automation act on this lead? Combines all the gates. */
export function shouldRun(
  a: Automation,
  lead: LeadLike,
  lastRunAt: string | null | undefined,
  now = new Date(),
  event?: "lead_created" | "stage_changed",
): boolean {
  if (!a.enabled) return false;
  if (inCooldown(lastRunAt, a.cooldown_hours, now)) return false;
  if (!triggerFires(a, lead, now, event)) return false;
  return conditionsPass(lead, a.conditions ?? []);
}

// ── plain-English rendering (shared with the UI) ─────────────────────────────

const OP_WORDS: Record<Op, string> = {
  eq: "is", neq: "is not", gt: "is more than", gte: "is at least",
  lt: "is less than", lte: "is at most", contains: "contains",
  is_empty: "is empty", not_empty: "is not empty",
};

export function describeTrigger(a: Pick<Automation, "trigger" | "trigger_value">): string {
  const v = a.trigger_value ?? 0;
  switch (a.trigger) {
    case "lead_created": return "When a record is created";
    case "stage_changed": return "When the stage changes";
    case "no_contact_for": return `When there has been no contact for ${v} hours`;
    case "follow_up_overdue": return `When a follow-up is ${v} hours overdue`;
    case "score_above": return `When the score goes above ${v}`;
    case "score_below": return `When the score is below ${v}`;
  }
}

export function describeCondition(c: Condition): string {
  const field = c.field.replace(/^custom\./, "").replace(/_/g, " ");
  if (c.op === "is_empty" || c.op === "not_empty") return `${field} ${OP_WORDS[c.op]}`;
  return `${field} ${OP_WORDS[c.op]} ${c.value}`;
}

export function describeAction(a: ActionSpec): string {
  switch (a.action) {
    case "set_stage": return `move to ${a.value}`;
    case "assign_to": return `assign to a specific member`;
    case "assign_round_robin": return `assign to the least-loaded member`;
    case "set_score": return `set score to ${a.value}`;
    case "add_tag": return `add tag "${a.value}"`;
    case "set_follow_up": return `schedule a follow-up in ${a.value} hours`;
    case "notify_telegram": return `send a Telegram alert`;
    case "send_email_template": return `send the "${a.value}" email template`;
    case "add_note": return `add a note`;
  }
}

export function describeAutomation(a: Automation): string {
  const parts = [describeTrigger(a)];
  if (a.conditions?.length) parts.push(`and ${a.conditions.map(describeCondition).join(", and ")}`);
  parts.push(`→ ${(a.actions ?? []).map(describeAction).join(", then ")}`);
  return parts.join(" ");
}
