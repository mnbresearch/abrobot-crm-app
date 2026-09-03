// Resolving the stage a brand-new record should land in.
//
// Why this exists: lead-webhook and chat-agent used to insert without setting
// stage_key at all, so the column default gave them 'new'. Only 2 of the 13
// industry packs actually HAVE a stage keyed 'new' — study_abroad and general.
// The other eleven start at 'enquiry' (or 'sourced' for recruitment).
//
// Pipeline.tsx builds its columns from pipeline_stages and drops any lead whose
// stage_key has no matching column:
//
//     leads.forEach(l => { const k = l.stage_key ?? l.stage; if (m[k]) m[k].push(l); })
//
// So for a hospital, a clinic, a law firm, a gym — every lead captured by the
// website widget or an inbound webhook was silently missing from the board the
// customer works out of. The record existed, it was counted, it was billed; it
// just could not be seen where anyone would look for it.
//
// Import.tsx already did this correctly (`stages[0]?.key ?? "new"`). The two
// unauthenticated intake paths — the ones that matter most — did not.

// deno-lint-ignore no-explicit-any
export async function firstStageKey(supabase: any, orgId: string): Promise<string> {
  const { data, error } = await supabase
    .from("pipeline_stages")
    .select("key")
    .eq("org_id", orgId)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    // Fall back rather than lose the lead. 'new' is wrong for most packs, but a
    // record in the wrong column beats no record at all — and the log line is
    // how anyone finds out this happened.
    console.error(`firstStageKey: lookup failed for org ${orgId}: ${error.message}`);
    return "new";
  }

  // No stages configured yet (org created but never onboarded).
  return data?.key ?? "new";
}
