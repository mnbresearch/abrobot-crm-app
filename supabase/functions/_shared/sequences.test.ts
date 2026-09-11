// deno test supabase/functions/_shared/sequences.test.ts
//
// These cover the decisions, not the plumbing. The failure this feature can
// cause is sending someone copy written for a different audience — a software
// buyer receiving university-shortlist emails is the real incident this
// codebase already had once, in a different form. So the tests that matter are
// the ones asserting sequences DON'T bleed into each other, and that a record
// nobody wrote for receives nothing rather than the nearest available email.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildSequences,
  sequenceFor,
  sequenceNames,
  type NurtureTemplate,
} from "./sequences.ts";

const tpl = (step: number, segment: string | null, tag = ""): NurtureTemplate => ({
  subject: `s${step}${tag}`,
  body: `b${step}${tag}`,
  nurture_step: step,
  nurture_segment: segment,
});

Deno.test("no templates: nobody is in a sequence", () => {
  const s = buildSequences([]);
  assertEquals(s.def, null);
  assertEquals(s.bySegment.size, 0);
  assertEquals(sequenceFor(s, "crm-website"), null);
  assertEquals(sequenceFor(s, null), null);
});

Deno.test("only default templates: every record uses them (the pre-existing behaviour)", () => {
  const s = buildSequences([tpl(0, null), tpl(1, null), tpl(2, null)]);
  assertEquals(sequenceFor(s, null)?.maxStep, 3);
  assertEquals(sequenceFor(s, "crm-website")?.maxStep, 3);
  assertEquals(sequenceFor(s, "anything")?.maxStep, 3);
  assertEquals(sequenceNames(s), ["default"]);
});

Deno.test("a segment with its own sequence does NOT also get the default", () => {
  const s = buildSequences([
    tpl(0, null, "-def"), tpl(1, null, "-def"), tpl(2, null, "-def"), tpl(3, null, "-def"),
    tpl(0, "crm-website", "-crm"), tpl(1, "crm-website", "-crm"),
  ]);

  const crm = sequenceFor(s, "crm-website")!;
  // Two steps, not six, and not the default's step 2 appended at the end.
  assertEquals(crm.maxStep, 2);
  assertEquals(crm.byStep.size, 2);
  assertEquals(crm.byStep.get(0)?.body, "b0-crm");
  assertEquals(crm.byStep.get(1)?.body, "b1-crm");
  assertEquals(crm.byStep.get(2), undefined, "the default's step 3 must not leak in");

  // Everyone else is untouched.
  assertEquals(sequenceFor(s, null)?.maxStep, 4);
  assertEquals(sequenceFor(s, null)?.byStep.get(0)?.body, "b0-def");
});

Deno.test("a segment with no sequence of its own falls back to the default", () => {
  const s = buildSequences([tpl(0, null, "-def"), tpl(0, "crm-website", "-crm")]);
  assertEquals(sequenceFor(s, "partners")?.byStep.get(0)?.body, "b0-def");
  assertEquals(sequenceFor(s, "crm-website")?.byStep.get(0)?.body, "b0-crm");
});

Deno.test("no default sequence: unmatched records receive NOTHING, not the nearest email", () => {
  // The behaviour that keeps consulting enquiries out of the software follow-up
  // when both live in one organisation. Getting this wrong is the whole bug.
  const s = buildSequences([tpl(0, "crm-website"), tpl(1, "crm-website")]);
  assertEquals(sequenceFor(s, null), null);
  assertEquals(sequenceFor(s, "partners"), null);
  assert(sequenceFor(s, "crm-website") !== null);
});

Deno.test("an empty-string segment is treated as no segment, not as a named audience", () => {
  // leads.segment is text and nothing forbids ''. Looking up '' in the map
  // would miss, and the guard must send it to the default rather than to null.
  const s = buildSequences([tpl(0, null)]);
  assertEquals(sequenceFor(s, "")?.byStep.get(0)?.body, "b0");
});

Deno.test("each sequence carries its own end, so a short one is not stretched", () => {
  // runOrg queries per sequence bounded by this number. If a sequence reported
  // the org-wide maximum instead, its finished records would be re-fetched
  // every hour forever and would crowd out records that can still be sent.
  const s = buildSequences([
    tpl(0, null), tpl(1, null),
    tpl(0, "crm-website"), tpl(1, "crm-website"), tpl(2, "crm-website"), tpl(3, "crm-website"),
  ]);
  assertEquals(sequenceFor(s, null)?.maxStep, 2);
  assertEquals(sequenceFor(s, "crm-website")?.maxStep, 4);
});

Deno.test("a gap in the steps does not shorten the sequence", () => {
  // Someone deletes step 2 of three. maxStep stays 3 so step 3 stays reachable
  // — runOrg advances past the hole rather than sending a substitute, and the
  // record must still be inside the sequence's bound for that to happen.
  const s = buildSequences([tpl(0, null), tpl(2, null)]);
  const seq = sequenceFor(s, null)!;
  assertEquals(seq.maxStep, 3);
  assertEquals(seq.byStep.get(1), undefined);
  assert(seq.byStep.get(2) !== undefined);
});

Deno.test("several named audiences coexist", () => {
  const s = buildSequences([
    tpl(0, "crm-website"), tpl(0, "partners"), tpl(1, "partners"), tpl(0, null),
  ]);
  assertEquals(sequenceNames(s).sort(), ["crm-website", "default", "partners"]);
  assertEquals(sequenceFor(s, "partners")?.maxStep, 2);
  assertEquals(sequenceFor(s, "crm-website")?.maxStep, 1);
});
