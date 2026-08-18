// Industry UI registry.
//
// The database (see 20260817090000_multi_industry_foundation.sql) owns the
// *data* side of an industry pack: stages, fields, terminology, agent persona.
// This file owns the *interface* side: which KPIs a dashboard shows, what the
// quick actions are, and which sector-specific tool appears.
//
// Why the split: stages and fields are per-tenant and editable at runtime, so
// they must live in the DB. Dashboards and tools are code, so they live here
// and ship with the app.
//
// The guiding rule: a hospital should not feel like a study-abroad CRM with
// the words swapped. It should feel built for hospitals. That means different
// numbers on the dashboard, different verbs on the buttons, and a tool that
// only makes sense in that sector.

import type { Lead } from "./types";

export type KpiKind =
  | "total"            // all open leads
  | "new_today"
  | "due_today"        // follow-up due
  | "won_this_month"
  | "conversion"       // won / total, %
  | "avg_score"
  | "stage_count"      // count in a named stage
  | "sum_field"        // sum of a numeric custom field
  | "overdue";         // follow-up date in the past

export interface KpiDef {
  key: string;
  label: string;
  icon: string;
  kind: KpiKind;
  /** for stage_count */
  stageKey?: string;
  /** for sum_field */
  field?: string;
  hint?: string;
}

export interface QuickAction {
  key: string;
  label: string;
  icon: string;
  /** stage the lead moves to when this action is taken */
  toStage?: string;
  /** activity type logged */
  logAs?: "call" | "meeting" | "note" | "whatsapp" | "email";
}

export type ToolKind =
  | "none"
  | "triage"        // hospital/clinic — urgency banding
  | "emi"           // finance — EMI estimate
  | "budget_match"  // real estate — affordability band
  | "ctc_compare"   // recruitment — hike calculation
  | "trip_cost"     // travel — per-head cost
  | "roi"           // study abroad — cost vs earning potential
  | "quote";        // home services / automotive — quick quote

export interface IndustryUi {
  slug: string;
  name: string;
  icon: string;
  /** accent colour; falls back to brand amber when absent */
  accent?: string;
  accentSoft?: string;
  leadNoun: string;
  leadNounPlural: string;
  /** verb used on the primary create button, e.g. "Add Patient" */
  addLabel: string;
  kpis: KpiDef[];
  quickActions: QuickAction[];
  tool: ToolKind;
  toolLabel?: string;
  /** columns (lead fields or custom keys) shown by default in the list */
  listColumns: string[];
  /** short line under the dashboard title */
  dashboardNote: string;
}

const BASE_ACTIONS: QuickAction[] = [
  { key: "call", label: "Log call", icon: "📞", logAs: "call" },
  { key: "note", label: "Add note", icon: "📝", logAs: "note" },
];

