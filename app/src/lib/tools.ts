// Sector-specific calculators.
//
// These are the "leverage each industry's own tools" piece: small utilities a
// counsellor in that sector actually reaches for mid-conversation. Kept as
// pure functions so they are testable and reusable from an edge function later
// (e.g. letting the AI chat agent answer "what would my EMI be?").
//
// Every one returns a caveat where the honest answer is "this is an estimate".

export interface EmiResult {
  emi: number;
  totalPayable: number;
  totalInterest: number;
  caveat: string;
}

/** Standard reducing-balance EMI. rate is annual %, tenure in months. */
export function calcEmi(principal: number, annualRatePct: number, months: number): EmiResult | null {
  if (!(principal > 0) || !(months > 0) || annualRatePct < 0) return null;
  const r = annualRatePct / 12 / 100;
  const emi = r === 0 ? principal / months : (principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
  const totalPayable = emi * months;
  return {
    emi: Math.round(emi),
    totalPayable: Math.round(totalPayable),
    totalInterest: Math.round(totalPayable - principal),
    caveat: "Indicative only. Excludes processing fees, insurance and taxes. Not a quote or an approval.",
  };
}

export interface AffordabilityResult {
  comfortable: number;
  stretch: number;
  maxEmi: number;
  caveat: string;
}

/**
 * Rough affordability band from monthly income.
 * Uses the common lender heuristic: EMI ≤ 40% of net income, 20yr @ 9%.
 */
export function calcAffordability(monthlyIncome: number, existingEmi = 0): AffordabilityResult | null {
  if (!(monthlyIncome > 0)) return null;
  const maxEmi = Math.max(0, monthlyIncome * 0.4 - existingEmi);
  const r = 9 / 12 / 100;
  const n = 240;
  const principalFor = (emi: number) => (emi * (Math.pow(1 + r, n) - 1)) / (r * Math.pow(1 + r, n));
  const loan = principalFor(maxEmi);
  return {
    comfortable: Math.round(loan * 1.25), // assumes ~20% down payment
    stretch: Math.round(loan * 1.45),
    maxEmi: Math.round(maxEmi),
    caveat: "Heuristic: EMI capped at 40% of net income, 20-year tenure at 9%. Actual eligibility is the lender's call.",
  };
}

export interface TriageResult {
  band: "emergency" | "urgent" | "routine";
  label: string;
  advice: string;
  color: string;
}

/**
 * Front-desk triage banding. Deliberately conservative and NON-CLINICAL: it
 * routes attention, it does not assess a patient. Anything that looks like a
 * red flag escalates to "call emergency services" rather than being scored.
 */
const RED_FLAGS = [
  "chest pain", "breathless", "shortness of breath", "unconscious", "fainted",
  "bleeding", "stroke", "seizure", "accident", "fracture", "burn",
  "suicide", "overdose", "poison", "labour", "severe pain",
];
const URGENT_HINTS = ["fever", "vomit", "infection", "swelling", "injury", "pain", "rash", "dizzy"];

export function triage(text: string): TriageResult {
  const t = (text || "").toLowerCase();
  if (RED_FLAGS.some((f) => t.includes(f))) {
    return {
      band: "emergency",
      label: "Possible emergency",
      advice: "Do not triage in the CRM. Tell the caller to attend A&E or call emergency services now, then escalate internally.",
      color: "#dc2626",
    };
  }
  if (URGENT_HINTS.some((f) => t.includes(f))) {
    return {
      band: "urgent",
      label: "Same-day attention",
      advice: "Offer the earliest available slot today and flag to the duty clinician.",
      color: "#ea580c",
    };
  }
  return {
    band: "routine",
    label: "Routine",
    advice: "Book into the normal appointment schedule.",
    color: "#059669",
  };
}

export interface CtcResult {
  hikePct: number;
  hikeAmount: number;
  monthlyCurrent: number;
  monthlyExpected: number;
  verdict: string;
}

export function calcCtc(currentCtc: number, expectedCtc: number): CtcResult | null {
  if (!(currentCtc > 0) || !(expectedCtc > 0)) return null;
  const hikeAmount = expectedCtc - currentCtc;
  const hikePct = (hikeAmount / currentCtc) * 100;
  const verdict =
    hikePct <= 0 ? "A lateral or downward move — worth understanding the motivation."
    : hikePct <= 30 ? "Within the normal band. Usually straightforward to place."
    : hikePct <= 50 ? "Above market norm. Expect the client to push back."
    : "Well above typical. Needs a strong justification or a counter-offer conversation.";
  return {
    hikePct: Math.round(hikePct * 10) / 10,
    hikeAmount: Math.round(hikeAmount),
    monthlyCurrent: Math.round(currentCtc / 12),
    monthlyExpected: Math.round(expectedCtc / 12),
    verdict,
  };
}

export interface TripCostResult {
  perHead: number;
  total: number;
  withMargin: number;
  marginPct: number;
}

export function calcTripCost(landCost: number, flightPerHead: number, pax: number, marginPct = 15): TripCostResult | null {
  if (!(pax > 0)) return null;
  const total = landCost + flightPerHead * pax;
  const withMargin = total * (1 + marginPct / 100);
  return {
    perHead: Math.round(withMargin / pax),
    total: Math.round(total),
    withMargin: Math.round(withMargin),
    marginPct,
  };
}

export interface RoiResult {
  totalCost: number;
  paybackYears: number | null;
  verdict: string;
  caveat: string;
}

/** Study-abroad payback: total cost vs expected post-study annual salary. */
export function calcRoi(tuition: number, livingPerYear: number, years: number, expectedSalary: number): RoiResult | null {
  if (!(tuition >= 0) || !(years > 0)) return null;
  const totalCost = tuition + livingPerYear * years;
  if (!(expectedSalary > 0)) {
    return { totalCost: Math.round(totalCost), paybackYears: null, verdict: "Add an expected salary to see payback.", caveat: "" };
  }
  // assumes ~35% of gross is available for repayment
  const annualSurplus = expectedSalary * 0.35;
  const paybackYears = totalCost / annualSurplus;
  const verdict =
    paybackYears <= 2 ? "Strong payback — a straightforward case to make."
    : paybackYears <= 4 ? "Reasonable payback, in line with typical outcomes."
    : paybackYears <= 7 ? "Long payback. Worth discussing scholarships or cheaper destinations."
    : "Very long payback. Be candid with the family about the numbers.";
  return {
    totalCost: Math.round(totalCost),
    paybackYears: Math.round(paybackYears * 10) / 10,
    verdict,
    caveat: "Assumes 35% of gross salary is available for repayment. Salaries and currency rates vary widely — treat as a conversation aid, not a projection.",
  };
}

export interface QuoteLine { label: string; amount: number }

export function quoteTotal(lines: QuoteLine[], discountPct = 0, taxPct = 18) {
  const subtotal = lines.reduce((a, l) => a + (Number(l.amount) || 0), 0);
  const discount = subtotal * (discountPct / 100);
  const taxable = subtotal - discount;
  const tax = taxable * (taxPct / 100);
  return {
    subtotal: Math.round(subtotal),
    discount: Math.round(discount),
    tax: Math.round(tax),
    total: Math.round(taxable + tax),
  };
}

export const inr = (n: number) =>
  n >= 10_000_000 ? `₹${(n / 10_000_000).toFixed(2)} Cr`
  : n >= 100_000 ? `₹${(n / 100_000).toFixed(2)} L`
  : `₹${Math.round(n).toLocaleString("en-IN")}`;
