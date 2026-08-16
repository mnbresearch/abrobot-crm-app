// AbroBot CRM — lead scoring engine.
//
// leads.score is NOT NULL and the CRM displays and sorts by it, but until now
// nothing ever wrote it. This module is the single source of truth for how a
// score is produced.
//
// Principles:
//  - Deterministic and explainable. scoreLead() returns the breakdown so a
//    counsellor can be told *why* a lead is 72 and not 40.
//  - Bounded 0..100, integer (the column is `integer NOT NULL`).
//  - Never throws. Missing fields simply score 0 for that component.
//
// Weights are intentionally in one table so they can be tuned without
// touching logic.

export const WEIGHTS = {
  phone: 15, // reachable by call/WhatsApp — the strongest intent signal we hold
  email: 10,
  budget: 25, // funded intent
  country: 8,
  course: 6,
  course_level: 6,
  intake: 10, // nearer intake = hotter
  engagement: 12, // replies / inbound messages
  stage: 8, // progression through the pipeline
} as const;

// Budget bands in INR. Study-abroad budgets cluster around these tiers.
const BUDGET_BANDS: [number, number][] = [
  [4_000_000, 1.0], // ≥ 40L — premium, fully funded
  [2_500_000, 0.85],
  [1_500_000, 0.7],
  [1_000_000, 0.5],
  [500_000, 0.3],
  [0, 0.15], // stated a budget at all
];

// Intake strings look like "Fall 2026", "Sep 2026", "2026 intake".
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  spring: 1, summer: 5, fall: 8, autumn: 8, winter: 11,
};

/** Months from now until the stated intake, or null if unparseable. */
export function monthsToIntake(intake?: string | null, now = new Date()): number | null {
  if (!intake) return null;
  const s = intake.toLowerCase();
  const year = s.match(/(20\d{2})/)?.[1];
  if (!year) return null;
  const monthKey = Object.keys(MONTHS).find((m) => s.includes(m));
  const month = monthKey ? MONTHS[monthKey] : 6; // mid-year if only a year is given
  const target = new Date(Number(year), month, 1);
  return (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
}

const STAGE_PROGRESS: Record<string, number> = {
  new: 0,
  contacted: 0.25,
  counselled: 0.5,
  application: 0.75,
  offer: 0.9,
  visa: 1.0,
  enrolled: 1.0,
  lost: 0,
};

export type ScoreInput = {
  email?: string | null;
  phone?: string | null;
  budget_inr?: number | string | null;
  target_country?: string | null;
  course?: string | null;
  course_level?: string | null;
  intake?: string | null;
  stage?: string | null;
  /** Count of inbound/interaction signals — activities or chat messages. */
  engagement_count?: number | null;
};

export type ScoreResult = { score: number; breakdown: Record<string, number> };

export function scoreLead(lead: ScoreInput, now = new Date()): ScoreResult {
  const b: Record<string, number> = {};

  b.phone = lead.phone ? WEIGHTS.phone : 0;
  b.email = lead.email ? WEIGHTS.email : 0;

  // budget
  const budget = typeof lead.budget_inr === "string" ? Number(lead.budget_inr) : lead.budget_inr;
  if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
    const band = BUDGET_BANDS.find(([floor]) => budget >= floor);
    b.budget = Math.round(WEIGHTS.budget * (band ? band[1] : 0.15));
  } else b.budget = 0;

  b.country = lead.target_country ? WEIGHTS.country : 0;
  b.course = lead.course ? WEIGHTS.course : 0;
  b.course_level = lead.course_level ? WEIGHTS.course_level : 0;

  // intake proximity: soonest (but not past) scores highest
  const months = monthsToIntake(lead.intake, now);
  if (months === null) b.intake = 0;
  else if (months < 0) b.intake = 0; // intake already passed — stale
  else if (months <= 3) b.intake = WEIGHTS.intake;
  else if (months <= 6) b.intake = Math.round(WEIGHTS.intake * 0.75);
  else if (months <= 12) b.intake = Math.round(WEIGHTS.intake * 0.5);
  else b.intake = Math.round(WEIGHTS.intake * 0.25);

  // engagement: saturating — 5+ interactions is full marks
  const eng = Math.max(0, Number(lead.engagement_count ?? 0));
  b.engagement = Math.round(WEIGHTS.engagement * Math.min(1, eng / 5));

  b.stage = Math.round(WEIGHTS.stage * (STAGE_PROGRESS[lead.stage ?? "new"] ?? 0));

  const total = Object.values(b).reduce((a, c) => a + c, 0);
  return { score: Math.max(0, Math.min(100, Math.round(total))), breakdown: b };
}
