/* ------------------------------------------------------------------
   Independent review: subject selection, reviewer prompt, verdict parsing
   (ported from Tandem's workflow.ts). The Reviewer runs as a separate agent
   in a fresh, read-only session and judges against the ORIGINAL request.
   ------------------------------------------------------------------ */

import type { Finding, ReviewPolicy, ReviewVerdict, SessionKind } from "./types";
import { MAX_REVIEW_ROUNDS, render } from "./prompts";
import { findingsAsText } from "./store";
import { getPrompt } from "@/lib/prompts";

export type ReviewSubject = { kind: "changes"; files: string[]; note: string } | { kind: "answer"; answer: string };

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

export function reviewPrompt(input: { originalRequest: string; subject: ReviewSubject; round: 1 | 2; previous?: Finding[]; kind?: SessionKind; policy?: ReviewPolicy }): string {
  const parts = [getPrompt("project-reviewer-system"), "", render(getPrompt("project-reviewer-request-section"), { original_request: input.originalRequest })];
  if (input.subject.kind === "changes") {
    parts.push("", render(getPrompt("project-reviewer-changed-section"), { changed_files_note: input.subject.note, changed_files: input.subject.files.join("\n") || "(list unavailable — inspect directly)" }));
  } else {
    parts.push("", render(getPrompt("project-reviewer-answer-section"), { builder_answer: input.subject.answer }));
  }
  if (input.round === 2 && input.previous?.length) {
    parts.push("", render(getPrompt("project-reviewer-continuation-section"), { previous_findings: findingsAsText(input.previous) }));
  }
  // the Director's own "light review" decision outranks the session kind: it
  // asked for an audit, and a build-scoped remit would quietly turn that back
  // into the full acceptance pass it declined to pay for
  parts.push("", getPrompt(input.policy === "spot_check" ? "project-reviewer-scope-spot-check" : SCOPE[input.kind ?? "build"]));
  parts.push("", render(getPrompt("project-reviewer-round-section"), { review_round: String(input.round), max_review_rounds: String(MAX_REVIEW_ROUNDS) }), "", getPrompt("project-evidence-rule"), "", getPrompt("project-reviewer-output-format"));
  return parts.join("\n");
}

/*
 * Models answer the contract in markdown. "## PASS", "**PASS**" and "PASS" are
 * the same verdict typed by a model that formats its prose; a heading marker is
 * decoration around the required token, not a different answer. Stripping that
 * decoration is not the same as accepting anything that sounds positive — the
 * exact token is still required, in the place the contract puts it.
 */
const undecorate = (line: string) => line.replace(/^\s*(#{1,6}\s*|[-*+]\s+|>\s*)+/, "").replace(/\*\*|__|`/g, "").trim();

/** Parse the Reviewer's reply into a verdict (ported parser). */
export function parseVerdict(text: string): { verdict: ReviewVerdict; items: Finding[] } {
  const lines = text.split("\n").map(undecorate);
  const firstLine = lines.find((l) => l.length > 0) ?? "";
  if (/^(VERDICT:\s*)?PASS\b/i.test(firstLine)) return { verdict: "pass", items: [] };

  const items: Finding[] = [];
  let current: Finding | null = null;
  for (const raw of text.split("\n")) {
    // the contract asks for `1. [major] …`; a model that bolds the severity
    // instead of bracketing it has answered the contract, just decorated
    const m = undecorate(raw).match(/^\d+\.\s*[[(]?(major|minor)[\])]?\s*[—–-]?\s*(.+)$/i);
    if (m) {
      if (current) items.push(current);
      let title = m[2].trim();
      let file: string | undefined;
      let lineNo: number | undefined;
      const loc = title.match(/\s[—–-]\s*(\S+?)(?::(\d+))?\s*$/);
      if (loc && /[./]/.test(loc[1])) {
        file = loc[1].replace(/[`(),]/g, "");
        if (loc[2]) lineNo = Number(loc[2]);
        title = title.slice(0, loc.index).trim();
      }
      current = { severity: m[1].toLowerCase() as "major" | "minor", title: title.replace(/`/g, ""), file, line: lineNo, detail: "" };
      continue;
    }
    if (current && raw.trim()) {
      const rec = raw.trim().match(/^Recommendation:\s*(.+)$/i);
      if (rec) current.recommendation = rec[1];
      else current.detail = current.detail ? `${current.detail} ${raw.trim()}` : raw.trim();
    }
  }
  if (current) items.push(current);
  if (items.length === 0) {
    // no structured findings: a clear standalone PASS anywhere (e.g. after a preamble, or bolded) is a pass
    const standalonePass = lines.some((l) => /^(VERDICT:\s*)?PASS\s*\.?$/i.test(l));
    if (standalonePass && !/\bFINDINGS\b/.test(text)) return { verdict: "pass", items: [] };
    items.push({ severity: "major", title: "Reviewer reported issues (unstructured output)", detail: text.trim().slice(0, 4_000) });
  }
  return { verdict: "findings", items };
}
