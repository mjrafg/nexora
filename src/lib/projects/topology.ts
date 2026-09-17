/* ------------------------------------------------------------------
   Whether an integration instruction contradicts the branch topology
   the engine itself created.

   Kept free of imports so it can be exercised directly, without a
   running server: it is the one piece of this that has to be exactly
   right about English, and it is cheap to be wrong about quietly.
   ------------------------------------------------------------------ */

/*
 * An integration session is told the milestone's sessions were not isolated —
 * that their work is already on the branch and there is no session branch to
 * merge. The Director's own instructions are appended straight after, and in
 * the Mini Habit Tracker run every one of them opened with "Merge the M1.1
 * session branch into the integration branch."
 *
 * The engine created the topology, so the engine is the one that knows. Rather
 * than rewrite what the Director wrote — which would put words in its mouth and
 * hide the disagreement — the call is refused with the actual topology, and the
 * Director reissues it. A model cannot be trusted to remember branch layout it
 * never chose; it can be trusted to fix an instruction when told it is wrong.
 */
export function contradictsInPlaceTopology(instructions: string): string | null {
  const text = instructions ?? "";
  /*
   * Only `merge` and `merging` can be an order. `merged` is always describing
   * a state that already exists — which matters, because the real instructions
   * said "into the integration branch on top of the already-merged M1 work",
   * and a sentence-wide search for "already" threw the order out with it.
   */
  for (const m of text.matchAll(/\bmerg(?:e|ing)\b/gi)) {
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 40), at);
    // a negation close in front of the verb turns the order into a statement:
    // "there is no session branch to merge", "do not merge anything"
    if (/\b(no|not|never|nothing|none|don'?t|cannot|can'?t|without|avoid|skip|rather than|instead of)\b[^.?!]{0,24}$/i.test(before)) continue;
    // "the merge commit", "merge conflict markers" — a noun, not an order
    if (/^\s*(commit|conflict|marker|base|request|strategy|point|history)/i.test(text.slice(at + m[0].length))) continue;
    // and it has to be about a branch, not about conflict markers or a merge commit
    const near = `${before} ${text.slice(at, at + 90)}`;
    if (!/\bbranch(es)?\b|\bworktree(s)?\b/i.test(near)) continue;
    return text.slice(Math.max(0, at - 30), at + 110).trim().slice(0, 160);
  }
  return null;
}
