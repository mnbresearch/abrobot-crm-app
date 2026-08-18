import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { supabase } from "./supabase";
import { getIndustry, type IndustryUi } from "./industries";
import type { FieldDef, IndustryRow, Lead, PipelineStage, Organization, Profile } from "./types";

// Single app-wide context. The legacy app used a similar shape (Ut() in the
// bundle exposed { org, profile, isAdmin }), so behaviour stays familiar.

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
  needsOnboarding: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
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

  const load = useCallback(async () => {
    const { data: s } = await supabase.auth.getSession();
    if (!s.session) {
      setSession(false);
      setProfile(null);
      setOrg(null);
      setLoading(false);
      return;
    }
    setSession(true);

    const uid = s.session.user.id;
    const { data: prof } = await supabase.from("profiles").select("*").eq("id", uid).single();
    setProfile((prof as Profile) ?? null);

    if (prof?.org_id) {
      // Fetched in parallel — these are independent and the dashboard needs
      // all of them before it can render a single correct number.
      const [orgRes, stageRes, fieldRes, indRes] = await Promise.all([
        supabase.from("organizations").select("*").eq("id", prof.org_id).single(),
        supabase.from("pipeline_stages").select("*").eq("org_id", prof.org_id).order("position"),
        supabase.from("field_defs").select("*").eq("org_id", prof.org_id).order("position"),
        supabase.from("industries").select("*").eq("active", true).order("position"),
      ]);
      setOrg((orgRes.data as Organization) ?? null);
      setStages((stageRes.data as PipelineStage[]) ?? []);
      setFields((fieldRes.data as FieldDef[]) ?? []);
      setIndustries((indRes.data as IndustryRow[]) ?? []);
    } else {
      const { data: ind } = await supabase.from("industries").select("*").eq("active", true).order("position");
      setIndustries((ind as IndustryRow[]) ?? []);
    }
    setLoading(false);
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
    // A brand-new org has no stages until a pack is applied — that is the
    // signal to show the industry picker.
    needsOnboarding: !!profile?.org_id && stages.length === 0,
    refresh: load,
    signOut: async () => {
      await supabase.auth.signOut();
      setSession(false);
      setProfile(null);
      setOrg(null);
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

export function useLeads(orgId: string | undefined) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    const { data } = await supabase
      .from("leads")
      .select("*")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(2000);
    setLeads((data as Lead[]) ?? []);
    setLoading(false);
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  return { leads, loading, reload: load, setLeads };
}
