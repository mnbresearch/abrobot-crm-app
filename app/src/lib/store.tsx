import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { supabase } from "./supabase";
import { getIndustry, type IndustryUi } from "./industries";
import type { FieldDef, IndustryRow, Lead, PipelineStage, Organization, Profile } from "./types";

// Single app-wide context. The legacy app used a similar shape (Ut() in the
// bundle exposed { org, profile, isAdmin }), so behaviour stays familiar.

/**
 * What the org's plan actually DOES right now, as opposed to what they bought.
 *
 * `organizations.plan` is the purchase record and never changes on its own, so
 * a lapsed Growth customer still reads "growth" there while every server-side
 * guard treats them as expired. `effective_plan()` in the database is the one
 * that decides behaviour, and `usage_snapshot` is the only way to read it from
 * the browser — so the shell reads it once and shares it, rather than each
 * screen inventing its own answer.
 */
export interface PlanState {
  effective: string;
  purchased: string;
  label: string;
  isExpired: boolean;
  notActivated: boolean;
  seatsUsed: number;
  seatsLimit: number | null;
  leadsUsed: number;
  leadsLimit: number | null;
  /**
   * How many automations this plan allows. Carried here because the setup
   * checklist has to know: `free` is max_automations = 0 and max_seats = 1, so
   * "Invite your team" and "Switch on one automation" can never be ticked on it
   * and the checklist card became permanent for every free org, with two
   * buttons pointing at screens that refuse. A step you cannot complete is
   * worse than no step at all.
   */
  automationsLimit: number | null;
}

interface AppState {
  loading: boolean;
  session: boolean;
  profile: Profile | null;
  org: Organization | null;
  stages: PipelineStage[];
  fields: FieldDef[];
  industries: IndustryRow[];
  ui: IndustryUi;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  needsOnboarding: boolean;
  /** null until loaded, or if usage_snapshot could not be read. */
  plan: PlanState | null;
  /** Non-null when the shell itself failed to load — surfaced, never swallowed. */
  loadError: string | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

/** Shape of the usage_snapshot RPC, narrowed to what the shell needs. */
interface UsageSnapshotRow {
  plan: string;
  purchased_plan: string;
  label: string;
  is_expired: boolean;
  not_activated: boolean;
  seats: { used: number; limit: number | null };
  leads: { used: number; limit: number | null };
  automations?: { used: number; limit: number | null };
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [org, setOrg] = useState<Organization | null>(null);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [industries, setIndustries] = useState<IndustryRow[]>([]);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Every await below can REJECT, not just return an error — a dropped
    // connection, a CORS failure or an expired refresh token all throw out of
    // the supabase client. There was no try/catch, so a rejection escaped this
    // async callback entirely, `setLoading(false)` never ran, and the app sat
    // on the full-page spinner forever with nothing on screen and nothing in
    // the UI to retry. `finally` is the only thing that makes that impossible.
    try {
      const { data: s, error: sessErr } = await supabase.auth.getSession();
      if (sessErr) throw new Error(sessErr.message);
      if (!s.session) {
        setSession(false);
        setProfile(null);
        setOrg(null);
        setPlan(null);
        setLoadError(null);
        return;
      }
      setSession(true);

      const uid = s.session.user.id;
      // The error was discarded here, so a failed profile read produced
      // `profile = null` — which App.tsx reads as "no organisation yet" and
      // answers by showing an existing customer the CREATE ORGANISATION form.
      const { data: prof, error: profErr } = await supabase.from("profiles").select("*").eq("id", uid).single();
      if (profErr) throw new Error(`Could not load your profile: ${profErr.message}`);
      setProfile((prof as Profile) ?? null);

      if (prof?.org_id) {
        // Fetched in parallel — these are independent and the dashboard needs
        // all of them before it can render a single correct number.
        const [orgRes, stageRes, fieldRes, indRes, planRes] = await Promise.all([
          supabase.from("organizations").select("*").eq("id", prof.org_id).single(),
          supabase.from("pipeline_stages").select("*").eq("org_id", prof.org_id).order("position"),
          supabase.from("field_defs").select("*").eq("org_id", prof.org_id).order("position"),
          supabase.from("industries").select("*").eq("active", true).order("position"),
          supabase.rpc("usage_snapshot", { p_org_id: prof.org_id }),
        ]);

        // A failed STAGES read is indistinguishable from "no stages yet", and
        // `needsOnboarding` is defined as stages.length === 0 — so swallowing
        // this error threw an established customer back into the industry
        // picker, where choosing again would re-seed their pipeline.
        const fatal = orgRes.error ?? stageRes.error;
        if (fatal) throw new Error(`Could not load your workspace: ${fatal.message}`);
        if (fieldRes.error) console.error("store: custom fields unavailable —", fieldRes.error.message);
        if (indRes.error) console.error("store: industry list unavailable —", indRes.error.message);

        setOrg((orgRes.data as Organization) ?? null);
        setStages((stageRes.data as PipelineStage[]) ?? []);
        setFields((fieldRes.data as FieldDef[]) ?? []);
        setIndustries((indRes.data as IndustryRow[]) ?? []);

        // Non-fatal: the app is perfectly usable without it, and the screens
        // that need it fall back to the purchased plan rather than blocking.
        if (planRes.error) {
          console.error("store: plan state unavailable —", planRes.error.message);
          setPlan(null);
        } else {
          const snap = planRes.data as UsageSnapshotRow | null;
          setPlan(snap ? {
            effective: snap.plan,
            purchased: snap.purchased_plan,
            label: snap.label,
            isExpired: !!snap.is_expired,
            notActivated: !!snap.not_activated,
            seatsUsed: snap.seats?.used ?? 0,
            seatsLimit: snap.seats?.limit ?? null,
            leadsUsed: snap.leads?.used ?? 0,
            leadsLimit: snap.leads?.limit ?? null,
            // `?? null` is "unlimited", not "none" — the distinction matters
            // because the checklist hides the automation step on a plan that
            // allows zero, and hiding it from an unlimited plan would remove a
            // step people actually need.
            automationsLimit: snap.automations?.limit ?? null,
          } : null);
        }
      } else {
        const { data: ind, error: indErr } = await supabase
          .from("industries").select("*").eq("active", true).order("position");
        // CreateOrg renders the industry picker from this list. Empty because
        // the request failed looks exactly like "no industries configured",
        // and there is no way past that screen.
        if (indErr) throw new Error(`Could not load the industry list: ${indErr.message}`);
        setIndustries((ind as IndustryRow[]) ?? []);
        setPlan(null);
      }
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const { data: sub } = supabase.auth.onAuthStateChange(() => void load());
    return () => sub.subscription.unsubscribe();
  }, [load]);