export const INDUSTRIES: Record<string, IndustryUi> = {
  hospital: {
    slug: "hospital",
    name: "Hospital & Clinic",
    icon: "🏥",
    accent: "#0ea5e9",
    accentSoft: "#e0f2fe",
    leadNoun: "Patient",
    leadNounPlural: "Patients",
    addLabel: "Add Patient",
    dashboardNote: "Enquiries, appointments and admissions at a glance",
    kpis: [
      { key: "open", label: "Active Patients", icon: "🧑‍⚕️", kind: "total" },
      { key: "appts", label: "Appointments Booked", icon: "📅", kind: "stage_count", stageKey: "appointment_booked" },
      { key: "admitted", label: "Currently Admitted", icon: "🛏️", kind: "stage_count", stageKey: "admitted" },
      { key: "due", label: "Follow-ups Due", icon: "⏰", kind: "due_today", hint: "Call these today" },
      { key: "overdue", label: "Overdue", icon: "🚨", kind: "overdue", hint: "Past their follow-up date" },
    ],
    quickActions: [
      { key: "book", label: "Book appointment", icon: "📅", toStage: "appointment_booked", logAs: "meeting" },
      { key: "consulted", label: "Mark consulted", icon: "✅", toStage: "consulted", logAs: "meeting" },
      ...BASE_ACTIONS,
    ],
    tool: "triage",
    toolLabel: "Triage & urgency",
    listColumns: ["name", "phone", "department", "appointment_at", "stage", "score"],
  },

  clinic: {
    slug: "clinic",
    name: "Dental & Aesthetic Clinic",
    icon: "🦷",
    accent: "#14b8a6",
    accentSoft: "#ccfbf1",
    leadNoun: "Patient",
    leadNounPlural: "Patients",
    addLabel: "Add Patient",
    dashboardNote: "Treatment enquiries, quotes and repeat visits",
    kpis: [
      { key: "open", label: "Active Patients", icon: "🦷", kind: "total" },
      { key: "quoted", label: "Quotes Out", icon: "💬", kind: "stage_count", stageKey: "quote_given" },
      { key: "pipeline", label: "Quoted Value", icon: "💰", kind: "sum_field", field: "quote_amount" },
      { key: "due", label: "Follow-ups Due", icon: "⏰", kind: "due_today" },
      { key: "conv", label: "Conversion", icon: "📈", kind: "conversion" },
    ],
    quickActions: [
      { key: "quote", label: "Send quote", icon: "💬", toStage: "quote_given", logAs: "email" },
      { key: "start", label: "Start treatment", icon: "▶️", toStage: "treatment_started", logAs: "note" },
      ...BASE_ACTIONS,
    ],
    tool: "quote",
    toolLabel: "Quick quote",
    listColumns: ["name", "phone", "treatment", "quote_amount", "stage", "score"],
  },

  study_abroad: {
    slug: "study_abroad",
    name: "Study Abroad",
    icon: "🎓",
    leadNoun: "Student",
    leadNounPlural: "Students",
    addLabel: "Add Student",
    dashboardNote: "Counselling, applications and visa progress",
    kpis: [
      { key: "open", label: "Active Students", icon: "🎓", kind: "total" },
      { key: "apps", label: "In Application", icon: "📄", kind: "stage_count", stageKey: "application" },
      { key: "visa", label: "At Visa Stage", icon: "🛂", kind: "stage_count", stageKey: "visa" },
      { key: "due", label: "Due Today", icon: "⏰", kind: "due_today" },
      { key: "overdue", label: "Overdue", icon: "🚨", kind: "overdue", hint: "Past their follow-up date" },
      { key: "conv", label: "Enrolment Rate", icon: "📈", kind: "conversion" },
    ],
    quickActions: [
      { key: "counselled", label: "Mark counselled", icon: "🗣️", toStage: "counselled", logAs: "meeting" },
      { key: "application", label: "Move to application", icon: "📄", toStage: "application", logAs: "note" },
      ...BASE_ACTIONS,
    ],
    tool: "roi",
    toolLabel: "Course ROI estimate",
    listColumns: ["name", "phone", "target_country", "course_level", "intake", "stage", "score"],
  },

  education: {
    slug: "education",
    name: "School & Coaching",
    icon: "📚",
    accent: "#8b5cf6",
    accentSoft: "#ede9fe",
    leadNoun: "Enquiry",
    leadNounPlural: "Enquiries",
    addLabel: "Add Enquiry",
    dashboardNote: "Admissions enquiries, demos and enrolments",
    kpis: [
      { key: "open", label: "Open Enquiries", icon: "📚", kind: "total" },
      { key: "demo", label: "Demo Classes", icon: "🎬", kind: "stage_count", stageKey: "demo_class" },
      { key: "fee", label: "Fees Pending", icon: "💳", kind: "stage_count", stageKey: "fee_pending" },
      { key: "new", label: "New Today", icon: "✨", kind: "new_today" },
      { key: "conv", label: "Enrolment Rate", icon: "📈", kind: "conversion" },
    ],
    quickActions: [
      { key: "demo", label: "Book demo", icon: "🎬", toStage: "demo_class", logAs: "meeting" },
      { key: "enrol", label: "Mark enrolled", icon: "🎉", toStage: "enrolled", logAs: "note" },
      ...BASE_ACTIONS,
    ],
    tool: "quote",
    toolLabel: "Fee quote",
    listColumns: ["name", "phone", "grade", "program", "stage", "score"],
  },

  real_estate: {
    slug: "real_estate",
    name: "Real Estate",
    icon: "🏡",
    accent: "#059669",
    accentSoft: "#d1fae5",
    leadNoun: "Buyer",
    leadNounPlural: "Buyers",
    addLabel: "Add Buyer",
    dashboardNote: "Site visits, negotiations and closings",
    kpis: [
      { key: "open", label: "Active Buyers", icon: "🏡", kind: "total" },
      { key: "visits", label: "Site Visits", icon: "🚗", kind: "stage_count", stageKey: "site_visit" },
      { key: "pipeline", label: "Pipeline Value", icon: "💰", kind: "sum_field", field: "budget_max" },
      { key: "due", label: "Follow-ups Due", icon: "⏰", kind: "due_today" },
      { key: "conv", label: "Close Rate", icon: "📈", kind: "conversion" },
    ],
    quickActions: [
      { key: "visit", label: "Schedule site visit", icon: "🚗", toStage: "site_visit", logAs: "meeting" },
      { key: "negotiate", label: "Move to negotiation", icon: "🤝", toStage: "negotiation", logAs: "note" },
      ...BASE_ACTIONS,
    ],
    tool: "budget_match",
    toolLabel: "Affordability check",
    listColumns: ["name", "phone", "property_type", "locality", "budget_max", "stage", "score"],
  },

  legal: {
    slug: "legal",
    name: "Law Firm",
    icon: "⚖️",
    accent: "#4f46e5",
    accentSoft: "#e0e7ff",
    leadNoun: "Client",
    leadNounPlural: "Clients",
    addLabel: "Add Client",
    dashboardNote: "Intake, conflict checks and retainers",
    kpis: [
      { key: "open", label: "Open Matters", icon: "⚖️", kind: "total" },
      { key: "consult", label: "Consultations", icon: "🗣️", kind: "stage_count", stageKey: "consultation" },
      { key: "proposal", label: "Proposals Out", icon: "📜", kind: "stage_count", stageKey: "proposal" },
      { key: "due", label: "Follow-ups Due", icon: "⏰", kind: "due_today" },
      { key: "conv", label: "Retainer Rate", icon: "📈", kind: "conversion" },
    ],
    quickActions: [
      { key: "consult", label: "Log consultation", icon: "🗣️", toStage: "consultation", logAs: "meeting" },
      { key: "proposal", label: "Send proposal", icon: "📜", toStage: "proposal", logAs: "email" },
      ...BASE_ACTIONS,
    ],
    tool: "none",
    listColumns: ["name", "phone", "matter_type", "urgency", "stage", "score"],
  },

  fitness: {
    slug: "fitness",
    name: "Gym & Wellness",
    icon: "💪",
    accent: "#f43f5e",
    accentSoft: "#ffe4e6",
    leadNoun: "Member",
    leadNounPlural: "Members",
    addLabel: "Add Member",
    dashboardNote: "Trials, conversions and renewals",
    kpis: [
      { key: "open", label: "Prospects", icon: "💪", kind: "total" },
      { key: "trials", label: "Trials Booked", icon: "🎟️", kind: "stage_count", stageKey: "trial_booked" },
      { key: "members", label: "New Members", icon: "🎉", kind: "won_this_month" },
      { key: "due", label: "Follow-ups Due", icon: "⏰", kind: "due_today" },
      { key: "conv", label: "Trial → Member", icon: "📈", kind: "conversion" },
    ],
    quickActions: [
      { key: "trial", label: "Book trial", icon: "🎟️", toStage: "trial_booked", logAs: "meeting" },
      { key: "member", label: "Convert to member", icon: "🎉", toStage: "member", logAs: "note" },
      ...BASE_ACTIONS,
    ],
    tool: "quote",
    toolLabel: "Plan quote",
    listColumns: ["name", "phone", "goal", "plan_interest", "stage", "score"],
  },

  finance: {
    slug: "finance",
    name: "Financial Services",
    icon: "💰",
    accent: "#0d9488",
    accentSoft: "#ccfbf1",
    leadNoun: "Applicant",
    leadNounPlural: "Applicants",
    addLabel: "Add Applicant",
    dashboardNote: "Eligibility, underwriting and disbursal",
    kpis: [
      { key: "open", label: "Active Applications", icon: "📋", kind: "total" },
      { key: "underwriting", label: "In Underwriting", icon: "🔍", kind: "stage_count", stageKey: "underwriting" },
      { key: "value", label: "Requested Value", icon: "💰", kind: "sum_field", field: "amount" },
      { key: "due", label: "Follow-ups Due", icon: "⏰", kind: "due_today" },
      { key: "conv", label: "Disbursal Rate", icon: "📈", kind: "conversion" },
    ],
    quickActions: [
      { key: "docs", label: "Documents collected", icon: "📎", toStage: "documents", logAs: "note" },
      { key: "underwrite", label: "Send to underwriting", icon: "🔍", toStage: "underwriting", logAs: "note" },
      ...BASE_ACTIONS,
    ],
    tool: "emi",
    toolLabel: "EMI estimate",
    listColumns: ["name", "phone", "product", "amount", "stage", "score"],
  },

  automotive: {
    slug: "automotive",
    name: "Automotive Dealership",
    icon: "🚗",
    accent: "#dc2626",
    accentSoft: "#fee2e2",
    leadNoun: "Buyer",
    leadNounPlural: "Buyers",
    addLabel: "Add Buyer",
    dashboardNote: "Test drives, bookings and deliveries",
    kpis: [
      { key: "open", label: "Active Buyers", icon: "🚗", kind: "total" },
      { key: "drives", label: "Test Drives", icon: "🛞", kind: "stage_count", stageKey: "test_drive" },
      { key: "booked", label: "Booked", icon: "📝", kind: "stage_count", stageKey: "booked" },
      { key: "delivered", label: "Delivered (month)", icon: "🎉", kind: "won_this_month" },
      { key: "conv", label: "Close Rate", icon: "📈", kind: "conversion" },
    ],
    quickActions: [
      { key: "drive", label: "Book test drive", icon: "🛞", toStage: "test_drive", logAs: "meeting" },
      { key: "quote", label: "Send quotation", icon: "🧾", toStage: "quotation", logAs: "email" },
      ...BASE_ACTIONS,
    ],
    tool: "emi",
    toolLabel: "Finance / EMI",
    listColumns: ["name", "phone", "model", "fuel", "stage", "score"],
  },

  travel: {
    slug: "travel",
    name: "Travel & Tourism",
    icon: "✈️",
    accent: "#0284c7",
    accentSoft: "#e0f2fe",
    leadNoun: "Traveller",
    leadNounPlural: "Travellers",
    addLabel: "Add Traveller",
    dashboardNote: "Itineraries, bookings and departures",
    kpis: [
      { key: "open", label: "Active Enquiries", icon: "✈️", kind: "total" },
      { key: "itin", label: "Itineraries Sent", icon: "🗺️", kind: "stage_count", stageKey: "itinerary_sent" },
      { key: "value", label: "Pipeline Value", icon: "💰", kind: "sum_field", field: "budget" },
      { key: "due", label: "Follow-ups Due", icon: "⏰", kind: "due_today" },
      { key: "conv", label: "Booking Rate", icon: "📈", kind: "conversion" },
    ],
    quickActions: [
      { key: "itin", label: "Send itinerary", icon: "🗺️", toStage: "itinerary_sent", logAs: "email" },
      { key: "book", label: "Mark booked", icon: "🎫", toStage: "booked", logAs: "note" },
      ...BASE_ACTIONS,
    ],
    tool: "trip_cost",
    toolLabel: "Trip cost per head",
    listColumns: ["name", "phone", "destination", "travel_date", "pax", "stage", "score"],
  },

  recruitment: {
    slug: "recruitment",
    name: "Recruitment & Staffing",
    icon: "🧑‍💼",
    accent: "#7c3aed",
    accentSoft: "#ede9fe",
    leadNoun: "Candidate",
    leadNounPlural: "Candidates",
    addLabel: "Add Candidate",
    dashboardNote: "Screening, interviews and placements",
    kpis: [
      { key: "open", label: "Active Candidates", icon: "🧑‍💼", kind: "total" },
      { key: "interview", label: "In Interview", icon: "🗣️", kind: "stage_count", stageKey: "interview" },
      { key: "offer", label: "Offers Out", icon: "📨", kind: "stage_count", stageKey: "offer" },
      { key: "placed", label: "Placed (month)", icon: "🎉", kind: "won_this_month" },
      { key: "conv", label: "Placement Rate", icon: "📈", kind: "conversion" },
    ],
    quickActions: [
      { key: "submit", label: "Submit to client", icon: "📤", toStage: "submitted", logAs: "email" },
      { key: "interview", label: "Schedule interview", icon: "🗣️", toStage: "interview", logAs: "meeting" },
      ...BASE_ACTIONS,
    ],
    tool: "ctc_compare",
    toolLabel: "CTC & hike",
    listColumns: ["name", "phone", "role", "experience_years", "expected_ctc", "stage", "score"],
  },

  home_services: {
    slug: "home_services",
    name: "Home Services",
    icon: "🔧",
    accent: "#ea580c",
    accentSoft: "#ffedd5",
    leadNoun: "Customer",
    leadNounPlural: "Customers",
    addLabel: "Add Customer",
    dashboardNote: "Site visits, quotes and scheduled jobs",
    kpis: [
      { key: "open", label: "Open Jobs", icon: "🔧", kind: "total" },
      { key: "visits", label: "Site Visits", icon: "📍", kind: "stage_count", stageKey: "site_visit" },
      { key: "value", label: "Quoted Value", icon: "💰", kind: "sum_field", field: "quote_amount" },
      { key: "sched", label: "Scheduled", icon: "📅", kind: "stage_count", stageKey: "scheduled" },
      { key: "conv", label: "Win Rate", icon: "📈", kind: "conversion" },
    ],
    quickActions: [
      { key: "visit", label: "Schedule site visit", icon: "📍", toStage: "site_visit", logAs: "meeting" },
      { key: "quote", label: "Send quote", icon: "🧾", toStage: "quoted", logAs: "email" },
      ...BASE_ACTIONS,
    ],
    tool: "quote",
    toolLabel: "Job quote",
    listColumns: ["name", "phone", "service", "quote_amount", "stage", "score"],
  },

  b2b_saas: {
    slug: "b2b_saas",
    name: "B2B / SaaS Sales",
    icon: "💻",
    accent: "#2563eb",
    accentSoft: "#dbeafe",
    leadNoun: "Lead",
    leadNounPlural: "Leads",
    addLabel: "Add Lead",
    dashboardNote: "Demos, trials and closed revenue",
    kpis: [
      { key: "open", label: "Open Pipeline", icon: "💻", kind: "total" },
      { key: "demo", label: "Demos", icon: "🖥️", kind: "stage_count", stageKey: "demo" },
      { key: "mrr", label: "Pipeline MRR", icon: "💰", kind: "sum_field", field: "mrr_potential" },
      { key: "won", label: "Won (month)", icon: "🎉", kind: "won_this_month" },
      { key: "conv", label: "Win Rate", icon: "📈", kind: "conversion" },
    ],
    quickActions: [
      { key: "demo", label: "Book demo", icon: "🖥️", toStage: "demo", logAs: "meeting" },
      { key: "trial", label: "Start trial", icon: "🧪", toStage: "trial", logAs: "note" },
      ...BASE_ACTIONS,
    ],
    tool: "none",
    listColumns: ["name", "company", "team_size", "mrr_potential", "stage", "score"],
  },

  general: {
    slug: "general",
    name: "General Business",
    icon: "🏢",
    leadNoun: "Lead",
    leadNounPlural: "Leads",
    addLabel: "Add Lead",
    dashboardNote: "Your pipeline at a glance",
    kpis: [
      { key: "open", label: "Open Leads", icon: "🏢", kind: "total" },
      { key: "new", label: "New Today", icon: "✨", kind: "new_today" },
      { key: "due", label: "Follow-ups Due", icon: "⏰", kind: "due_today" },
      { key: "score", label: "Avg Score", icon: "⭐", kind: "avg_score" },
      { key: "conv", label: "Win Rate", icon: "📈", kind: "conversion" },
    ],
    quickActions: BASE_ACTIONS,
    tool: "none",
    listColumns: ["name", "phone", "email", "stage", "score"],
  },
};

