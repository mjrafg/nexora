/* ------------------------------------------------------------------
   What to say about a session's review.

   Its own module because the answer is needed in the browser as well as
   on the server, and everything else in the projects library reaches the
   filesystem — importing this from there dragged node:fs into the client
   bundle and broke the build.
   ------------------------------------------------------------------ */

import type { SessionRecord } from "./types";

/**
 * What to say about this session's review.
 *
 * The policy answers it before the session has run — a session the Director
 * excused from review is skipped from the moment it is planned, not "nothing
 * to review". Once it has run, what actually happened wins.
 */
export function reviewOutcome(s: Pick<SessionRecord, "reviewStatus" | "reviewPolicy" | "lastVerdict">): NonNullable<SessionRecord["reviewStatus"]> {
  if (s.reviewStatus) return s.reviewStatus;
  if ((s.reviewPolicy ?? "required") === "none") return "skipped";
  if (s.lastVerdict === "pass") return "passed";
  if (s.lastVerdict === "findings") return "findings";
  return "not_applicable";
}
