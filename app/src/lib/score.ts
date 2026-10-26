// AbroBot CRM — Client-side explainable lead scoring engine.
// Mirrors supabase/functions/_shared/score.ts with industry-aware custom field extraction.

export const WEIGHTS = {
  phone: 15, // reachable by call/WhatsApp — the strongest intent signal
  email: 10,
  budget: 25, // funded intent
  country: 8,
  course: 6,
  course_level: 6,
  intake: 10, // nearer intake = hotter
  engagement: 12, // replies / inbound messages / activities logged
  stage: 8, // progression through the pipeline
} as const;

const BUDGET_BANDS: [number, number][] = [
  [4_000_000, 1.0], // ≥ 40L — premium, fully funded
  [2_500_000, 0.85],
  [1_500_000, 0.7],
  [1_000_000, 0.5],
  [500_000, 0.3],
  [0, 0.15], // stated a budget at all
];

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  spring: 1, summer: 5, fall: 8, autumn: 8, winter: 11,
};

export function monthsToIntake(intake?: string | null, now = new Date()): number | null {
  if (!intake) return null;
  const s = intake.toLowerCase();
  const year = s.match(/(20\d{2})/)?.[1];
  if (!year) return null;
  const monthKey = Object.keys(MONTHS).find((m) => s.includes(m));
  const month = monthKey ? MONTHS[monthKey] : 6;
  const target = new Date(Number(year), month, 1);
  return (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
}

const STAGE_PROGRESS: Record<string, number> = {
  new: 0,
  sourced: 0.1,
  contacted: 0.25,
  counselled: 0.5,
  application: 0.75,
  offer: 0.9,
  visa: 1.0,
  enrolled: 1.0,
  won: 1.0,
  closed_won: 1.0,
  lost: 0,
  closed_lost: 0,
};

export interface ScoreInput {
  email?: string | null;
  phone?: string | null;
  budget_inr?: number | string | unknown;
  target_country?: string | null;
  course?: string | null;
  course_level?: string | null;
  intake?: string | null;
  stage?: string | null;
  stage_key?: string | null;
  engagement_count?: number | null;
  custom?: Record<string, unknown> | null;
}

export interface ScoreBreakdownItem {
  key: string;
  label: string;
  points: number;
  max: number;
  detail: string;
}

export interface ScoreResult {
  score: number;
  breakdown: Record<string, number>;
  items: ScoreBreakdownItem[];
}

export function scoreLead(lead: ScoreInput, now = new Date()): ScoreResult {
  const b: Record<string, number> = {};
  const items: ScoreBreakdownItem[] = [];

  // Phone
  b.phone = lead.phone ? WEIGHTS.phone : 0;
  items.push({
    key: "phone",
    label: "Phone / WhatsApp",
    points: b.phone,
    max: WEIGHTS.phone,
    detail: lead.phone ? `Provided (${lead.phone})` : "Missing",
  });

  // Email
  b.email = lead.email ? WEIGHTS.email : 0;
  items.push({
    key: "email",
    label: "Email Address",
    points: b.email,
    max: WEIGHTS.email,
    detail: lead.email ? `Provided (${lead.email})` : "Missing",
  });

  // Budget
  const budgetRaw = lead.budget_inr ?? lead.custom?.budget_inr ?? lead.custom?.budget;
  const budget = typeof budgetRaw === "string" ? Number(budgetRaw.replace(/[^0-9.]/g, "")) : Number(budgetRaw);
  if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
    const band = BUDGET_BANDS.find(([floor]) => budget >= floor);
    b.budget = Math.round(WEIGHTS.budget * (band ? band[1] : 0.15));
    items.push({
      key: "budget",
      label: "Declared Budget",
      points: b.budget,
      max: WEIGHTS.budget,
      detail: `₹${budget.toLocaleString("en-IN")}`,
    });
  } else {
    b.budget = 0;
    items.push({
      key: "budget",
      label: "Declared Budget",
      points: 0,
      max: WEIGHTS.budget,
      detail: "Not stated",
    });
  }

  // Country
  const country = lead.target_country ?? (lead.custom?.target_country as string) ?? (lead.custom?.country as string);
  b.country = country ? WEIGHTS.country : 0;
  items.push({
    key: "country",
    label: "Target Country / Market",
    points: b.country,
    max: WEIGHTS.country,
    detail: country ? String(country) : "Not specified",
  });

  // Course / Solution
  const course = lead.course ?? (lead.custom?.course as string) ?? (lead.custom?.service as string) ?? (lead.custom?.program as string);
  b.course = course ? WEIGHTS.course : 0;
  items.push({
    key: "course",
    label: "Course / Service Category",
    points: b.course,
    max: WEIGHTS.course,
    detail: course ? String(course) : "Not specified",
  });

  // Course level / Project scope
  const level = lead.course_level ?? (lead.custom?.course_level as string) ?? (lead.custom?.tier as string);
  b.course_level = level ? WEIGHTS.course_level : 0;
  items.push({
    key: "course_level",
    label: "Program Level / Requirement",
    points: b.course_level,
    max: WEIGHTS.course_level,
    detail: level ? String(level) : "Not specified",
  });

  // Intake / Timeline Proximity
  const intake = lead.intake ?? (lead.custom?.intake as string) ?? (lead.custom?.timeline as string);
  const months = monthsToIntake(intake, now);
  if (months === null) {
    b.intake = 0;
    items.push({ key: "intake", label: "Timeline / Intake", points: 0, max: WEIGHTS.intake, detail: intake ? String(intake) : "Not set" });
  } else if (months < 0) {
    b.intake = 0;
    items.push({ key: "intake", label: "Timeline / Intake", points: 0, max: WEIGHTS.intake, detail: `${intake} (Passed)` });
  } else if (months <= 3) {
    b.intake = WEIGHTS.intake;
    items.push({ key: "intake", label: "Timeline / Intake", points: b.intake, max: WEIGHTS.intake, detail: `Imminent (${months} mo)` });
  } else if (months <= 6) {
    b.intake = Math.round(WEIGHTS.intake * 0.75);
    items.push({ key: "intake", label: "Timeline / Intake", points: b.intake, max: WEIGHTS.intake, detail: `Near-term (${months} mo)` });
  } else if (months <= 12) {
    b.intake = Math.round(WEIGHTS.intake * 0.5);
    items.push({ key: "intake", label: "Timeline / Intake", points: b.intake, max: WEIGHTS.intake, detail: `Medium-term (${months} mo)` });
  } else {
    b.intake = Math.round(WEIGHTS.intake * 0.25);
    items.push({ key: "intake", label: "Timeline / Intake", points: b.intake, max: WEIGHTS.intake, detail: `Future (${months} mo)` });
  }

  // Engagement Interactions
  const eng = Math.max(0, Number(lead.engagement_count ?? 0));
  b.engagement = Math.round(WEIGHTS.engagement * Math.min(1, eng / 5));
  items.push({
    key: "engagement",
    label: "Touchpoint Engagement",
    points: b.engagement,
    max: WEIGHTS.engagement,
    detail: `${eng} interaction${eng === 1 ? "" : "s"} (${eng >= 5 ? "Max" : `${Math.round((eng / 5) * 100)}%`})`,
  });

  // Stage Progression
  const stageRaw = (lead.stage_key ?? lead.stage ?? "new").toLowerCase();
  const stageRatio = STAGE_PROGRESS[stageRaw] ?? 0.3;
  b.stage = Math.round(WEIGHTS.stage * stageRatio);
  items.push({
    key: "stage",
    label: "Pipeline Progression",
    points: b.stage,
    max: WEIGHTS.stage,
    detail: `${lead.stage_key ?? lead.stage ?? "new"} (${Math.round(stageRatio * 100)}%)`,
  });

  const total = Object.values(b).reduce((a, c) => a + c, 0);
  const finalScore = Math.max(0, Math.min(100, Math.round(total)));

  return { score: finalScore, breakdown: b, items };
}
