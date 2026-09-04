// AbroBot CRM — automation runner.
// Deploy:  supabase functions deploy run-automations --no-verify-jwt
// Schedule: every 15 minutes (Supabase cron or any external scheduler)
//
// POST {}                    -> run time-based rules for every active org
// POST { org: "slug" }       -> run for one org
// POST { org, dry_run: true } -> report what WOULD happen, change nothing
//
// Event-driven triggers (lead_created, stage_changed) are fired inline by
// lead-webhook and chat-agent; this function owns the time-based ones
// (no_contact_for, follow_up_overdue, score_above/below).
//
// Safety properties that matter for something running unattended on customer
// data:
//   * cooldown per (automation, lead) so a rule cannot spam the same record
//   * every run written to automation_runs, success or failure
//   * a failing action logs and continues rather than aborting the batch
//   * dry_run for testing a rule against real data before arming it

import { createClient } from "npm:@supabase/supabase-js@2";
import { shouldRun, type Automation } from "../_shared/automations.ts";
import { notifyNewLead } from "../_shared/notify.ts";

import { requireCronSecret } from "../_shared/cron-auth.ts";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

const TIME_TRIGGERS = ["no_contact_for", "follow_up_overdue", "score_above", "score_below"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // Scheduled endpoint. Deployed --no-verify-jwt because pg_cron carries no
  // Supabase JWT, so a shared secret is the boundary. See _shared/cron-auth.ts.
  const cronAuth = requireCronSecret(req, CORS);
  if (!cronAuth.ok) return cronAuth.response!;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is the cron case */ }
  const dryRun = body?.dry_run === true;

  let orgQuery = supabase.from("organizations").select("id, slug, name").eq("active", true);
  if (body?.org) orgQuery = orgQuery.eq("slug", body.org);
  const { data: orgs } = await orgQuery;

  const now = new Date();
  const report: unknown[] = [];
  let fired = 0;

  for (const org of orgs ?? []) {
    const { data: autos } = await supabase
      .from("automations")
      .select("*")
      .eq("org_id", org.id)
      .eq("enabled", true)
      .in("trigger", TIME_TRIGGERS);

    if (!autos?.length) continue;

    const { data: stages } = await supabase
      .from("pipeline_stages").select("key, is_won, is_lost").eq("org_id", org.id);
    const terminal = new Set((stages ?? []).filter((s) => s.is_won || s.is_lost).map((s) => s.key));

    const { data: leads } = await supabase
      .from("leads").select("*").eq("org_id", org.id).limit(5000);

    // Open records only — chasing a won or lost lead is noise.
    const open = (leads ?? []).filter((l) => !terminal.has(l.stage_key ?? l.stage));

    for (const a of autos as Automation[]) {
      // Cooldown state for this rule, in one query rather than per lead.
      const since = new Date(now.getTime() - Math.max(0, a.cooldown_hours) * 3600_000).toISOString();
      const { data: recent } = await supabase
        .from("automation_runs")
        .select("lead_id, created_at")
        .eq("automation_id", a.id)
        .gte("created_at", since);
      const lastRun = new Map<string, string>();
      (recent ?? []).forEach((r) => { if (r.lead_id) lastRun.set(r.lead_id, r.created_at); });

      for (const lead of open) {
        if (!shouldRun(a, lead, lastRun.get(lead.id), now)) continue;

        if (dryRun) {
          report.push({ automation: a.name, lead: lead.name, would_run: a.actions });
          fired++;
          continue;
        }

        const taken: unknown[] = [];
        let ok = true;
        let detail: string | null = null;

        try {
          for (const step of a.actions ?? []) {
            switch (step.action) {
              case "set_stage": {
                await supabase.from("leads")
                  .update({ stage_key: String(step.value), updated_at: now.toISOString() })
                  .eq("id", lead.id);
                await supabase.from("activities").insert({
                  org_id: org.id, lead_id: lead.id, type: "stage_change",
                  content: `Moved to ${step.value} by automation "${a.name}".`,
                });
                break;
              }
              case "assign_round_robin": {
                const { data: team } = await supabase
                  .from("profiles").select("id").eq("org_id", org.id).eq("status", "active");
                if (team?.length) {
                  const { data: openAssigned } = await supabase
                    .from("leads").select("assigned_to").eq("org_id", org.id).not("assigned_to", "is", null);
                  const load: Record<string, number> = Object.fromEntries(team.map((t) => [t.id, 0]));
                  (openAssigned ?? []).forEach((l) => {
                    if (l.assigned_to && l.assigned_to in load) load[l.assigned_to]++;
                  });
                  const pick = team.sort((x, y) => load[x.id] - load[y.id])[0].id;
                  await supabase.from("leads").update({ assigned_to: pick }).eq("id", lead.id);
                  await supabase.from("activities").insert({
                    org_id: org.id, lead_id: lead.id, type: "assignment",
                    content: `Reassigned by automation "${a.name}".`,
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
                if (!tags.includes(String(step.value))) {
                  await supabase.from("leads").update({ tags: [...tags, String(step.value)] }).eq("id", lead.id);
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
                  org_id: org.id, lead_id: lead.id, type: "note",
                  content: String(step.value ?? `Flagged by automation "${a.name}".`),
                });
                break;
              }
              case "notify_telegram": {
                await notifyNewLead(supabase, org.id, {
                  id: lead.id, name: lead.name, email: lead.email, phone: lead.phone,
                  source: lead.source, score: lead.score,
                  message: `Automation "${a.name}" fired for this record.`,
                });
                break;
              }
              case "send_email_template": {
                // Intentionally not implemented here. Sending mail from an
                // unattended loop needs the same unsubscribe and rate handling
                // the nurture function already owns; duplicating it would risk
                // mailing a lead who opted out. Logged so it is visible.
                detail = "send_email_template is not yet wired to the mailer";
                ok = false;
                break;
              }
            }
            taken.push(step);
          }
        } catch (e) {
          ok = false;
          detail = (e as Error).message;
        }

        await supabase.from("automation_runs").insert({
          org_id: org.id, automation_id: a.id, lead_id: lead.id,
          actions_taken: taken, ok, detail,
        });
        fired++;
      }

      if (!dryRun) {
        await supabase.from("automations")
          .update({ run_count: (a.run_count ?? 0) + 1, last_run_at: now.toISOString() })
          .eq("id", a.id);
      }
    }
  }

  return json({ ok: true, dry_run: dryRun, orgs: orgs?.length ?? 0, fired, report: report.slice(0, 50) });
});