  const ui = useMemo(() => getIndustry(org?.industry_slug), [org?.industry_slug]);

  // Tint the whole shell to the industry accent. One CSS variable swap rather
  // than per-component theming — the reason every style uses var(--industry).
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--industry", ui.accent ?? "var(--brand)");
    root.style.setProperty("--industry-soft", ui.accentSoft ?? "var(--brand-light)");
  }, [ui]);

  const value: AppState = {
    loading,
    session,
    profile,
    org,
    stages,
    fields,
    industries,
    ui,
    isAdmin: profile?.role === "org_admin" || profile?.role === "super_admin",
    // The platform owner, not a tenant's admin. Gates the Admin console, which
    // reaches across every organisation — so it is deliberately a separate
    // flag rather than another thing isAdmin happens to imply.
    isSuperAdmin: profile?.role === "super_admin",
    // A brand-new org has no stages until a pack is applied — that is the
    // signal to show the industry picker. Gated on `!loadError` because a
    // failed stage read is also zero stages, and the two must not look alike.
    needsOnboarding: !loadError && !!profile?.org_id && stages.length === 0,
    plan,
    loadError,
    refresh: load,
    signOut: async () => {
      await supabase.auth.signOut();
      setSession(false);
      setProfile(null);
      setOrg(null);
      setPlan(null);
      setLoadError(null);
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside <AppProvider>");
  return v;
}

// ── leads ───────────────────────────────────────────────────────────────────

// `error` is returned, not swallowed. It used to be dropped, so `data` came
// back null, `?? []` turned it into an empty array, and a single failed
// request rendered as "No leads yet" on the Dashboard, Leads, Pipeline,
// Calendar and Reports simultaneously — a customer with 4,000 records being
// told, convincingly, that they have none. Callers should show `error` rather
// than an empty state.
//
// `truncated` exists because the limit is real: the Business plan sells 50,000
// records and this reads a page, so past that every chart is computed on the
// newest slice with nothing on screen admitting it.
//
// It used to be `leads.length >= LEAD_PAGE_LIMIT`, which is the wrong test and
// silently never fired. There is no supabase/config.toml in this repo, so the
// hosted PostgREST `max-rows` default applies — 1,000, as the comment in
// Import.tsx says. Asking for 2,000 therefore returns 1,000, `1000 >= 2000` is
// false, the amber banner NEVER rendered on any screen, and every count in the
// app was computed from 1,000 of however many records the customer has while
// presenting itself as the whole truth.
//
// The fix is to stop inferring the total from the page at all. `totalLeads` is
// a separate head+exact-count request, so `truncated` is correct whatever
// max-rows happens to be set to on any given project.
//
// The number is 1,000 and not 2,000 because 2,000 was never deliverable:
// PostgREST clamps every request to max-rows, which is 1,000 here (there is no
// supabase/config.toml, so the hosted default applies — the same number
// Import.tsx documents). Asking for 2,000 changed nothing about what arrived,
// but <TruncationNotice/> built its button label out of the figure and so
// offered "Load 2,000 more" and delivered 1,000. The constant now states what a
// page actually is, and the label is imported from here rather than retyped, so
// the promise and the request cannot drift apart again. If a deployment raises
// max-rows we simply page more often, which is safe.
export const LEAD_PAGE_LIMIT = 1000;

// ── the count layer ─────────────────────────────────────────────────────────
//
// Every exact number in this file — the org total, the stage badges, the
// Calendar's follow-up count, the export's denominator — is a
// `{ count: "exact", head: true }` request. That request shape is known to be
// fragile on this project: SetupChecklist.tsx documents four of them returning
// 503 on *every* dashboard load while the ordinary GETs beside them returned
// 200, with free-tier connection limits under parallel queries the leading
// suspicion. useStageCounts then fanned one out PER STAGE — eight or more at
// once on every Pipeline and Dashboard load — which is precisely the shape that
// broke there.
//
// So all of them go through here instead: at most one count in flight at a
// time, and the first failure switches the layer off for the rest of the
// session rather than retrying the storm on every re-render. Callers already
// read null as "no exact number available" and fall back to counting what is in
// memory, so degrading is an honest downgrade, never an error state.
//
// The real fix for the stage badges is one grouped count (a `stage_counts(org)`
// RPC); that needs a migration, which is out of this change's reach.
let countsUnavailable = false;
let countChain: Promise<unknown> = Promise.resolve();

/**
 * Runs an exact-count request, serialised, and returns null if counts are off.
 *
 * `force` re-arms the layer first, and belongs on anything the USER just asked
 * for. The breaker exists to stop automatic bursts repeating on every render —
 * not to make one unlucky 503 at mount permanent for the session, which would
 * leave the screen without a denominator until a full reload.
 */
async function headCount(
  run: () => Promise<{ count: number | null; error: { message: string } | null }>,
  opts: { force?: boolean } = {},
): Promise<number | null> {
  if (opts.force) countsUnavailable = false;
  if (countsUnavailable) return null;
  const next = countChain.then(async () => {
    if (countsUnavailable) return null;
    const { count, error } = await run();
    if (error) {
      countsUnavailable = true;
      console.error(
        "store: exact counts unavailable — falling back to in-memory totals for the rest of this session:",
        error.message,
      );
      return null;
    }
    return count ?? null;
  });
  // The chain must never reject, or one failure would poison every later count.
  countChain = next.catch(() => null);
  return next.catch(() => null);
}

export interface LeadsResult {
  leads: Lead[];
  loading: boolean;
  error: string | null;
  /** Every lead in the org, counted server-side. null = the count failed. */
  totalLeads: number | null;
  /** True when the org holds more records than are loaded here. */
  truncated: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
  reload: () => Promise<void>;
  setLeads: (l: Lead[]) => void;
}

export function useLeads(orgId: string | undefined): LeadsResult {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalLeads, setTotalLeads] = useState<number | null>(null);

  // The fallback for when the count query fails.
  //
  // `hasMore` was `totalLeads > leads.length` and nothing else, so a FAILED
  // count — null total — read as "no more records", the Load-more button and
  // the truncation banner both disappeared, and the org was quietly shown a
  // page while being told nothing. That is the exact failure this rewrite
  // existed to end, reintroduced through the error path.
  //
  // Without a total the only honest signal is the page itself: if the server
  // filled it right up to the largest page it has ever been willing to send,
  // there is probably more behind it. `serverPage` is observed rather than
  // assumed because PostgREST clamps to max-rows, so what we ASKED for is not a
  // usable yardstick for "was that page full?". Worst case on a tiny org whose
  // count also failed, this offers one Load-more that comes back empty — which
  // is a wasted click, not a hidden record.
  const serverPage = useRef(0);
  const [pageWasFull, setPageWasFull] = useState(false);

  const noteBatch = useCallback((rows: Lead[]) => {
    serverPage.current = Math.max(serverPage.current, rows.length);
    setPageWasFull(rows.length > 0 && rows.length >= serverPage.current);
  }, []);

  const load = useCallback(async () => {
    // `loading` initialises to true, so returning here without clearing it
    // leaves it true FOREVER. Every consumer renders a skeleton or a spinner
    // off that flag, so one failed organisation read hung the dashboard, the
    // leads table, the pipeline, the calendar and reports — permanently, with
    // no error anywhere. Nothing recovers, because `load` only re-runs when
    // orgId changes and orgId is what is missing.
    if (!orgId) { setLoading(false); return; }
    setLoading(true);

    const [pageRes, countRes] = await Promise.all([
      supabase
        .from("leads")
        .select("*")
        .eq("org_id", orgId)
        // `id` as a tiebreaker is what makes .range() pagination safe. Ordering
        // by created_at alone is not a total order — CSV imports write hundreds
        // of rows with identical timestamps, and Postgres is free to return
        // ties in a different order per request, so "Load more" would skip some
        // records and repeat others.
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(0, LEAD_PAGE_LIMIT - 1),
      // head:true fetches no rows at all — this is a COUNT, not a download, so
      // it stays cheap for a 50,000-record org and is immune to max-rows. Via
      // headCount() so it queues behind any other count rather than adding to a
      // burst of them; see the count layer above.
      headCount(async () => {
        const r = await supabase.from("leads").select("id", { count: "exact", head: true }).eq("org_id", orgId);
        return { count: r.count, error: r.error };
      }),
    ]);

    if (pageRes.error) {
      // Keep whatever we already had on screen rather than blanking it.
      console.error("useLeads: load failed —", pageRes.error.message);
      setError(pageRes.error.message);
    } else {
      setError(null);
      const rows = (pageRes.data as Lead[]) ?? [];
      noteBatch(rows);
      setLeads(rows);
    }

    // Not fatal — the records still render, and a null total makes callers show
    // "—" rather than a confident wrong number. `pageWasFull` above is what
    // keeps Load-more reachable in the meantime.
    setTotalLeads(countRes);

    setLoading(false);
  }, [orgId, noteBatch]);

  const loadMore = useCallback(async () => {
    // `loading` is in the guard as well as `loadingMore`: reload() and loadMore()
    // are both reachable from the UI at once (a bulk edit refreshes the list
    // while a Load-more is a click away), and appending page two of the OLD
    // window onto a freshly reloaded page one duplicates or skips whole blocks
    // of records depending on which request lands first.
    if (!orgId || loadingMore || loading) return;
    setLoadingMore(true);
    // Offset from what we actually HOLD, not from a page number. If max-rows
    // clipped the request, a page-number offset would skip whole blocks of
    // records permanently.
    const from = leads.length;
    const [pageRes, countRes] = await Promise.all([
      supabase
        .from("leads")
        .select("*")
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + LEAD_PAGE_LIMIT - 1),
      // Re-counted here, not just in load(): the count is a separate request
      // that can fail on its own, and if it failed at mount the total would
      // have stayed null for the whole life of the screen — no banner, no
      // denominator — until the user navigated away and back. Asking again on
      // the action the user just took is the cheapest way for that to heal —
      // hence `force`, which re-arms the count breaker for this one request.
      headCount(async () => {
        const r = await supabase.from("leads").select("id", { count: "exact", head: true }).eq("org_id", orgId);
        return { count: r.count, error: r.error };
      }, { force: true }),
    ]);

    if (pageRes.error) {
      console.error("useLeads: loadMore failed —", pageRes.error.message);
      setError(pageRes.error.message);
    } else {
      const rows = (pageRes.data as Lead[]) ?? [];
      noteBatch(rows);
      // De-duplicated by id: a record created between the two requests shifts
      // the whole window down by one, which otherwise re-appends a row that is
      // already on screen and inflates every count computed from the list.
      const seen = new Set(leads.map((l) => l.id));
      const next = rows.filter((l) => !seen.has(l.id));
      setLeads([...leads, ...next]);
    }
    // Never overwrite a known total with null — a count that worked at mount and
    // failed on this click should not blank the banner that is already correct.
    if (countRes !== null) setTotalLeads(countRes);
    setLoadingMore(false);
  }, [orgId, leads, loadingMore, loading, noteBatch]);

  useEffect(() => { void load(); }, [load]);

  const truncated = totalLeads !== null && totalLeads > leads.length;

  return {
    leads,
    loading,
    error,
    totalLeads,
    truncated,
    // With a total this is exact. Without one it falls back to the page signal,
    // so a failed count costs the user a denominator — not the way forward.
    hasMore: totalLeads !== null ? truncated : pageWasFull,
    loadingMore,
    loadMore,
    reload: load,
    setLeads,
  };
}

