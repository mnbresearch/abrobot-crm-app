// Round-robin order for a job that cannot finish every tenant in one run.
//
// nurture stops when it hits its per-run send cap, and the next run used to
// begin from the same first organisation again. With a stable order that is
// starvation: the same tenants at the head of the list get every run's
// budget, and the ones after the cap NEVER send — silently, because each run
// reports success for the orgs it did reach.
//
// The fix is to remember the last org that got a turn and start the next run
// just after it, wrapping round. Pure, so the ordering rule is tested on its
// own rather than through a live cron run.

/**
 * `items` sorted by id, rotated so the first element is the first id strictly
 * greater than `after`, wrapping round to the start. An empty or unknown
 * `after` (including one whose org has since been deleted or disabled) simply
 * resumes at the next id in order — it never skips anyone or repeats anyone.
 */
export function rotateAfter<T extends { id: string }>(items: T[], after: string | null | undefined): T[] {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const mark = (after ?? "").trim();
  if (!mark) return sorted;
  const i = sorted.findIndex((x) => x.id > mark);
  if (i <= 0) return sorted;    // nothing after the mark (wrap) or everything is
  return [...sorted.slice(i), ...sorted.slice(0, i)];
}
