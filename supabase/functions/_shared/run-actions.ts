// AbroBot CRM — automation action execution.
//
// Extracted so the SAME code path runs whether an automation is fired by cron
// (run-automations) or inline by an event (lead-webhook, chat-agent). Two
// implementations of "what does set_stage mean" would drift, and drift in an
// engine that acts unattended on customer data is how you get support tickets
// nobody can reproduce.

import { conditionsPass, triggerFires, inCooldown, type Automation } from "./automations.ts";
import { notifyNewLead } from "./notify.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Lead = Record<string, any>;

export interface ActionOutcome {
  taken: unknown[];
  ok: boolean;
  detail: string | null;
}

/** Execute one automation's actions against one lead. Never throws. */
export async function executeActions(
  supabase: Db,
  orgId: string,
  lead: Lead,
  automation: Automation,
  now = new Date(),
): Promise<ActionOutcome> {
  const taken: unknown[] = [];
  let ok = true;
  let detail: string | null = null;

  for (const step of automation.actions ?? []) {
    try {
      switch (step.action) {
        case "set_stage": {
          await supabase.from("leads")
            .update({ stage_key: String(step.value), updated_at: now.toISOString() })
            .eq("id", lead.id);
          await supabase.from("activities").insert({
            org_id: orgId, lead_id: lead.id, type: "stage_change",
            content: `Moved to ${step.value} by automation "${automation.name}".`,
          });
          break;
        }

        case "assign_round_robin": {
          const { data: team } = await supabase
            .from("profiles").select("id").eq("org_id", orgId).eq("status", "active");
          if (team?.length) {
            const { data: assigned } = await supabase
              .from("leads").select("assigned_to").eq("org_id", orgId).not("assigned_to", "is", null);
            const load: Record<string, number> = Object.fromEntries(team.map((t: Lead) => [t.id, 0]));
            (assigned ?? []).forEach((l: Lead) => {
              if (l.assigned_to && l.assigned_to in load) load[l.assigned_to]++;
            });
            const pick = team.sort((a: Lead, b: Lead) => load[a.id] - load[b.id])[0].id;
            await supabase.from("leads").update({ assigned_to: pick }).eq("id", lead.id);
            await supabase.from("activities").insert({
              org_id: orgId, lead_id: lead.id, user_id: pick, type: "assignment",
              content: `Assigned by automation "${automation.name}".`,
            });
          }
          break;
        }

        case "assign_to": {
          await supabase.from("leads").update({ assigned_to: String(step.value) }).eq("id", lead.id);
          break;
        }

        case "set_score": {
          await supabase.from("leads").update({ score: Number(step.value) || 0 }).eq("id", lead.id);
          break;
        }

        case "add_tag": {
          const tags: string[] = Array.isArray(lead.tags) ? lead.tags : [];
          const tag = String(step.value);
          if (tag && !tags.includes(tag)) {
            await supabase.from("leads").update({ tags: [...tags, tag] }).eq("id", lead.id);
          }
          break;
        }

        case "set_follow_up": {
          const at = new Date(now.getTime() + (Number(step.value) || 24) * 3600_000);
          await supabase.from("leads").update({ next_follow_up_at: at.toISOString() }).eq("id", lead.id);
          break;
        }

        case "add_note": {
          await supabase.from("activities").insert({
            org_id: orgId, lead_id: lead.id, type: "note",
            content: String(step.value ?? `Flagged by automation "${automation.name}".`),
          });
          break;
        }

        case "notify_telegram": {
          const res = await notifyNewLead(supabase, orgId, {
            id: lead.id, name: lead.name, email: lead.email, phone: lead.phone,
            source: lead.source, score: lead.score,
            message: `Automation "${automation.name}" fired.`,
          });
          if (!res.sent && res.reason === "error") {
            ok = false;
            detail = res.detail ?? "telegram failed";
          }
          break;
        }

        case "send_email_template": {
          // Deliberately not implemented. Unattended sending needs the
          // unsubscribe and rate handling the nurture function already owns;
          // duplicating it risks mailing a lead who opted out.
          ok = false;
          detail = "send_email_template is not wired to the mailer";
          break;
        }
      }
      taken.push(step);
    } catch (e) {
      ok = false;
      detail = (e as Error).message;
    }
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
    const { data: autos } = await supabase
      .from("automations")
      .select("*")
      .eq("org_id", orgId)
      .eq("enabled", true)
      .eq("trigger", event);

    if (!autos?.length) return { fired: 0 };

    let fired = 0;
    for (const a of autos as Automation[]) {
      // cooldown: has this rule already run for this lead recently?
      const since = new Date(now.getTime() - Math.max(0, a.cooldown_hours) * 3600_000).toISOString();
      const { data: recent } = await supabase
        .from("automation_runs")
        .select("created_at")
        .eq("automation_id", a.id)
        .eq("lead_id", lead.id)
        .gte("created_at", since)
        .limit(1);

      if (inCooldown(recent?.[0]?.created_at, a.cooldown_hours, now)) continue;
      if (!triggerFires(a, lead, now, event)) continue;
      if (!conditionsPass(lead, a.conditions ?? [])) continue;

      const outcome = await executeActions(supabase, orgId, lead, a, now);
      await supabase.from("automation_runs").insert({
        org_id: orgId, automation_id: a.id, lead_id: lead.id,
        actions_taken: outcome.taken, ok: outcome.ok, detail: outcome.detail,
      });
      fired++;
    }
    return { fired };
  } catch (e) {
    console.error("event automations failed (lead still saved):", (e as Error).message);
    return { fired: 0 };
  }
}
