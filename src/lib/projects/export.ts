/* ------------------------------------------------------------------
   The complete log of a project, or of one session, as a file.

   Mirrors the chat exporter (src/lib/chats/export.ts): same formats,
   same disclosure style for steps, so a project log reads like every
   other log Nexora produces. What it adds is the shape of project work —
   milestones, sessions, reviews and verdicts — which a chat does not have.
   ------------------------------------------------------------------ */

import type { ActivityEvent } from "@/lib/activity";
import { readDb } from "@/lib/store/db";
import { getProject, getSession, milestonesOf } from "./store";
import type { MilestoneView, ProjectActivity, ProjectMessage, ProjectRecord, SessionRecord } from "./types";

export type ExportFormat = "markdown" | "json";

export type ProjectExport = {
  kind: "project" | "session";
  project: ProjectRecord;
  agents: { director: string; builder: string; reviewer: string };
  milestones: MilestoneView[];
  messages: ProjectMessage[];
  activity: ProjectActivity[];
  /** set for a session export */
  session?: SessionRecord;
  exportedAt: string;
};

const name = (id: string) => readDb().agents.find((a) => a.id === id)?.name ?? id;
const time = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
const dur = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "project";

export function buildProjectExport(projectId: string): ProjectExport | null {
  const project = getProject(projectId);
  if (!project) return null;
  const db = readDb();
  return {
    kind: "project",
    project,
    agents: { director: name(project.directorAgentId), builder: name(project.builderAgentId), reviewer: name(project.reviewerAgentId) },
    milestones: milestonesOf(projectId),
    messages: db.projectMessages.filter((m) => m.projectId === projectId),
    activity: db.projectActivity.filter((a) => a.projectId === projectId),
    exportedAt: new Date().toISOString(),
  };
}

export function buildSessionExport(projectId: string, key: string): ProjectExport | null {
  const base = buildProjectExport(projectId);
  const session = getSession(projectId, key);
  if (!base || !session) return null;
  return {
    ...base,
    kind: "session",
    session,
    // only what concerns this session: its milestone, and the engine's lines about it
    milestones: base.milestones.filter((m) => m.sessions.some((s) => s.key === key)).map((m) => ({ ...m, sessions: m.sessions.filter((s) => s.key === key) })),
    messages: [],
    activity: base.activity.filter((a) => a.text.includes(key)),
  };
}

export function fileName(b: ProjectExport, format: ExportFormat): string {
  const stamp = new Date(b.exportedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const base = b.session ? `${slug(b.project.title)}-${slug(b.session.key)}` : slug(b.project.title);
  return `${base}-${stamp}.${format === "json" ? "json" : "md"}`;
}

export const contentType = (format: ExportFormat) => (format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8");

/* ---------------------------------------------------------------- steps */

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Agents write markdown, headings and all. Pasted in as-is, a Builder's
 * "## Final report" becomes a sibling of the document's own "## Plan" and the
 * outline stops describing the document. Push embedded headings below the
 * level they are being nested under — leaving fenced code exactly as written.
 */
function nest(text: string, under: number): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line; }
      if (fenced) return line;
      const m = /^(#{1,6})(\s+\S)/.exec(line);
      if (!m) return line;
      return "#".repeat(Math.min(6, under + m[1].length)) + m[2];
    })
    .join("\n");
}

const LABEL: Record<string, string> = {
  model: "Model call", tool: "Tool", command: "Command", file: "File",
  browser: "Browser", result: "Result", reasoning: "Reasoning", status: "Status",
};

function stepToMarkdown(e: ActivityEvent): string[] {
  const who = e.actor ? `${e.actor.name} (${e.actor.role})` : "Nexora";
  const head = `${who} · ${LABEL[e.kind] ?? e.kind}${e.meta ? ` · ${e.meta}` : ""}${e.status ? ` · ${e.status}` : ""}${e.durationMs ? ` · ${dur(e.durationMs)}` : ""}`;
  const lines = [`<details><summary>${escapeHtml(head)} — ${escapeHtml(e.title)}</summary>`, ""];
  lines.push(`- Time: ${new Date(e.ts).toLocaleString()}`);
  if (e.browser?.url) lines.push(`- URL: ${e.browser.url}`);
  if (e.browser?.action) lines.push(`- Browser action: ${e.browser.action}${e.browser.ref ? ` (${e.browser.ref})` : ""}`);
  if (e.guard) lines.push(`- Guard: ${e.guard.outcome}${e.guard.class ? ` · ${e.guard.class}` : ""}`);
  if (e.detail) lines.push("", "Input:", "", "```", e.detail, "```");
  if (e.output) lines.push("", "Output:", "", "```", e.output, "```");
  lines.push("", "</details>", "");
  return lines;
}

