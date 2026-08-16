// Tests for the lead scoring engine.
// Run:  deno test supabase/functions/_shared/score.test.ts
//
// The scoring model drives what counsellors see first, so the invariants here
// (bounds, ordering, past-intake handling) matter more than exact numbers.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { monthsToIntake, scoreLead } from "./score.ts";

const NOW = new Date("2026-08-16T00:00:00Z");

Deno.test("empty lead scores zero", () => {
  assertEquals(scoreLead({}, NOW).score, 0);
});

Deno.test("score is always within 0..100", () => {
  const extreme = scoreLead({
    email: "a@b.com", phone: "+919999999999", budget_inr: 99_999_999,
    target_country: "USA", course: "CS", course_level: "Masters",
    intake: "Sep 2026", stage: "visa", engagement_count: 9999,
  }, NOW);
  assert(extreme.score <= 100, `expected <=100, got ${extreme.score}`);
  assert(extreme.score >= 0);

  const negative = scoreLead({ engagement_count: -50 }, NOW);
  assert(negative.score >= 0);
});

Deno.test("phone outranks email as an intent signal", () => {
  const phone = scoreLead({ phone: "+919999999999" }, NOW).score;
  const email = scoreLead({ email: "a@b.com" }, NOW).score;
  assert(phone > email, `phone ${phone} should beat email ${email}`);
});

Deno.test("higher budget never scores lower", () => {
  const budgets = [0, 500_000, 1_000_000, 1_500_000, 2_500_000, 4_000_000];
  let previous = -1;
  for (const b of budgets) {
    const { breakdown } = scoreLead({ budget_inr: b }, NOW);
    assert(breakdown.budget >= previous, `budget ${b} regressed`);
    previous = breakdown.budget;
  }
});

Deno.test("a non-numeric budget contributes nothing rather than NaN", () => {
  const { score, breakdown } = scoreLead({ phone: "+91999", budget_inr: "not-a-number" }, NOW);
  assertEquals(breakdown.budget, 0);
  assert(Number.isInteger(score));
});

Deno.test("nearer intake scores higher, past intake scores zero", () => {
  const near = scoreLead({ intake: "Sep 2026" }, NOW).breakdown.intake;
  const mid = scoreLead({ intake: "Jan 2027" }, NOW).breakdown.intake;
  const far = scoreLead({ intake: "Sep 2028" }, NOW).breakdown.intake;
  const past = scoreLead({ intake: "Fall 2024" }, NOW).breakdown.intake;

  assert(near > mid, `near ${near} should beat mid ${mid}`);
  assert(mid > far, `mid ${mid} should beat far ${far}`);
  assertEquals(past, 0);
});

Deno.test("monthsToIntake parses the formats leads actually use", () => {
  assertEquals(monthsToIntake("Fall 2026", NOW), 1);
  assertEquals(monthsToIntake("Sep 2026", NOW), 1);
  assertEquals(monthsToIntake("Jan 2027", NOW), 5);
  assertEquals(monthsToIntake("rubbish", NOW), null);
  assertEquals(monthsToIntake(null, NOW), null);
});

Deno.test("engagement saturates at five interactions", () => {
  const five = scoreLead({ engagement_count: 5 }, NOW).breakdown.engagement;
  const fifty = scoreLead({ engagement_count: 50 }, NOW).breakdown.engagement;
  assertEquals(five, fifty);
});

Deno.test("pipeline progression increases the stage component", () => {
  const stages = ["new", "contacted", "counselled", "application", "offer", "visa"];
  let previous = -1;
  for (const stage of stages) {
    const v = scoreLead({ stage }, NOW).breakdown.stage;
    assert(v >= previous, `stage ${stage} regressed`);
    previous = v;
  }
  // "lost" is terminal — it must not carry pipeline credit
  assertEquals(scoreLead({ stage: "lost" }, NOW).breakdown.stage, 0);
});

Deno.test("breakdown always sums to the reported score", () => {
  const r = scoreLead({
    email: "a@b.com", phone: "+91999", budget_inr: 1_500_000,
    target_country: "UK", course: "Data Science", course_level: "Masters",
    intake: "Jan 2027", stage: "contacted", engagement_count: 2,
  }, NOW);
  const sum = Object.values(r.breakdown).reduce((a, c) => a + c, 0);
  assertEquals(sum, r.score);
});
