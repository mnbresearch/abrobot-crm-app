// AbroBot CRM — automation action execution.
//
// Extracted so the SAME code path runs whether an automation is fired by cron
// (run-automations) or inline by an event (lead-webhook, chat-agent). Two
// implementations of "what does set_stage mean" would drift, and drift in an
// engine that acts unattended on customer data is how you get support tickets
// nobody can reproduce.
//
// ────────────────────────────────────────────────────────────────────────────
// Three things in here look like boilerplate and are not.
//
// 1. EVERY database call is error-checked. postgrest-js does not throw on a
//    failed statement — it RESOLVES with `{ data: null, error }`. So the
//    obvious `await supabase.from("leads").update(...)` swallows rejections
//    completely, and for most of this file's life it did: `ok` was recorded
//    `true` for actions that had done nothing at all. That blind spot became
//    load-bearing the moment trg_guard_lead_assignee started rejecting an
//    assign_to pointing at another org's user — the guard fires, the write is
//    refused, and the run is logged as a success.
//
// 2. A FATAL failure aborts the rest of the rule. A rule is an ordered list the
//    customer wrote: "move to Qualified, then tell me on Telegram". If the
//    stage move fails, sending the alert is worse than sending nothing, because
//    the alert announces something that did not happen. `taken` then reads as a
//    prefix — what actually ran, in order — which is what makes
//    automation_runs.actions_taken usable when someone asks why.
//
//    Non-fatal failures exist too, and the distinction matters. An action this
//    build has never implemented is not evidence that the lead is in a bad
//    state, so it must not truncate a rule the customer has been running for
//    months. It is reported and the rule continues.
//
// 3. Failure messages are coerced with `||`, never `??`. An empty-string detail
//    is falsy, and `??` would let it through as "no failure" — the same
//    swallow this file exists to prevent, reintroduced by an operator choice.
// ────────────────────────────────────────────────────────────────────────────

import { conditionsPass, triggerFires, type Automation } from "./automations.ts";
import { notifyNewLead } from "./notify.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Lead = Record<string, any>;
// deno-lint-ignore no-explicit-any
type Step = Record<string, any>;

export interface ActionOutcome {
  taken: unknown[];
  ok: boolean;
  detail: string | null;
}

/**
 * Per-batch scratch space.
 *
 * Only assignment load lives here, and only because round-robin is quadratic
 * without it: org_assignment_load() aggregates profiles × leads for the whole
 * organisation, and it was being called once per lead. A page of 500 leads
 * matching an assign_round_robin rule meant 500 full aggregations.
 *
 * Fetched once per batch and then kept current locally — each pick increments
 * that member's count and the list is re-sorted, so the second lead in the
 * batch still goes to the next-lightest person rather than piling onto the one
 * who was lightest when the batch started.
 */
export interface ExecContext {
  load?: { user_id: string; open_leads: number }[];
}

interface StepResult {
  error: string | null;
  /** A fatal failure stops the rest of the rule. Default true. */
  fatal?: boolean;
}

const OK: StepResult = { error: null };

/**
 * Lightest first, ties broken by user id.
 *
 * The id tiebreak is not cosmetic. Sorting on the count alone is not a total
 * order, and Array#sort is stable — so once two members were level, the one
 * just assigned stayed at the front of the list and took the next lead as well.
 * Round-robin quietly became "give the next two to the same person".
 *
 * It also matches org_assignment_load()'s own `order by open_leads asc, p.id
 * asc`, so the batch-local view and the database agree on who is next.
 */
function sortLoad(load: { user_id: string; open_leads: number }[]) {
  load.sort((x, y) =>
    Number(x.open_leads) - Number(y.open_leads) || x.user_id.localeCompare(y.user_id));
}