/**
 * Exact per-stage counts, straight from the server.
 *
 * The Pipeline column badges and the Dashboard's stage KPIs counted rows in the
 * loaded page, so a 5,000-record org saw its board describe the newest 1,000
 * and label those numbers as the stage totals. These are head+count requests —
 * no rows cross the wire — and they only run when the page is short of the
 * org's real total, because below that the in-memory counts are already exact.
 *
 * They run ONE AT A TIME. The first version issued them with Promise.all, which
 * on an eight-stage pipeline meant eight simultaneous head+count requests every
 * time Pipeline or Dashboard mounted — the same burst that SetupChecklist.tsx
 * records as 503ing four-at-a-time on this project's free tier. Sequential is
 * slower by a few hundred milliseconds on a screen that is already showing
 * approximate numbers, and the first failure stops the rest dead (see
 * headCount), so the worst case is one wasted request rather than eight.
 */
export function useStageCounts(
  orgId: string | undefined,
  stageKeys: string[],
  enabled: boolean,
): Record<string, number> | null {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const keyList = stageKeys.join(",");

  useEffect(() => {
    if (!orgId || !enabled || !keyList) { setCounts(null); return; }
    let cancelled = false;
    void (async () => {
      const out: Record<string, number> = {};
      for (const k of keyList.split(",")) {
        // Bail the moment the component moves on — otherwise switching stages
        // or leaving the screen leaves a queue of counts nobody will read.
        if (cancelled) return;
        const c = await headCount(async () => {
          const r = await supabase
            .from("leads")
            .select("id", { count: "exact", head: true })
            .eq("org_id", orgId)
            .eq("stage_key", k);
          return { count: r.count, error: r.error };
        });
        // All-or-nothing. A partial map would render some columns exact and
        // others off by thousands, with nothing distinguishing them.
        if (c === null) { if (!cancelled) setCounts(null); return; }
        out[k] = c;
      }
      if (!cancelled) setCounts(out);
    })();
    return () => { cancelled = true; };
  }, [orgId, keyList, enabled]);

  return counts;
}