function sessionToMarkdown(s: SessionRecord, builderName: string, reviewerName: string): string[] {
  const out: string[] = [];
  out.push(`### ${s.key} — ${s.name}`, "");
  out.push(`- **Status:** ${s.status}${s.stopReason ? ` (${s.stopReason.replace("_", " ")})` : ""}`);
  out.push(`- **Purpose:** ${s.purpose || "—"}`);
  out.push(`- **Builder:** ${s.agentId ? name(s.agentId) : builderName} · **Reviewer:** ${reviewerName}`);
  if (s.branch) out.push(`- **Branch:** \`${s.branch}\``);
  if (s.cwd) out.push(`- **Worktree:** \`${s.cwd}\``);
  out.push(`- **Started:** ${time(s.startedAt)} · **Ended:** ${time(s.endedAt)}`);
  if (s.tokens) out.push(`- **Model turns:** ${s.tokens.turns} · ${s.tokens.input.toLocaleString()} in / ${s.tokens.output.toLocaleString()} out`);
  out.push(`- **Review:** ${s.lastVerdict ?? "not reviewed"} · ${s.reviewsConsumed}/2 rounds${s.finalRepairDone ? " · final repair applied" : ""}`);
  if (s.skills?.skillIds.length) out.push(`- **Builder skills:** ${s.skills.skillIds.join(", ")} (library ${s.skills.revision.slice(0, 7)})`);
  if (s.reviewerSkills?.skillIds.length) out.push(`- **Reviewer skills:** ${s.reviewerSkills.skillIds.join(", ")}`);
  if (s.dependsOn.length) out.push(`- **Depends on:** ${s.dependsOn.join(", ")}`);
  out.push("");
  out.push("**Brief given to the Builder**", "", "```", s.prompt, "```", "");
  if (s.lastFindings.length) {
    out.push("**Findings from the last review**", "");
    for (const f of s.lastFindings) out.push(`- [${f.severity}] ${f.title}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ""}` : ""}`);
    out.push("");
  }
  if (s.resultSummary) out.push("**Result**", "", nest(s.resultSummary, 3), "");
  if (s.errorText) out.push("**Error**", "", "```", s.errorText, "```", "");
  if (s.steps?.length) {
    out.push(`**What the agents did — ${s.steps.length} steps**`, "");
    for (const e of s.steps) out.push(...stepToMarkdown(e));
    out.push("");
  }
  return out;
}

export function toMarkdown(b: ProjectExport): string {
  const out: string[] = [];
  const p = b.project;
  out.push(`# ${p.title}${b.session ? ` — session ${b.session.key}` : ""}`, "");
  out.push(`- **State:** ${p.state}`);
  out.push(`- **Repository:** \`${p.rootPath}\``);
  out.push(`- **Director:** ${b.agents.director} · **Builder:** ${b.agents.builder} · **Reviewer:** ${b.agents.reviewer}`);
  out.push(`- **Created:** ${time(p.createdAt)}`);
  out.push(`- **Exported:** ${time(b.exportedAt)}`);
  out.push("");
  out.push("## Goal", "", nest(p.goal, 2), "");

  if (b.session) {
    out.push("## Session", "");
    out.push(...sessionToMarkdown(b.session, b.agents.builder, b.agents.reviewer));
    if (b.activity.length) {
      out.push("## Engine log for this session", "");
      for (const a of b.activity) out.push(`- \`${new Date(a.ts).toLocaleString()}\` **${a.kind}** — ${a.text}${a.detail ? `\n  > ${a.detail.replace(/\n/g, "\n  > ")}` : ""}`);
      out.push("");
    }
    return out.join("\n");
  }

  out.push("## Plan", "");
  for (const m of b.milestones) {
    out.push(`### ${m.key} — ${m.name} (${m.status})`, "");
    out.push(`- **Goal:** ${m.goal}`);
    if (m.acceptance) out.push(`- **Acceptance:** ${m.acceptance}`);
    if (m.dependsOn.length) out.push(`- **Depends on:** ${m.dependsOn.join(", ")}`);
    out.push("");
    for (const s of m.sessions) out.push(...sessionToMarkdown(s, b.agents.builder, b.agents.reviewer));
  }

  out.push("## Director conversation", "");
  for (const m of b.messages) {
    const who = m.role === "user" ? "🧑 Owner" : m.role === "observation" ? "⚙︎ Engine → Director" : `🤖 ${b.agents.director}`;
    out.push("---", "", `### ${who} · ${time(m.createdAt)}`, "");
    if (m.usage?.inputTokens != null) out.push(`> ${m.usage.inputTokens.toLocaleString()} in / ${(m.usage.outputTokens ?? 0).toLocaleString()} out tokens`, "");
    for (const e of m.activity ?? []) out.push(...stepToMarkdown(e));
    for (const tc of m.toolCalls ?? []) out.push(`- \`${tc.tool}\` — ${tc.ok ? "ok" : "failed"}${tc.summary ? `: ${tc.summary}` : ""}`);
    if (m.toolCalls?.length) out.push("");
    out.push(nest(m.content, 3), "");
    if (m.error) out.push(`> **Failed:** ${m.error}`, "");
  }

  out.push("## Engine log", "");
  for (const a of b.activity) out.push(`- \`${new Date(a.ts).toLocaleString()}\` **${a.kind}** — ${a.text}${a.detail ? `\n  > ${a.detail.replace(/\n/g, "\n  > ")}` : ""}`);
  out.push("");
  return out.join("\n");
}

export const toJson = (b: ProjectExport) => JSON.stringify(b, null, 2);

export const renderExport = (b: ProjectExport, format: ExportFormat) => (format === "json" ? toJson(b) : toMarkdown(b));
