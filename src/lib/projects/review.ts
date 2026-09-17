/* ------------------------------------------------------------------
   Independent review: subject selection, reviewer prompt, verdict parsing
   (ported from Tandem's workflow.ts). The Reviewer runs as a separate agent
   in a fresh, read-only session and judges against the ORIGINAL request.
   ------------------------------------------------------------------ */

import type { Finding, ReviewPolicy, SessionKind } from "./types";
import { MAX_REVIEW_ROUNDS, render } from "./prompts";
import { findingsAsText } from "./store";
import { getPrompt } from "@/lib/prompts";

export type ReviewSubject = { kind: "changes"; files: string[]; note: string } | { kind: "answer"; answer: string };

/**
 * What the session actually did, as opposed to what it said it did.
 *
 * A Reviewer used to be handed a list of changed files and nothing else: "This
 * session gave me the changed-file list but not the builder's written evidence
 * block, and I have no shell here." The worker's report existed — the engine
 * simply never passed it on, and the Reviewer was left to re-derive everything
 * or report it as unverified.
 *
 * The two halves are kept apart on purpose. A model's summary of a test run and
 * the engine's record of that test run are not the same kind of thing, and a
 * Reviewer that cannot tell them apart cannot weigh them.
 */
import { evidenceFields, type WorkEvidence } from "./evidence";
export type { WorkEvidence };

const ANSWER_CAP = 24_000;

export function subjectFor(delta: { files: string[]; note: string } | null, answer: string): ReviewSubject | null {
  if (delta && delta.files.length > 0) return { kind: "changes", files: delta.files, note: delta.note };
  const text = answer.trim();
  return text ? { kind: "answer", answer: text.slice(0, ANSWER_CAP) } : null;
}

/**
 * What the Reviewer is actually for on this session.
 *
 * Without it every review is an acceptance test, so a session whose own job was
 * testing gets its matrix run twice by two agents who each believe they are the
 * one doing the real verification.
 */
const SCOPE: Record<SessionKind, string> = {
  build: "project-reviewer-scope-build",
  qa: "project-reviewer-scope-qa",
  cleanup: "project-reviewer-scope-cleanup",
  integration: "project-reviewer-scope-integration",
};

export function reviewPrompt(input: { originalRequest: string; subject: ReviewSubject; round: 1 | 2; previous?: Finding[]; kind?: SessionKind; policy?: ReviewPolicy; evidence?: WorkEvidence; sessionKey?: string; canRunCommands?: boolean }): string {
  const parts = [getPrompt("project-reviewer-system"), "", render(getPrompt("project-reviewer-request-section"), { original_request: input.originalRequest })];
  if (input.subject.kind === "changes") {
    parts.push("", render(getPrompt("project-reviewer-changed-section"), { changed_files_note: input.subject.note, changed_files: input.subject.files.join("\n") || "(list unavailable — inspect directly)" }));
  } else {
    parts.push("", render(getPrompt("project-reviewer-answer-section"), { builder_answer: input.subject.answer }));
  }
  // the work products and execution records, before the findings and the remit:
  // what was done, then what was said about it, then what to do about it
  if (input.evidence) parts.push("", render(getPrompt("project-reviewer-evidence-section"), evidenceFields(input.evidence, input.sessionKey ?? "this session")));
  if (input.round === 2 && input.previous?.length) {
    parts.push("", render(getPrompt("project-reviewer-continuation-section"), { previous_findings: findingsAsText(input.previous) }));
  }
  // the Director's own "light review" decision outranks the session kind: it
  // asked for an audit, and a build-scoped remit would quietly turn that back
  // into the full acceptance pass it declined to pay for
  parts.push("", getPrompt(input.policy === "spot_check" ? "project-reviewer-scope-spot-check" : SCOPE[input.kind ?? "build"]));
  // only said to a Reviewer that can actually do it — telling one to start a
  // server it has no way to start is how this went wrong the first time
  if (input.canRunCommands) parts.push("", getPrompt("project-reviewer-preview-note"));
  parts.push("", render(getPrompt("project-reviewer-round-section"), { review_round: String(input.round), max_review_rounds: String(MAX_REVIEW_ROUNDS) }), "", getPrompt("project-evidence-rule"), "", getPrompt("project-reviewer-output-format"));
  return parts.join("\n");
}

export { parseVerdict, isUnstructuredGuess, UNSTRUCTURED_TITLE } from "./verdict";
