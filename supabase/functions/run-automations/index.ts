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

import { requireCronOrMember } from "../_shared/cron-auth.ts";
import { executeActions, fireEventAutomations, type ExecContext } from "../_shared/run-actions.ts";
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


// The cron-death detector only works if something actually reports in.
// record_heartbeat() shipped with zero callers, so job_heartbeats stayed at
// "never reported" and stale_jobs() flagged every job stale forever — the
// monitoring was itself the thing that was broken.
async function heartbeat(status: string, detail?: string) {
  try {
    // Checked, not just wrapped. postgrest resolves with {error} rather than
    // throwing, so this catch never fired and a failing record_heartbeat was
    // invisible — in the one function whose job is reporting health.
    const { error } = await supabase.rpc("record_heartbeat", {
      p_job: "run-automations", p_status: status, p_detail: detail ?? null,
    });
    if (error) console.warn("heartbeat not recorded:", error.message);
  } catch (e) {
    // Never let reporting health break the work whose health is reported.
    console.warn("heartbeat failed:", (e as Error).message);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // Scheduled endpoint. Deployed --no-verify-jwt because pg_cron carries no
  // Supabase JWT, so a shared secret is the boundary. See _shared/cron-auth.ts.
  const cronAuth = await requireCronOrMember(req, CORS, supabase, { adminOnly: true });
  if (!cronAuth.ok) return cronAuth.response!;
  // When a person called this, they may only act on their OWN org —
  // the org is taken from their token, never from the request body.
  const callerOrgId: string | undefined = cronAuth.orgId;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is the cron case */ }
  const dryRun = body?.dry_run === true;

  // ── Event mode ─────────────────────────────────────────────────────────────
  // The database trigger on leads posts {event, lead_id, org_id} here whenever
  // a record is created or changes stage. That is what makes "when a record is
  // created" rules fire for ALL five intake paths (webhook, chat widget, CSV
  // import, manual add, API) instead of just the webhook, and what makes
  // "when the stage changes" fire at all — nothing dispatched it before.
  //
  // Handled before the time-based sweep because it is a different question:
  // "react to this one record now", not "scan everything for anything due".
  if (body?.event && body?.lead_id) {
    // Scoped IN the query when a person is calling, rather than fetched first
    // and checked afterwards. The old shape answered 403 for a real record in
    // another tenant and 404 for one that does not exist — an existence oracle.
    // UUIDs make that nearly useless in practice, but the filter belongs in
    // the query and costs nothing to put there.
    //
    // callerOrgId is undefined when the database trigger calls this on the
    // service role, which is why the filter is conditional rather than
    // unconditional: the trigger legitimately acts for every org.
    // Soft-deleted leads are invisible to the app but not to the service role.
    let leadQ = supabase.from("leads").select("*").eq("id", body.lead_id).is("deleted_at", null);
    if (callerOrgId) leadQ = leadQ.eq("org_id", callerOrgId);
    const { data: lead, error: leadErr } = await leadQ.maybeSingle();

    if (leadErr || !lead) {
      return json({ ok: false, error: leadErr?.message ?? "lead not found" }, 404);
    }

    // Validate rather than cast. body.event arrives over HTTP, and an
    // unrecognised value should be a clear 400, not an event type the
    // automation engine silently matches nothing against.
    const EVENTS = ["lead_created", "stage_changed"] as const;
    type EventName = typeof EVENTS[number];
    const evt = String(body.event) as EventName;
    if (!EVENTS.includes(evt)) {
      return json({ error: `unknown event "${body.event}"`, valid: EVENTS }, 400);
    }

    const result = await fireEventAutomations(supabase, lead.org_id, lead, evt);
    return json({ ok: true, mode: "event", event: body.event, lead_id: body.lead_id, result });
  }

  // Paged, not `.limit(1000)`.
  //
  // A flat limit here is the same max-rows landmine this change set exists to
  // remove for leads, left in place one level up: org number 1,001 by id would
  // never be fetched, so its automations would never run, permanently and
  // silently. Keyset on the primary key, same as the lead walk below.
  //
  // The query is REBUILT each iteration rather than reused. postgrest-js
  // filter methods mutate the builder and return `this`, so chaining .gt() onto
  // a shared instance would accumulate `id > c1 AND id > c2 AND …` and stack a
  // fresh .order()/.limit() on every pass.
  const orgPage = (cursor: string | null) => {
    // A signed-in caller is pinned to their own org. body.org is only honoured
    // for the scheduler (callerOrgId undefined), which is trusted. Without this
    // pin, an admin of org A could POST {"org":"org-b"} and run automations
    // against another tenant's records — the exact hole the cron secret closed.
    let q = supabase.from("organizations").select("id, slug, name").eq("active", true);
    if (callerOrgId) q = q.eq("id", callerOrgId);
    else if (body?.org) q = q.eq("slug", body.org);
    if (cursor) q = q.gt("id", cursor);
    return q.order("id", { ascending: true }).limit(500);
  };

  const orgRows: { id: string; slug: string; name: string }[] = [];
  let orgErr: { message: string } | null = null;
  let orgCursor: string | null = null;
  for (;;) {
    const { data, error } = await orgPage(orgCursor);
    if (error) { orgErr = error; break; }
    if (!data?.length) break;
    orgRows.push(...data);
    orgCursor = data[data.length - 1].id;
    // Terminates on an EMPTY page, never on a short one — a short page means
    // "max-rows is lower than I asked for", not "that was the last of them".
    // One extra empty query is the price of not re-planting the landmine.
  }

  if (orgErr) {
    // Unchecked, this returned `orgs === undefined`, the loop never ran, and
    // the heartbeat cheerfully reported "0 org(s), 0 fired". A total outage
    // and a quiet night produced identical health records.
    console.error("run-automations: could not list organisations:", orgErr.message);
    await heartbeat("error", `organisation lookup failed: ${orgErr.message}`);
    return json({ ok: false, error: "could not list organisations" }, 500);
  }
  const orgs = orgRows;

  // ── Sweep budget ───────────────────────────────────────────────────────
  //
  // A sweep that runs past the platform's wall clock is killed mid-batch and
  // leaves nothing behind, so it stops itself first. But stopping is only safe
  // because of the RESUME CURSOR below: without one, stopping at a time limit
  // replaces "an arbitrary thousand leads are visible" with something worse —
  // the same deterministic prefix visible on every single sweep, and the
  // records after it never processed at all, forever.
  const MAX_SWEEP_MS = 45_000;
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > MAX_SWEEP_MS;

  // ── Which org goes first ────────────────────────────────────────────────
  //
  // Least-recently-swept first. The sweep budget below stops the whole run once
  // it is spent, so a fixed order means the orgs at the end of it are the ones
  // that get skipped — every single time. Giving a large tenant its own resume
  // cursor fixed starvation WITHIN an org and moved the same problem up a
  // level: org A eats the budget, finishes, resets, and eats it again, while
  // org B is never reached.
  //
  // automation_sweep_state.updated_at is stamped on every org the sweep
  // touches, so ordering by it rotates the queue on its own. Orgs never swept
  // (no row) sort first.
  if (!callerOrgId && orgs.length > 1) {
    // Paged for the same reason as the org list: one row per org, so a flat
    // limit would hand back a partial map and silently mis-order the queue.
    const lastSwept = new Map<string, string>();
    let stateCursor: string | null = null;
    for (;;) {
      let q = supabase.from("automation_sweep_state")
        .select("org_id, updated_at").order("org_id", { ascending: true }).limit(500);
      if (stateCursor) q = q.gt("org_id", stateCursor);
      const { data, error } = await q;
      if (error || !data?.length) break;
      data.forEach((r) => lastSwept.set(r.org_id, r.updated_at));
      stateCursor = data[data.length - 1].org_id;
    }
    // Plain < / >, not localeCompare. ICU collation does not treat "." and "+"
    // as ordinary codepoints, so a timestamp Postgres rendered WITHOUT a
    // fractional part sorts after one with it — "…:00+00:00" vs "…:00.5+00:00"
    // compares backwards. It bites whenever a stamp lands on exactly .000, and
    // it is invisible when it does.
    orgs.sort((a, b) => {
      const x = lastSwept.get(a.id) ?? "", y = lastSwept.get(b.id) ?? "";
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  const now = new Date();

  // Only the SCHEDULED sweep reads or writes the resume cursor. A member
  // pressing "Test run" expects their rules evaluated from the top, and must
  // not move the scheduler's bookmark.
  const scheduled = !callerOrgId && !dryRun;

  /**
   * Stamp that this sweep visited an org.
   *
   * Called on EVERY exit path, including the early ones. The fairness sort
   * above reads updated_at, and an org that returned early — no enabled rules,
   * a failed lookup — used to write nothing at all. `lastSwept.get(id) ?? ""`
   * then sorted it first on every subsequent sweep, permanently, rather than
   * only while bootstrapping. On a tenancy where most orgs have no automations
   * that means the empty ones queue-jump ahead of the paying ones forever, and
   * eat the time budget one round trip at a time.
   */
  const touchSweep = (orgId: string, cursor: string | null) =>
    supabase.from("automation_sweep_state")
      .upsert({ org_id: orgId, cursor, updated_at: now.toISOString() }, { onConflict: "org_id" });

  // Both arrays are capped. They used to be bounded by accident: the lead
  // fetch was capped at 1,000 rows, so nothing could push more than that.
  // Pagination removed the accident — a dry run over 50,000 leads would push
  // one object per match (each embedding the rule's full action list) and a
  // persistent cooldown failure would push one warning per rule per page, all
  // inside a 150 MB runtime.
  const REPORT_CAP = 200, WARN_CAP = 100;
  const report: unknown[] = [];
  // Kept apart from `report`, which is truncated to 50 entries in the response.
  // A warning that gets sliced off is a warning nobody sees.
  const warningList: string[] = [];
  let warnCount = 0, reportCount = 0;
  const warnings = {
    push(w: string) { warnCount++; if (warningList.length < WARN_CAP) warningList.push(w); },
  };
  const pushReport = (r: unknown) => { reportCount++; if (report.length < REPORT_CAP) report.push(r); };
  let fired = 0;
  let degraded = false;

  for (const org of orgs) {
    // The budget bounds the SWEEP, not one org. Checking it only inside the
    // page loop let every remaining org run a full page first.
    if (outOfTime()) {
      warnings.push(`stopped before ${org.slug}: sweep time budget reached`);
      degraded = true;
      break;
    }

    const { data: autos, error: autoErr } = await supabase
      .from("automations")
      .select("*")
      .eq("org_id", org.id)
      .eq("enabled", true)
      .in("trigger", TIME_TRIGGERS);

    if (autoErr) {
      // Was a bare `continue`: an org whose rules could not be read looked
      // exactly like an org with no rules.
      console.error(`run-automations: rule lookup failed for ${org.slug}:`, autoErr.message);
      warnings.push(`${org.slug}: rule lookup failed (${autoErr.message})`);
      degraded = true;
      if (scheduled) await touchSweep(org.id, null);  // keep the rotation honest
      continue;
    }
    if (!autos?.length) {
      // Stamped even with nothing to do, or this org sorts to the front of
      // every future sweep and costs a round trip on each one.
      if (scheduled) await touchSweep(org.id, null);
      continue;
    }

    const { data: stages, error: stageErr } = await supabase
      .from("pipeline_stages").select("key, is_won, is_lost").eq("org_id", org.id);

    if (stageErr) {
      // This one fails in the dangerous direction. An empty `terminal` set
      // means no stage counts as won or lost, so every closed record looks
      // open and time-based rules start chasing leads the customer already
      // marked lost. Skip the org instead.
      console.error(`run-automations: stage lookup failed for ${org.slug}:`, stageErr.message);
      warnings.push(`${org.slug}: stage lookup failed, org skipped (${stageErr.message})`);
      degraded = true;
      if (scheduled) await touchSweep(org.id, null);  // keep the rotation honest
      continue;
    }
    const terminal = new Set((stages ?? []).filter((s) => s.is_won || s.is_lost).map((s) => s.key));

    // ── Leads, paginated ─────────────────────────────────────────────────
    //
    // This was one shot: `.select("*").eq("org_id", org.id).limit(5000)`.
    // PostgREST's max-rows on this project is 1,000, so the 5,000 was never
    // honoured. The sweep saw an arbitrary, unordered thousand leads and every
    // record past that was invisible to time-based rules — permanently, and
    // silently. "Follow up if nobody has touched this in 7 days" simply never
    // fired for lead 1,001 onwards. Business plan sells 50,000 records.
    //
    // Keyset pagination on the primary key, not .range(): actions mutate
    // stage_key and assigned_to while we walk, and ordering by anything they
    // touch would let rows shift between pages. id never changes.
    const PAGE = 500;
    let scanned = 0;
    let budgetHit = false;
    let pageFailed = false;
    const skipped = new Set<string>();
    const evaluated = new Set<string>();

    // Resume where the last sweep ran out of time. Stored per org, so a tenant
    // too large to finish in one invocation is walked across several ticks
    // instead of having its tail permanently starved.
    //
    let cursor: string | null = null;
    if (scheduled) {
      const { data: state } = await supabase
        .from("automation_sweep_state")
        .select("cursor").eq("org_id", org.id).maybeSingle();
      cursor = state?.cursor ?? null;
    }

    pages: for (;;) {
      // `.is("deleted_at", null)` is not optional here.
      //
      // 20260903150000 made deletion soft and enforced it in RLS ONLY, on the
      // stated reasoning that then "nobody has to remember to add the filter".
      // That holds for the app, which reads as the user. It does not hold for
      // anything running as the service role, which bypasses RLS by design —
      // so this sweep walked deleted records and fired rules on them: stage
      // moves, reassignments and Telegram alerts about a lead the customer
      // deleted. Bounded to an arbitrary 1,000 rows before; pagination would
      // have guaranteed it reached every one of them.
      let leadQ = supabase
        .from("leads").select("*").eq("org_id", org.id)
        .is("deleted_at", null)
        .order("id", { ascending: true }).limit(PAGE);
      if (cursor) leadQ = leadQ.gt("id", cursor);

      const { data: page, error: pageErr } = await leadQ;
      if (pageErr) {
        console.error(`run-automations: lead page failed for ${org.slug}:`, pageErr.message);
        warnings.push(`${org.slug}: lead page failed (${pageErr.message})`);
        degraded = true;
        // pageFailed, not budgetHit — but the cursor must be PRESERVED either
        // way. Falling through to the "completed pass" branch would write null
        // and throw away however many pages this org had already walked across
        // earlier ticks, restarting it from the top on one flaky fetch.
        pageFailed = true;
        break;
      }
      if (!page?.length) break;

      cursor = page[page.length - 1].id;
      scanned += page.length;

      // Open records only — chasing a won or lost lead is noise.
      const open = page.filter((l) => !terminal.has(l.stage_key ?? l.stage));

      // Fresh per page: assignment counts go stale as the sweep assigns.
      const pageCtx: ExecContext = {};

      for (const a of autos as Automation[]) {
        // ── Cooldown ─────────────────────────────────────────────────────
        //
        // The dangerous one. This used to read every automation_run in the
        // cooldown window with no limit, so it too stopped at 1,000 rows — and
        // a MISSING row here does not mean "skip", it means "never ran". Past
        // a thousand runs in the window the rule stopped seeing its own
        // history and fired again for leads it had already processed. Same
        // lead, same rule, same day: a second Telegram alert, a second stage
        // move, a second note. Duplicate outbound is the failure mode a
        // customer notices and does not forgive.
        //
        // Now asked per batch, one row per lead, so it cannot overflow.
        const since = new Date(now.getTime() - Math.max(0, a.cooldown_hours) * 3600_000).toISOString();
        const lastRun = new Map<string, string>();

        if (open.length) {
          const { data: runs, error: runErr } = await supabase.rpc("automation_last_runs", {
            p_automation_id: a.id,
            p_lead_ids: open.map((l) => l.id),
            p_since: since,
          });
          if (runErr) {
            // Fail closed. Without cooldown state every lead looks untouched,
            // and carrying on would re-fire the whole batch. Skipping costs a
            // delayed follow-up; guessing costs duplicate messages.
            console.error(`run-automations: cooldown lookup failed for "${a.name}", skipping batch:`, runErr.message);
            warnings.push(`${org.slug}/"${a.name}": cooldown lookup failed, batch skipped`);
            degraded = true;
            skipped.add(a.id);   // this rule only, not the whole org
            continue;
          }
          (runs as { lead_id: string; last_run_at: string }[] | null ?? [])
            .forEach((r) => lastRun.set(r.lead_id, r.last_run_at));
        }

        // Only a rule that got this far actually looked at its leads. Rules
        // that skipped on a cooldown error must NOT be stamped as having run.
        evaluated.add(a.id);

        for (const lead of open) {
          if (!shouldRun(a, lead, lastRun.get(lead.id), now)) continue;

          if (dryRun) {
            pushReport({ automation: a.name, lead: lead.name, would_run: a.actions });
            fired++;
            continue;
          }

          // Executed by the SHARED action runner, not a local copy.
          //
          // _shared/run-actions.ts opens by explaining that it was extracted
          // "so the SAME code path runs whether an automation is fired by cron
          // (run-automations) or inline by an event" — and then this file kept
          // a full nine-case duplicate of the switch anyway. Two definitions of
          // what set_stage means, exactly as that comment warned.
          //
          // They had already diverged: the round-robin fix landed in the shared
          // copy only, so cron-fired assignment was still counting a truncated
          // thousand rows while event-fired assignment counted properly. A rule
          // behaving differently depending on whether it fired at intake or at
          // 3am is the kind of bug nobody can reproduce.
          // `pageCtx` carries one assignment-load snapshot for this batch.
          // org_assignment_load() aggregates profiles × leads for the whole
          // org; calling it per lead meant 500 full aggregations per page.
          const { taken, ok, detail } = await executeActions(supabase, org.id, lead, a, now, pageCtx);

          // Checked, because THIS ROW IS THE COOLDOWN. If the insert silently
          // fails, the next sweep sees "never ran" and fires the rule again —
          // the duplicate-firing bug this whole change exists to remove, left
          // in the one write that prevents it.
          const { error: runErr } = await supabase.from("automation_runs").insert({
            org_id: org.id, automation_id: a.id, lead_id: lead.id,
            actions_taken: taken, ok, detail,
          });
          if (runErr) {
            console.error(`run-automations: run record failed for "${a.name}" on lead ${lead.id} — it may re-fire:`, runErr.message);
            warnings.push(`${org.slug}/"${a.name}": run record failed; rule may re-fire`);
            degraded = true;
            skipped.add(a.id);
          }
          fired++;
        }
      }

      // Deliberately NOT `if (page.length < PAGE) break`. PAGE is 500 and
      // PostgREST's max-rows is 1,000 today — but max-rows is a dashboard
      // setting. Drop it to 500 or below and every page comes back "short",
      // the loop exits after one page, and leads past 500 become invisible:
      // precisely the bug this pagination was written to remove, reintroduced
      // by a config change nobody would connect to it. One extra empty query
      // per org is the cost of not having that landmine.

      if (outOfTime()) {
        budgetHit = true;
        console.warn(`run-automations: time budget reached for ${org.slug} after ${scanned} leads`);
        break pages;
      }
    }

    // Persist the cursor so the next tick resumes here; clear it on a complete
    // pass so the following sweep starts from the top again.
    if (scheduled) {
      // Cleared only on a pass that genuinely reached the end.
      const { error: stateErr } = await touchSweep(org.id, (budgetHit || pageFailed) ? cursor : null);
      if (stateErr) {
        // Without this the next sweep restarts from the top and re-walks the
        // same prefix, so the tail starves exactly as it would with no cursor.
        console.error(`run-automations: could not save resume cursor for ${org.slug}:`, stateErr.message);
        warnings.push(`${org.slug}: resume cursor not saved (${stateErr.message})`);
        degraded = true;
      }
    }

    if (budgetHit) {
      warnings.push(`${org.slug}: time budget reached after ${scanned} lead(s); resuming next tick`);
      degraded = true;
    }

    // Stamp only the rules that were actually evaluated.
    //
    // This used to stamp every enabled rule unconditionally. Combined with the
    // fail-closed skip above that produced the worst possible display: the
    // cooldown lookup is down, nothing fires all night, and the Automations
    // screen shows every rule as having just run.
    //
    // run_count is incremented in the database rather than read-modify-written
    // from the copy fetched at the top of this loop, which lost any concurrent
    // increment from the event path.
    // last_run_at answers "did the sweep execute this rule", per rule.
    //
    // An earlier version gated this on the whole org's pass completing, which
    // read as more honest and was in fact a worse lie: an org large enough to
    // hit the time budget on every tick would NEVER stamp, so the Automations
    // screen showed "not run yet" forever for the biggest paying tenants —
    // whose rules were firing hundreds of times an hour. It also let one bad
    // rule suppress the stamp for every other rule in the org.
    //
    // Sweep completeness is a property of the JOB, not of any one rule, and it
    // already has its own channel: `degraded`, the warnings array, the "warn"
    // heartbeat, and stale_jobs() reading last_status.
    //
    // A rule that completed the whole walk is stamped even if it matched
    // nothing — "evaluated against zero leads" is still having run.
    if (!budgetHit && !pageFailed) {
      for (const a of autos as Automation[]) evaluated.add(a.id);
    }

    if (!dryRun) {
      for (const a of autos as Automation[]) {
        if (!evaluated.has(a.id) || skipped.has(a.id)) continue;
        const { error } = await supabase.rpc("automation_mark_run", { p_automation_id: a.id });
        if (error) console.error(`run-automations: could not stamp "${a.name}":`, error.message);
      }
    }
  }

  // Only the scheduled sweep reports health — a member clicking "Test run"
  // is not evidence that cron is alive, and recording it as such would make
  // the staleness check lie in the reassuring direction.
  //
  // "degraded" matters as much as the schedule. A sweep where every rule
  // skipped on a failed cooldown lookup previously reported a cheerful
  // `ok — 3 org(s), 0 fired`, which the staleness check reads as healthy. A
  // total outage of time-based automations looked exactly like a quiet night.
  if (!callerOrgId && !dryRun) {
    await heartbeat(
      // "warn", not a new word: nurture and system-health already report
      // "warn", and the health screen only special-cases "ok".
      degraded ? "warn" : "ok",
      `${orgs.length} org(s), ${fired} fired` +
        (warnCount ? ` — ${warnCount} warning(s): ${warningList.slice(0, 3).join("; ")}` : ""),
    );
  }
  return json({
    ok: !degraded, dry_run: dryRun, orgs: orgs.length, fired,
    warning_count: warnCount, warnings: warningList,
    report_count: reportCount, report,
  });
});