/**
 * Exact count of open records carrying a follow-up date.
 *
 * The Calendar header said "N scheduled follow-ups" from the loaded page, which
 * for a truncated org is a number smaller than reality on the one screen whose
 * whole job is telling you nobody has been missed.
 */
export function useFollowUpCount(
  orgId: string | undefined,
  doneStageKeys: string[],
  enabled: boolean,
): number | null {
  const [count, setCount] = useState<number | null>(null);
  const doneList = doneStageKeys.join(",");

  useEffect(() => {
    if (!orgId || !enabled) { setCount(null); return; }
    let cancelled = false;
    void (async () => {
      const c = await headCount(async () => {
        let q = supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("org_id", orgId)
          .not("next_follow_up_at", "is", null);
        if (doneList) {
          // `stage_key.is.null` is part of the OR deliberately: `not.in.(...)`
          // is a NULL comparison for rows that never had stage_key written, and
          // SQL drops those rather than keeping them — which would undercount
          // legacy records instead of the intended won/lost exclusion.
          q = q.or(`stage_key.is.null,stage_key.not.in.(${doneList})`);
        }
        const r = await q;
        return { count: r.count, error: r.error };
      });
      if (cancelled) return;
      setCount(c);
    })();
    return () => { cancelled = true; };
  }, [orgId, doneList, enabled]);

  return count;
}

