// AbroBot CRM — recompute leads.score for an org.
// Deploy:  supabase functions deploy rescore-leads   (KEEP Verify JWT ON)
// Secrets: none beyond the platform SUPABASE_* pair.
//
// leads.score was NOT NULL but never written by anything, so every existing
// lead sits at its column default. This backfills them, and can be re-run any
// time weights change or as a scheduled refresh (engagement and intake
// proximity both drift over time).
//
// Auth mirrors send-campaign: the caller sends the logged-in user's Supabase
// access token, and may only rescore their own org. JWT verification stays ON.
//
// POST { dry_run?: boolean, limit?: number, after?: string }
//  -> { ok, complete, aborted, scanned, updated, unchanged, next_cursor,
//       sample: [{id, name, was, now, breakdown}] }
//
// The whole org is walked by default; `limit` is an optional scan budget, not
// a page size. A run that hits the wall-clock budget stops itself and returns
// `complete: false` with a `next_cursor` — POST it back as `after` to continue
// where it stopped. `complete` and `aborted` are the only honest answer to
// "did this actually rescore everything?", which the old response could not
// give: it reported a silently truncated 1,000 as a finished pass.

import { createClient } from "npm:@supabase/supabase-js@2";
import { scoreLead } from "../_shared/score.ts";

const admin = createClient(
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



Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // --- authenticate the CRM user ---
  const authz = req.headers.get("Authorization") || "";
  const token = authz.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing auth" }, 401);
  const { data: userData, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !userData?.user) return json({ error: "invalid session" }, 401);
  const { data: profile } = await admin.from("profiles")
    .select("org_id, status, role").eq("id", userData.user.id).single();
  if (!profile || profile.status !== "active" || !profile.org_id) {
    return json({ error: "not an active member" }, 403);
  }

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { /* body is optional */ }
  const dryRun = body?.dry_run === true;

  // `limit` is a SCAN BUDGET, not a page size, and it no longer defaults to a
  // number. It used to be `Math.min(Number(body?.limit) || 1000, 5000)` handed
  // straight to a single `.limit()`, which was two separate lies: PostgREST's
  // max-rows on this project is 1,000, so the 5,000 ceiling was never honoured
  // and the 1,000 default meant that by default only the first thousand leads
  // in an arbitrary order were ever rescored. An org on Business, which sells
  // 50,000 records, had 49,000 leads whose score no rescore could ever move —
  // while the response cheerfully reported `scanned: 1000` as a finished run.
  const limitRaw = Number(body?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : Infinity;

  // Resume point for an org too large to finish in one invocation. Pass back
  // the `next_cursor` from the previous response.
  const after: string | null =
    typeof body?.after === "string" && body.after ? body.after : null;

  const orgId = profile.org_id;

  // Pages are read by keyset on the primary key, never `.range()`: this
  // function writes leads.score while it walks, and ordering by anything it
  // touches would let rows shift between pages. id never changes.
  const LEAD_PAGE = 500;
  const ACT_PAGE = 1000;

  // A run killed by the platform's wall clock leaves nothing behind and no
  // report. It stops itself instead and hands back a cursor.
  const MAX_RUN_MS = 45_000;
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > MAX_RUN_MS;

  // ── Engagement, counted before a single score is written ──────────────────
  //
  // This was `const { data: acts } = await admin.from("activities")...` — the
  // error DISCARDED — with `.limit(10000)` against a max-rows of 1,000. Two
  // failures, both of which only ever push scores DOWN:
  //
  //   * truncation: an org past 1,000 activities had engagement computed from
  //     an arbitrary unordered subset, so a lead with eight logged calls could
  //     score as though it had none;
  //   * a failed read: `acts` is null, the loop below iterates nothing, every
  //     engagement_count is 0, and every lead in the org is written down by the
  //     full engagement weight. Silently, reported as `ok: true`.
  //
  // That is not a display bug. leads.score drives the score_above / score_below
  // automation conditions, so a zeroed org fires "score dropped below X"
  // follow-ups at customers en masse and stops firing the rules that matter.
  // Hence: paginate, and abort the whole run rather than write a single score
  // from an incomplete count.
  const engagement: Record<string, number> = {};
  let activitiesCounted = 0;
  let actCursor: string | null = null;

  for (;;) {
    let actQ = admin.from("activities")
      .select("id, lead_id").eq("org_id", orgId)
      .order("id", { ascending: true }).limit(ACT_PAGE);
    if (actCursor) actQ = actQ.gt("id", actCursor);

    const { data: acts, error: actErr } = await actQ;
    if (actErr) {
      // 503, and nothing written. Scoring on a partial activity count is worse
      // than not scoring at all: the old code would have silently rewritten
      // every lead in the org with engagement 0.
      console.error("rescore-leads: activity page failed for org", orgId, actErr.message);
      return json({
        ok: false,
        // `error` as well as `aborted`. The frontend reaches this through
        // callFunction, which throws `new Error(json?.error || \`${name} failed
        // (${res.status})\`)` — so a body carrying only `aborted` surfaced to
        // the admin as the literal string "rescore-leads failed (503)", and
        // the reason we took care to write was discarded one layer up.
        error: "Scoring was abandoned: the activity history could not be read. No scores were changed.",
        aborted: "activity read failed — no scores were written",
        detail: actErr.message,
        scanned: 0,
        updated: 0,
      }, 503);
    }
    if (!acts?.length) break;

    for (const a of acts) {
      if (a.lead_id) engagement[a.lead_id] = (engagement[a.lead_id] ?? 0) + 1;
    }
    activitiesCounted += acts.length;
    actCursor = acts[acts.length - 1].id;

    // Deliberately NOT `if (acts.length < ACT_PAGE) break`. max-rows is a
    // dashboard setting: drop it below ACT_PAGE and every page comes back
    // "short", the loop exits after one, and the engagement count silently
    // becomes a truncated prefix again — the exact bug this replaces. One
    // extra empty query is the cost of not leaving that landmine.

    if (outOfTime()) {
      // No partial scoring on a partial count, for the same reason as above.
      console.error("rescore-leads: timed out counting activities for org", orgId);
      return json({
        ok: false,
        error: "Scoring was abandoned: counting activity history took too long. No scores were changed — re-run and it will resume.",
        aborted: "timed out counting activities — no scores were written",
        activities_counted: activitiesCounted,
        scanned: 0,
        updated: 0,
      }, 503);
    }
  }

  let scanned = 0, updated = 0, unchanged = 0;
  const failed: string[] = [];
  const sample: unknown[] = [];
  let cursor: string | null = after;
  let complete = true;
  let aborted: string | null = null;

  pages: for (;;) {
    let leadQ = admin.from("leads")
      .select("id, name, email, phone, budget_inr, target_country, course, course_level, intake, stage, score")
      .eq("org_id", orgId)
      .is("deleted_at", null)   // don't spend the rescore budget on deleted rows
      .order("id", { ascending: true })
      .limit(Math.min(LEAD_PAGE, limit - scanned));
    if (cursor) leadQ = leadQ.gt("id", cursor);

    const { data: leads, error } = await leadQ;
    if (error) {
      // A page failing part-way through is not the same as the whole run
      // failing: earlier pages have already been written. Report what landed
      // and say plainly that the pass did not finish, rather than returning a
      // bare 500 that tells the caller nothing about the half-rescored org.
      console.error("rescore-leads: lead page failed for org", orgId, error.message);
      aborted = `lead page failed: ${error.message}`;
      complete = false;
      break;
    }
    if (!leads?.length) break;   // EMPTY page, not a short one, ends the walk

    cursor = leads[leads.length - 1].id;
    scanned += leads.length;

    for (const l of leads) {
      const { score, breakdown } = scoreLead({
        email: l.email, phone: l.phone, budget_inr: l.budget_inr,
        target_country: l.target_country, course: l.course, course_level: l.course_level,
        intake: l.intake, stage: l.stage, engagement_count: engagement[l.id] ?? 0,
      });

      if (score === l.score) { unchanged++; continue; }

      if (sample.length < 10) {
        sample.push({ id: l.id, name: l.name, was: l.score, now: score, breakdown });
      }
      if (!dryRun) {
        const { error: upErr } = await admin.from("leads").update({ score }).eq("id", l.id);
        // updated++ used to run unconditionally, so every write could fail and
        // the caller was still told N records were rescored.
        if (upErr) { failed.push(`${l.id}: ${upErr.message}`); continue; }
      }
      updated++;
    }

    if (scanned >= limit) {
      // The caller asked for a budget and got it. Not a complete pass.
      complete = false;
      break pages;
    }

    if (outOfTime()) {
      console.warn("rescore-leads: time budget reached for org", orgId, "after", scanned, "leads");
      complete = false;
      aborted = "time budget reached — re-run with `after` to continue";
      break pages;
    }
  }

  // ok reflects whether every write actually landed. It was hardcoded true
  // beside an `updated` counter that incremented regardless of the result.
  //
  // `scanned` is now the number of leads this run genuinely looked at, and
  // `complete` says whether that was all of them. The old response reported a
  // truncated 1,000 with no way for the caller to tell it apart from an org
  // that really does have 1,000 leads.
  return json({
    ok: failed.length === 0 && !aborted,
    dry_run: dryRun,
    complete,
    aborted,
    scanned,
    updated,
    unchanged,
    failed: failed.length,
    failures: failed.slice(0, 10),
    activities_counted: activitiesCounted,
    next_cursor: complete ? null : cursor,
    sample,
  });
});