export const DEFAULT_INDUSTRY = INDUSTRIES.general;

export function getIndustry(slug: string | null | undefined): IndustryUi {
  if (!slug) return DEFAULT_INDUSTRY;
  return INDUSTRIES[slug] ?? DEFAULT_INDUSTRY;
}

// ── KPI computation ─────────────────────────────────────────────────────────
// Computed client-side over the org's leads. At current volumes (tens to low
// thousands) this is far cheaper than a round trip per card; if an org ever
// crosses ~10k leads these should move into a Postgres view.

const sameDay = (iso: string | null, d: Date) => {
  if (!iso) return false;
  const x = new Date(iso);
  return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate();
};

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};

export interface StageMeta { key: string; is_won: boolean; is_lost: boolean }

export function computeKpi(
  def: KpiDef,
  leads: Lead[],
  stages: StageMeta[],
  now = new Date(),
): { value: string; raw: number } {
  const wonKeys = new Set(stages.filter((s) => s.is_won).map((s) => s.key));
  const lostKeys = new Set(stages.filter((s) => s.is_lost).map((s) => s.key));
  const keyOf = (l: Lead) => l.stage_key ?? l.stage;
  const open = leads.filter((l) => !wonKeys.has(keyOf(l)) && !lostKeys.has(keyOf(l)));

  const fmt = (n: number) => n.toLocaleString("en-IN");
  const money = (n: number) =>
    n >= 10_000_000 ? `₹${(n / 10_000_000).toFixed(2)}Cr`
    : n >= 100_000 ? `₹${(n / 100_000).toFixed(1)}L`
    : `₹${fmt(Math.round(n))}`;

  switch (def.kind) {
    case "total":
      return { value: fmt(open.length), raw: open.length };

    case "new_today": {
      const n = leads.filter((l) => sameDay(l.created_at, now)).length;
      return { value: fmt(n), raw: n };
    }

    case "due_today": {
      const n = open.filter((l) => sameDay(l.next_follow_up_at, now)).length;
      return { value: fmt(n), raw: n };
    }

    case "overdue": {
      const n = open.filter(
        (l) => l.next_follow_up_at && new Date(l.next_follow_up_at) < now && !sameDay(l.next_follow_up_at, now),
      ).length;
      return { value: fmt(n), raw: n };
    }

    case "won_this_month": {
      const n = leads.filter(
        (l) =>
          wonKeys.has(keyOf(l)) &&
          new Date(l.updated_at).getMonth() === now.getMonth() &&
          new Date(l.updated_at).getFullYear() === now.getFullYear(),
      ).length;
      return { value: fmt(n), raw: n };
    }

    case "conversion": {
      const won = leads.filter((l) => wonKeys.has(keyOf(l))).length;
      const decided = won + leads.filter((l) => lostKeys.has(keyOf(l))).length;
      const pct = decided === 0 ? 0 : Math.round((won / decided) * 100);
      return { value: `${pct}%`, raw: pct };
    }

    case "avg_score": {
      if (leads.length === 0) return { value: "—", raw: 0 };
      const avg = Math.round(leads.reduce((a, l) => a + (l.score ?? 0), 0) / leads.length);
      return { value: String(avg), raw: avg };
    }

    case "stage_count": {
      const n = leads.filter((l) => keyOf(l) === def.stageKey).length;
      return { value: fmt(n), raw: n };
    }

    case "sum_field": {
      const total = open.reduce((a, l) => {
        const direct = def.field === "budget_inr" ? l.budget_inr : undefined;
        return a + num(direct ?? l.custom?.[def.field ?? ""]);
      }, 0);
      return { value: total === 0 ? "—" : money(total), raw: total };
    }
  }
}