/**
 * Every lead in the org, fetched in batches.
 *
 * The CSV export is the data-portability promise the product page makes most
 * loudly — "the honest test of a CRM is how easy it is to leave". It ran off
 * the same loaded page as the charts, so a Business customer who bought 50,000
 * records could not export record 1,001. Batched .range() walks past max-rows
 * whatever it is set to; `onProgress` exists because a 50,000-row export is
 * tens of seconds and a frozen button reads as a broken one.
 */
export async function fetchAllLeads(
  orgId: string,
  opts: { createdAfter?: string | null; onProgress?: (loaded: number, total: number | null) => void } = {},
): Promise<{ leads: Lead[]; error: string | null; warning: string | null }> {
  const BATCH = 1000;
  // An absolute stop, because every other exit here can be defeated. `total` is
  // the ordinary guard, but the count below is the same head+count request that
  // 503s on this project — when it fails `total` is null and that guard never
  // fires at all. The only exit left is then an empty batch, which is precisely
  // what the failure the old comment described never produces: a proxy that
  // ignores Range re-serves page one forever, every row is already in `seen`,
  // `all` stops growing, and the tab spins until the user kills it. 200 batches
  // is 200,000 records — four times the largest plan — so reaching this means
  // something is wrong, not that the org is large.
  const MAX_BATCHES = 200;
  const all: Lead[] = [];
  const seen = new Set<string>();

  const countQuery = supabase.from("leads").select("id", { count: "exact", head: true }).eq("org_id", orgId);
  // The count error was discarded, which is what made every guard below toothless
  // AND left the caller no way to know the file might be short. Not fatal — an
  // export without a denominator is still an export — but it decides whether we
  // can honestly call the result complete.
  const { count: total, error: countErr } = opts.createdAfter
    ? await countQuery.gte("created_at", opts.createdAfter)
    : await countQuery;
  if (countErr) {
    console.error("fetchAllLeads: total count failed, completeness cannot be verified —", countErr.message);
  }

  // `from` advances by what the server ACTUALLY returned, never by BATCH.
  // max-rows is allowed to be lower than BATCH — if it were 500, stepping by
  // 1,000 would skip every other block of 500 records and the export would be
  // half a file that looks whole.
  let from = 0;
  let exhausted = false;
  for (let batchNo = 0; batchNo < MAX_BATCHES; batchNo++) {
    let q = supabase
      .from("leads")
      .select("*")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + BATCH - 1);
    if (opts.createdAfter) q = q.gte("created_at", opts.createdAfter);

    const { data, error } = await q;
    // Partial data with no warning is the exact failure this function exists to
    // end, so a mid-way error aborts and says so rather than writing a short
    // file that looks complete.
    if (error) return { leads: all, error: error.message, warning: null };

    const batch = (data as Lead[]) ?? [];
    if (batch.length === 0) { exhausted = true; break; }   // nothing past here
    for (const l of batch) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      all.push(l);
    }
    from += batch.length;
    opts.onProgress?.(all.length, total ?? null);

    // `from` is a server OFFSET and advances by everything that came back,
    // including the rows we just de-duplicated away — so `from >= total` is NOT
    // the statement "we hold them all". On its own it let a single concurrent
    // insert (which shifts the window down by one and re-serves a row already
    // in `seen`) end the loop one record short and return error: null. Both
    // halves have to hold now.
    if (typeof total === "number" && all.length >= total && from >= total) { exhausted = true; break; }
  }

  // Say it out loud. A short CSV that opens cleanly and reports no error is the
  // worst outcome this function has: the customer finds out months later, from
  // the records that are not in it.
  const totalKnown = typeof total === "number" ? total : null;
  const missing = totalKnown === null ? 0 : Math.max(0, totalKnown - all.length);
  const warning = !exhausted
    ? `Stopped after ${all.length.toLocaleString("en-IN")} records at this screen's safety limit — the server kept returning rows without ever reaching the end, so the file is incomplete.`
    : totalKnown !== null && missing > 0
      ? `The file holds ${all.length.toLocaleString("en-IN")} records but your workspace reports ${totalKnown.toLocaleString("en-IN")}. ${missing.toLocaleString("en-IN")} could not be read, so this export is incomplete.`
      : null;

  return { leads: all, error: null, warning };
}
