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
// POST { dry_run?: boolean, limit?: number }
//  -> { ok, scanned, updated, unchanged, sample: [{id, name, was, now, breakdown}] }

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
  const limit = Math.min(Number(body?.limit) || 1000, 5000);

  const orgId = profile.org_id;

  const { data: leads, error } = await admin.from("leads")
    .select("id, name, email, phone, budget_inr, target_country, course, course_level, intake, stage, score")
    .eq("org_id", orgId)
    .limit(limit);
  if (error) return json({ error: error.message }, 500);

  // Engagement = activities logged against each lead. One round trip, not N.
  const { data: acts } = await admin.from("activities")
    .select("lead_id").eq("org_id", orgId).limit(10000);
  const engagement: Record<string, number> = {};
  for (const a of acts ?? []) {
    if (a.lead_id) engagement[a.lead_id] = (engagement[a.lead_id] ?? 0) + 1;
  }

  let updated = 0, unchanged = 0;
  const sample: unknown[] = [];

  for (const l of leads ?? []) {
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
      await admin.from("leads").update({ score }).eq("id", l.id);
    }
    updated++;
  }

  return json({
    ok: true,
    dry_run: dryRun,
    scanned: leads?.length ?? 0,
    updated,
    unchanged,
    sample,
  });
});