async function runStep(
  supabase: Db,
  orgId: string,
  lead: Lead,
  automation: Automation,
  step: Step,
  now: Date,
  ctx?: ExecContext,
): Promise<StepResult> {
  switch (step.action) {
    case "set_stage": {
      const { error } = await supabase.from("leads")
        .update({ stage_key: String(step.value), updated_at: now.toISOString() })
        .eq("id", lead.id);
      if (error) return { error: `set_stage failed: ${error.message || "unknown error"}` };

      // Not fatal. The stage did move; abandoning the customer's remaining
      // steps over a missing timeline entry would be the wrong trade.
      const { error: actErr } = await supabase.from("activities").insert({
        org_id: orgId, lead_id: lead.id, type: "stage_change",
        content: `Moved to ${step.value} by automation "${automation.name}".`,
      });
      if (actErr) console.error("set_stage: timeline entry failed:", actErr.message);
      return OK;
    }

    case "assign_round_robin": {
      // Counted in the database. This used to fetch every assigned lead in the
      // org and tally them here — with no .limit(), so PostgREST's max-rows
      // silently truncated it at 1,000 and past that point "round-robin"
      // quietly became "whoever looked idle in an arbitrary thousand rows".
      //
      // org_assignment_load() also reads won/lost from the org's OWN
      // pipeline_stages instead of the hardcoded ('enrolled','lost') pair,
      // which only exists in the study-abroad pack.
      // Fetched at most once per batch. Without a ctx (the event path, which
      // handles exactly one lead) that is once, which is the same thing.
      let load = ctx?.load;
      if (!load) {
        const { data, error } = await supabase.rpc("org_assignment_load", { p_org_id: orgId });
        if (error) return { error: `could not compute assignment load: ${error.message || "unknown error"}` };
        load = (data as { user_id: string; open_leads: number }[] | null) ?? [];
        if (ctx) ctx.load = load;
      }

      const pick = load[0]?.user_id;
      if (!pick) return { error: "no active member to assign to" };

      const { error } = await supabase.from("leads")
        .update({ assigned_to: pick }).eq("id", lead.id);
      if (error) return { error: `assign_round_robin failed: ${error.message || "unknown error"}` };

      // Keep the batch's view current so the next lead does not also go to the
      // person who was lightest a moment ago.
      //
      // Known limit: a set_stage step in the same batch that moves a lead into
      // a won or lost stage changes that assignee's real open count, and this
      // snapshot never learns. It self-corrects on the next page. Re-reading
      // per lead would be exact and would also mean 500 full aggregations per
      // page, which is what this cache exists to stop.
      load[0].open_leads = Number(load[0].open_leads ?? 0) + 1;
      sortLoad(load);

      // user_id stays null: an automation did this, not the assignee. Stamping
      // their id here would put "assigned this record" in their own activity
      // feed as though they had done it themselves.
      const { error: actErr } = await supabase.from("activities").insert({
        org_id: orgId, lead_id: lead.id, type: "assignment",
        content: `Assigned by automation "${automation.name}".`,
      });
      if (actErr) console.error("assign_round_robin: timeline entry failed:", actErr.message);
      return OK;
    }

    case "assign_to": {
      // step.value is whatever the tenant typed into their own rule, so this is
      // the path trg_guard_lead_assignee exists to catch. Surfacing the error
      // is the entire point — the guard's message names the problem.
      const { error } = await supabase.from("leads")
        .update({ assigned_to: String(step.value) }).eq("id", lead.id);
      if (error) return { error: `assign_to failed: ${error.message || "unknown error"}` };
      // A local load snapshot is now stale by one.
      if (ctx?.load) {
        const row = ctx.load.find((r) => r.user_id === String(step.value));
        if (row) {
          row.open_leads = Number(row.open_leads ?? 0) + 1;
          sortLoad(ctx.load);
        }
      }
      return OK;
    }

    case "set_score": {
      const { error } = await supabase.from("leads")
        .update({ score: Number(step.value) || 0 }).eq("id", lead.id);
      if (error) return { error: `set_score failed: ${error.message || "unknown error"}` };
      return OK;
    }

    case "add_tag": {
      const tag = String(step.value ?? "").trim();
      if (!tag) return { error: "add_tag has no tag to add", fatal: false };
      const tags: string[] = Array.isArray(lead.tags) ? lead.tags : [];
      if (tags.includes(tag)) return OK; // already there; nothing to write
      const { error } = await supabase.from("leads")
        .update({ tags: [...tags, tag] }).eq("id", lead.id);
      if (error) return { error: `add_tag failed: ${error.message || "unknown error"}` };
      return OK;
    }

    case "set_follow_up": {
      const at = new Date(now.getTime() + (Number(step.value) || 24) * 3600_000);
      const { error } = await supabase.from("leads")
        .update({ next_follow_up_at: at.toISOString() }).eq("id", lead.id);
      if (error) return { error: `set_follow_up failed: ${error.message || "unknown error"}` };
      return OK;
    }

    case "add_note": {
      const { error } = await supabase.from("activities").insert({
        org_id: orgId, lead_id: lead.id, type: "note",
        content: String(step.value ?? `Flagged by automation "${automation.name}".`),
      });
      if (error) return { error: `add_note failed: ${error.message || "unknown error"}` };
      return OK;
    }

    case "notify_telegram": {
      const res = await notifyNewLead(supabase, orgId, {
        id: lead.id, name: lead.name, email: lead.email, phone: lead.phone,
        source: lead.source, score: lead.score,
        message: `Automation "${automation.name}" fired.`,
      });
      // "not configured" is a choice, not a fault. Only a real send failure
      // counts against the run — and `||`, not `??`: notify.ts scrubs the bot
      // token out of the detail and can hand back an empty string, which `??`
      // would pass through as success.
      if (!res.sent && res.reason === "error") {
        return { error: res.detail || "telegram send failed" };
      }
      return OK;
    }

    case "send_email_template":
      // Deliberately not implemented. Unattended sending needs the unsubscribe
      // and rate handling the nurture function already owns; duplicating it
      // risks mailing a lead who opted out.
      //
      // Explicitly NON-FATAL. A customer whose rule is [send_email_template,
      // set_stage, notify_telegram] has been getting steps 2 and 3 for months.
      // Treating a permanently-unimplemented action as fatal would silently
      // stop those the day this shipped.
      return { error: "send_email_template is not wired to the mailer", fatal: false };

    default:
      // Previously this fell through the switch and was then recorded as taken,
      // so a typo in a rule — or an action name from a newer build — was logged
      // as having executed successfully. Non-fatal for the same reason as
      // above: an unknown name says nothing about the lead's state.
      return { error: `unknown action "${String(step.action)}"`, fatal: false };
  }
}

