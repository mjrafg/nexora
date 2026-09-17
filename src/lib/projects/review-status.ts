/* ------------------------------------------------------------------
   What to say about a session's review.

   Its own module because the answer is needed in the browser as well as
   on the server, and everything else in the projects library reaches the
   filesystem — importing this from there dragged node:fs into the client
   bundle and broke the build.
   ------------------------------------------------------------------ */

import type { ReviewPolicy, SessionKind, SessionRecord } from "./types";

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

/**
 * What a delivery is about to ship, review-wise.
 *
 * Delivery is the last point at which "everything was checked" is still a
 * correctable belief rather than something the owner has been told. A session
 * the Director excused is its own decision and reads as one; a review that
 * started and never finished is nobody's decision, and is named apart from it.
 */
export function reviewCoverageNote(sessions: Pick<SessionRecord, "key" | "status" | "reviewStatus" | "reviewPolicy" | "lastVerdict">[]): string {
  const shipped = sessions.filter((s) => s.status === "completed");
  const unreviewed = shipped.filter((s) => reviewOutcome(s) === "incomplete").map((s) => s.key);
  const excused = shipped.filter((s) => reviewOutcome(s) === "skipped").map((s) => s.key);
  return [
    unreviewed.length ? `NOT REVIEWED — the Reviewer never finished on: ${unreviewed.join(", ")}. This work has not passed review; do not tell the owner it has.` : "",
    excused.length ? `No independent review by your own decision on: ${excused.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}

/**
 * Who does the acceptance verification on this session, and the text that says so.
 *
 * Kept here, away from the engine's plumbing and free of imports, because it
 * is the one rule the whole responsibility split turns on and it has to be
 * checkable on its own. `prompt` and `render` are passed in so the registry
 * stays the only source of the wording.
 */
export function sessionVerification(o: {
  policy: ReviewPolicy;
  kind: SessionKind;
  reviewerName: string;
  prompt: (id: string) => string;
  render: (template: string, values: Record<string, string>) => string;
}): { owner: "builder" | "reviewer"; responsibility: string; repairScope: string } {
  // the Builder keeps the acceptance work unless an independent Reviewer is
  // actually going to do it — and on a QA session the testing IS the work
  const owner: "builder" | "reviewer" = o.policy === "required" && o.kind !== "qa" ? "reviewer" : "builder";
  const verification = owner === "builder"
    ? o.prompt("project-builder-verify-full")
    : o.render(o.prompt("project-builder-verify-light"), { reviewer: o.reviewerName });
  return {
    owner,
    responsibility: o.render(o.prompt("project-session-responsibility"), { verification }),
    repairScope: owner === "builder"
      ? "you own the verification of this work, so re-check what you changed properly."
      : `${o.reviewerName} still performs the acceptance pass — fix the findings and smoke-check your fix, do not re-test the whole request.`,
  };
}
