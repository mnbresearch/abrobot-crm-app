// Which follow-up sequence a record belongs to.
//
// Extracted from nurture/index.ts so it can be tested. That function opens a
// Supabase client and calls Deno.serve at module scope, so importing it from a
// test starts a server — which is why the grouping rules, the part with actual
// decisions in it, had no test at all.
//
// ── The rules, in one place ─────────────────────────────────────────────────
// A template with no `nurture_segment` is part of the DEFAULT sequence. A
// template naming a segment belongs to that segment's sequence.
//
//   * segment has its own sequence  → use it, and ONLY it
//   * segment has none              → fall back to the default sequence
//   * neither exists                → send nothing
//
// The middle rule is a fallback; the first is not a merge. A business that
// wrote three emails for its website enquiries must not have a fourth, written
// for a different audience, appended to them because it happened to sit at
// step 4 of the default sequence. Sending someone the wrong pitch is the exact
// failure this whole feature exists to prevent, and "helpfully" combining
// sequences would reintroduce it at the last possible moment.
//
// `segment` is free text carried from the capture key, NOT leads.source —
// source is an enum a tenant cannot extend. See 20260908120000 for why that
// distinction is load-bearing.

export interface NurtureTemplate {
  subject: string | null;
  body: string;
  nurture_step: number;
  nurture_segment: string | null;
}

/** One sequence: templates by step, and the step number that ends it. */
export interface Sequence {
  byStep: Map<number, NurtureTemplate>;
  maxStep: number;
}

export interface Sequences {
  /** Used by any record whose segment has no sequence of its own. */
  def: Sequence | null;
  bySegment: Map<string, Sequence>;
}

function group(rows: NurtureTemplate[]): Sequence | null {
  if (rows.length === 0) return null;
  return {
    byStep: new Map(rows.map((t) => [t.nurture_step, t])),
    maxStep: Math.max(...rows.map((t) => t.nurture_step)) + 1,
  };
}

export function buildSequences(templates: NurtureTemplate[]): Sequences {
  const bySegment = new Map<string, Sequence>();
  const segments = new Set(
    templates.map((t) => t.nurture_segment).filter((s): s is string => !!s),
  );
  for (const s of segments) {
    const seq = group(templates.filter((t) => t.nurture_segment === s));
    if (seq) bySegment.set(s, seq);
  }
  return { def: group(templates.filter((t) => !t.nurture_segment)), bySegment };
}

/** The sequence this record belongs to, or null if it belongs to none. */
export function sequenceFor(seqs: Sequences, segment: string | null): Sequence | null {
  return (segment && seqs.bySegment.get(segment)) || seqs.def;
}

/** Names of the sequences an org runs, for the run report. */
export function sequenceNames(seqs: Sequences): string[] {
  return [...(seqs.def ? ["default"] : []), ...seqs.bySegment.keys()];
}
