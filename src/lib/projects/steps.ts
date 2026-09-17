/* ------------------------------------------------------------------
   Keeping what an agent actually did.

   The activity bus is an in-memory ring: close the process and every
   command, file change and tool call is gone. A chat keeps its steps on
   the assistant message; project work keeps them on the session and on
   the Director's own messages, so a finished run can still be read.

   The whole database is one JSON document rewritten on every change, so
   a chatty build must not be allowed to bloat it. Two limits: a cap per
   step, so one enormous command output cannot dominate, and a budget for
   the record as a whole, spent newest-first — what survives is the end
   of the run, which is the part anyone reading it afterwards wants.
   ------------------------------------------------------------------ */

import type { ActivityEvent } from "@/lib/activity";

const MAX_STEPS = 300;
const STEP_TEXT = 2_000;
const STEP_BUDGET = 400_000;

/**
 * Drop the narration that is already the reply.
 *
 * An agent's last text block is both the end of its narration and the reply
 * itself. Kept as a step, it renders immediately above the very same words in
 * the reply bubble — the account of the work reads as if it stuttered.
 */
export function dropEchoedReply(steps: ActivityEvent[], reply: string): ActivityEvent[] {
  const said = reply.trim();
  if (!said || !steps.length) return steps;
  const last = steps[steps.length - 1];
  if (last.kind !== "note") return steps;
  const note = last.title.trim();
  // the note is truncated when long, so an echo is a prefix, not an exact match
  const echo = said.startsWith(note.slice(0, 120)) || note.startsWith(said.slice(0, 120));
  return echo ? steps.slice(0, -1) : steps;
}

export function keepSteps(events: ActivityEvent[], budget = STEP_BUDGET): ActivityEvent[] {
  const trimmed = (events.length > MAX_STEPS ? events.slice(-MAX_STEPS) : events).map((e) => ({
    ...e,
    detail: e.detail?.slice(0, STEP_TEXT),
    output: e.output?.slice(0, STEP_TEXT),
    // a screenshot is served from disk; the rest of the browser record is small
    browser: e.browser ? { ...e.browser, console: e.browser.console?.slice(0, 20) } : undefined,
  }));
  const kept: ActivityEvent[] = [];
  let spent = 0;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const size = JSON.stringify(trimmed[i]).length;
    if (spent + size > budget) break;
    spent += size;
    kept.unshift(trimmed[i]);
  }
  return kept;
}