/** Execute one automation's actions against one lead. Never throws. */
export async function executeActions(
  supabase: Db,
  orgId: string,
  lead: Lead,
  automation: Automation,
  now = new Date(),
  ctx?: ExecContext,
): Promise<ActionOutcome> {
  const taken: unknown[] = [];
  let ok = true;
  let detail: string | null = null;

  for (const step of automation.actions ?? []) {
    let res: StepResult;
    try {
      res = await runStep(supabase, orgId, lead, automation, step, now, ctx);
    } catch (e) {
      // `||`, not `??`. A thrown non-Error, or an Error with an empty message,
      // produces an empty string — which `??` would treat as no failure at all.
      res = { error: (e as Error)?.message || "action threw" };
    }

    if (res.error) {
      ok = false;
      detail = detail ? `${detail}; ${res.error}` : res.error;
      if (res.fatal !== false) break; // later steps assume the earlier ones happened
      continue; // reported, but the rule carries on — and NOT counted as taken
    }
    taken.push(step);
  }

  return { taken, ok, detail };
}

/**
 * Fire event-driven automations (lead_created / stage_changed) for one lead.
 *
 * Best-effort by design: intake must never fail because a rule misbehaved.
 * A lead that reaches the database without its automation is recoverable;
 * a lead rejected at the webhook because of a bad rule is lost forever.
 */
export async function fireEventAutomations(
  supabase: Db,
  orgId: string,
  lead: Lead,
  event: "lead_created" | "stage_changed",
  now = new Date(),
): Promise<{ fired: number }> {
  try {
    const { data: autos, error: autoErr } = await supabase
      .from("automations")
      .select("*")
      .eq("org_id", orgId)
      .eq("enabled", true)
      .eq("trigger", event);

    if (autoErr) {
      console.error("event automations: rule lookup failed:", autoErr.message);
      return { fired: 0 };
    }
    if (!autos?.length) return { fired: 0 };

    let fired = 0;
    for (const a of autos as Automation[]) {
      // Cooldown: has this rule already run for this lead recently? Bounded to
      // one row by construction, so unlike the cron path's old query this was
      // never at risk of max-rows truncation. The explicit ordering is what was
      // missing — without it "the one row" was an arbitrary row, and the two
      // paths answered the same question differently.
      //
      // The floor is a loop breaker. A stage_changed rule whose action is
      // set_stage re-triggers itself through the leads trigger; with
      // cooldown_hours = 0 — a legitimate setting meaning "no cooldown" — two
      // such rules ping-pong a lead between stages forever, one edge-function
      // invocation per hop. One minute is short enough to be invisible for
      // ordinary use and long enough that a loop cannot run away.
      const effectiveMs = Math.max(Math.max(0, a.cooldown_hours) * 3600_000, 60_000);
      const since = new Date(now.getTime() - effectiveMs).toISOString();
      const { data: recent, error: recentErr } = await supabase
        .from("automation_runs")
        .select("created_at")
        .eq("automation_id", a.id)
        .eq("lead_id", lead.id)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1);

      if (recentErr) {
        // Fail closed. No cooldown state reads as "never ran", and carrying on
        // would re-fire a rule that already ran for this lead.
        console.error(`cooldown lookup failed for "${a.name}", skipping:`, recentErr.message);
        continue;
      }

      // One check, not two. `effectiveMs >= cooldown_hours * 3600_000` always,
      // so a follow-up `inCooldown(last, a.cooldown_hours, now)` could never
      // be true here — it read as a safety net and was dead code.
      const last = recent?.[0]?.created_at;
      if (last && now.getTime() - new Date(last).getTime() < effectiveMs) continue;
      if (!triggerFires(a, lead, now, event)) continue;
      if (!conditionsPass(lead, a.conditions ?? [])) continue;

      const outcome = await executeActions(supabase, orgId, lead, a, now);

      // Checked, because this row IS the cooldown. If it silently fails to
      // land, the next event sees "never ran" and fires the rule again — the
      // duplicate-firing bug this engine has already had once.
      const { error: runErr } = await supabase.from("automation_runs").insert({
        org_id: orgId, automation_id: a.id, lead_id: lead.id,
        actions_taken: outcome.taken, ok: outcome.ok, detail: outcome.detail,
      });
      if (runErr) {
        console.error(
          `automation_runs insert failed for "${a.name}" — this rule may re-fire for lead ${lead.id}:`,
          runErr.message,
        );
      }
      fired++;
    }
    return { fired };
  } catch (e) {
    console.error("event automations failed (lead still saved):", (e as Error).message);
    return { fired: 0 };
  }
}
