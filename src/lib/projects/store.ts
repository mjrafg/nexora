/* ------------------------------------------------------------------
   Persistence for the Project Director engine (ported/adapted from
   Tandem's director/store.ts). Orchestration state only — plans,
   milestones, sessions, decisions, activity, the Project Chat.
   ------------------------------------------------------------------ */

import { newId, now, readDb, updateDb } from "@/lib/store/db";
import { emitActivity } from "@/lib/activity";
import { MAX_REVIEW_ROUNDS } from "./prompts";
import type {
  ActivityKind,
  Finding,
  MilestoneInput,
  MilestoneRecord,
  MilestoneView,
  ProjectActivity,
  ProjectMessage,
  ProjectRecord,
  ProjectState,
  ProjectView,
  SessionInput,
  SessionRecord,
  SessionStatus,
} from "./types";
import { sessionBranchName } from "./git";
import { LIBRARY_REVISION, isEnabled } from "@/lib/skills/library";
import type { SkillSelection } from "@/lib/skills/types";

export const projectChannel = (projectId: string) => `project:${projectId}`;

/* ---------------------------------------------------------------- reads */

export function getProject(id: string): ProjectRecord | null {
  return readDb().projects.find((p) => p.id === id) ?? null;
}

export function listProjects(): ProjectRecord[] {
  return readDb()
    .projects.slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function milestonesOf(projectId: string): MilestoneView[] {
  const db = readDb();
  return db.projectMilestones
    .filter((m) => m.projectId === projectId)
    .sort((a, b) => a.orderIdx - b.orderIdx)
    .map((m) => ({ ...m, sessions: db.projectSessions.filter((s) => s.milestoneId === m.id).sort((a, b) => a.key.localeCompare(b.key)) }));
}

export function milestoneByKey(projectId: string, key: string): MilestoneView | null {
  return milestonesOf(projectId).find((m) => m.key === key) ?? null;
}

export function getSession(projectId: string, key: string): SessionRecord | null {
  return readDb().projectSessions.find((s) => s.projectId === projectId && s.key === key) ?? null;
}

export function sessionsByStatus(projectId: string, statuses: SessionStatus[]): SessionRecord[] {
  return readDb().projectSessions.filter((s) => s.projectId === projectId && statuses.includes(s.status));
}

export function toProjectView(p: ProjectRecord): ProjectView {
  const db = readDb();
  const name = (id: string) => db.agents.find((a) => a.id === id)?.name ?? "(missing agent)";
  const milestones = milestonesOf(p.id);
  const all = milestones.flatMap((m) => m.sessions);
  return {
    ...p,
    milestones,
    directorAgentName: name(p.directorAgentId),
    builderAgentName: name(p.builderAgentId),
    reviewerAgentName: name(p.reviewerAgentId),
    counts: { sessions: all.length, running: all.filter((s) => s.status === "running").length, completed: all.filter((s) => s.status === "completed").length },
  };
}

/* ---------------------------------------------------------------- writes */

export function createProject(input: { title: string; rootPath: string; goal: string; directorAgentId: string; builderAgentId: string; reviewerAgentId: string }): ProjectRecord {
  const ts = now();
  const rec: ProjectRecord = {
    id: newId(),
    title: input.title,
    rootPath: input.rootPath,
    goal: input.goal,
    state: "PLANNING",
    directorAgentId: input.directorAgentId,
    builderAgentId: input.builderAgentId,
    reviewerAgentId: input.reviewerAgentId,
    integrationBranch: null,
    baseBranch: null,
    planSummary: null,
    planReviewRound: 0,
    pendingRecovery: null,
    directorSessions: {},
    createdAt: ts,
    updatedAt: ts,
  };
  updateDb((d) => {
    d.projects.push(rec);
  });
  return rec;
}

export function patchProject(id: string, patch: Partial<ProjectRecord>): ProjectRecord {
  const rec = updateDb((d) => {
    const p = d.projects.find((x) => x.id === id);
    if (!p) throw new Error("Project not found.");
    Object.assign(p, patch, { updatedAt: now() });
    return p;
  });
  emitActivity({ agentId: projectChannel(id), turnId: "project", kind: "status", title: "project", detail: JSON.stringify({ patched: Object.keys(patch) }) });
  return rec;
}

export function setProjectState(id: string, state: ProjectState, note?: string): void {
  patchProject(id, { state });
  addActivity(id, "state", note ?? `Project state → ${state}`);
}

export function deleteProject(id: string): void {
  updateDb((d) => {
    d.projects = d.projects.filter((p) => p.id !== id);
    d.projectMilestones = d.projectMilestones.filter((m) => m.projectId !== id);
    d.projectSessions = d.projectSessions.filter((s) => s.projectId !== id);
    d.projectActivity = d.projectActivity.filter((a) => a.projectId !== id);
    d.projectMessages = d.projectMessages.filter((m) => m.projectId !== id);
  });
}

/* ---------------------------------------------------------------- plan */

/** Validate keys/deps and detect cycles (Kahn); throws with a precise reason. */
export function validateDag<T extends { key: string; dependsOn: string[] }>(items: T[], what: string): void {
  const keys = new Set(items.map((i) => i.key));
  if (keys.size !== items.length) throw new Error(`Duplicate ${what} keys.`);
  for (const i of items) {
    for (const d of i.dependsOn) {
      if (d === i.key) throw new Error(`${what} ${i.key} depends on itself.`);
      if (!keys.has(d)) throw new Error(`${what} ${i.key} depends on unknown key ${d}.`);
    }
  }
  const indeg = new Map(items.map((i) => [i.key, i.dependsOn.length]));
  const queue = items.filter((i) => i.dependsOn.length === 0).map((i) => i.key);
  let seen = 0;
  while (queue.length) {
    const k = queue.shift()!;
    seen += 1;
    for (const i of items) {
      if (i.dependsOn.includes(k)) {
        const left = indeg.get(i.key)! - 1;
        indeg.set(i.key, left);
        if (left === 0) queue.push(i.key);
      }
    }
  }
  if (seen !== items.length) throw new Error(`Dependency cycle detected among ${what}s.`);
}

/** Replace the milestone plan. Milestones that already have sessions are kept (matched by key). */
export function setPlan(projectId: string, milestones: MilestoneInput[], summary: string): void {
  validateDag(milestones, "milestone");
  updateDb((d) => {
    const existing = d.projectMilestones.filter((m) => m.projectId === projectId);
    const byKey = new Map(existing.map((m) => [m.key, m]));
    const keep = new Set(milestones.map((m) => m.key));
    for (const old of existing) {
      if (!keep.has(old.key)) {
        if (d.projectSessions.some((s) => s.milestoneId === old.id)) {
          throw new Error(`Milestone ${old.key} already has sessions and cannot be dropped — mark it complete or keep it in the plan.`);
        }
        d.projectMilestones = d.projectMilestones.filter((m) => m.id !== old.id);
      }
    }
    milestones.forEach((m, idx) => {
      const old = byKey.get(m.key);
      if (old) {
        if (old.status !== "planned" && JSON.stringify(m.dependsOn) !== JSON.stringify(old.dependsOn)) {
          throw new Error(`Milestone ${m.key} is ${old.status} — its dependencies can no longer change. Revise its goal/acceptance, or restructure via NEW milestones instead.`);
        }
        Object.assign(old, { name: m.name, goal: m.goal, acceptance: m.acceptance, orderIdx: idx, dependsOn: m.dependsOn });
      } else {
        const rec: MilestoneRecord = { id: newId(), projectId, key: m.key, name: m.name, goal: m.goal, acceptance: m.acceptance, status: "planned", orderIdx: idx, dependsOn: m.dependsOn };
        d.projectMilestones.push(rec);
      }
    });
    const p = d.projects.find((x) => x.id === projectId);
    if (p) {
      p.planSummary = summary;
      p.updatedAt = now();
    }
  });
}

/**
 * Record what the Director chose, with the library revision it chose from —
 * so an execution record can always answer "which guidance did this run
 * with?", even after the library moves on. Unknown or unavailable ids are
 * dropped here rather than failing the plan: a bad id is a mis-selection,
 * not a reason to lose a milestone's decomposition.
 */
function selection(ids: string[] | undefined): SkillSelection | null {
  const wanted = (ids ?? []).map((x) => String(x).trim()).filter(Boolean);
  if (!wanted.length) return null;
  const keep = [...new Set(wanted)].filter((id) => isEnabled(id));
  if (!keep.length) return null;
  return { skillIds: keep, revision: LIBRARY_REVISION, chosenAt: now(), chosenBy: "director" };
}

/** Define (or extend) the session plan for one milestone. Existing sessions are kept by key. */
export function planSessions(projectId: string, milestoneKey: string, sessions: SessionInput[]): MilestoneView {
  const ms = milestoneByKey(projectId, milestoneKey);
  if (!ms) throw new Error(`Unknown milestone: ${milestoneKey}`);
  const all = readDb().projectSessions.filter((s) => s.projectId === projectId);
  const merged = [
    ...all.filter((s) => !sessions.some((n) => n.key === s.key)).map((s) => ({ key: s.key, dependsOn: s.dependsOn })),
    ...sessions.map((s) => ({ key: s.key, dependsOn: s.dependsOn })),
  ];
  validateDag(merged, "session");
  updateDb((d) => {
    for (const s of sessions) {
      const old = d.projectSessions.find((x) => x.projectId === projectId && x.key === s.key);
      if (old) {
        if (old.status !== "planned" && old.status !== "abandoned") {
          throw new Error(`Session ${s.key} is ${old.status} and its definition can no longer be replaced — use recover_session instead.`);
        }
        Object.assign(old, { name: s.name, purpose: s.purpose, prompt: s.prompt, dependsOn: s.dependsOn, status: "planned", agentId: s.agentId ?? null, originalRequest: s.prompt, skills: selection(s.skills), reviewerSkills: selection(s.reviewerSkills) });
      } else {
        const rec: SessionRecord = {
          id: newId(),
          projectId,
          milestoneId: ms.id,
          key: s.key,
          name: s.name,
          purpose: s.purpose,
          prompt: s.prompt,
          status: "planned",
          dependsOn: s.dependsOn,
          branch: s.isolated ? sessionBranchName(projectId, s.key) : null,
          cwd: null,
          agentId: s.agentId ?? null,
          skills: selection(s.skills),
          reviewerSkills: selection(s.reviewerSkills),
          builderSessionId: null,
          originalRequest: s.prompt,
          reviewsConsumed: 0,
          finalRepairDone: false,
          lastVerdict: null,
          lastFindings: [],
          resultSummary: null,
          stopReason: null,
          errorText: null,
          startedAt: null,
          endedAt: null,
        };
        d.projectSessions.push(rec);
      }
    }
  });
  return milestoneByKey(projectId, milestoneKey)!;
}

export function patchSession(projectId: string, key: string, patch: Partial<SessionRecord>): SessionRecord {
  const rec = updateDb((d) => {
    const s = d.projectSessions.find((x) => x.projectId === projectId && x.key === key);
    if (!s) throw new Error(`Unknown session: ${key}`);
    Object.assign(s, patch);
    return s;
  });
  emitActivity({ agentId: projectChannel(projectId), turnId: "project", kind: "status", title: `session:${key}`, detail: rec.status, meta: rec.name });
  return rec;
}

export function patchMilestone(projectId: string, key: string, patch: Partial<MilestoneRecord>): void {
  updateDb((d) => {
    const m = d.projectMilestones.find((x) => x.projectId === projectId && x.key === key);
    if (m) Object.assign(m, patch);
  });
  emitActivity({ agentId: projectChannel(projectId), turnId: "project", kind: "status", title: `milestone:${key}`, detail: patch.status });
}

/* ---------------------------------------------------------------- invariants */

export function depsSatisfied(projectId: string, key: string): { ok: boolean; missing: string[] } {
  const s = getSession(projectId, key);
  if (!s) return { ok: false, missing: [key] };
  const missing = s.dependsOn.filter((d) => getSession(projectId, d)?.status !== "completed");
  return { ok: missing.length === 0, missing };
}

export function milestoneDepsOpen(projectId: string, msKey: string): string[] {
  const ms = milestoneByKey(projectId, msKey);
  if (!ms) return [msKey];
  return ms.dependsOn.filter((d) => milestoneByKey(projectId, d)?.status !== "completed");
}

export function openMilestones(projectId: string): string[] {
  return milestonesOf(projectId)
    .filter((m) => m.status !== "completed")
    .map((m) => m.key);
}

export function readySessions(projectId: string): string[] {
  return sessionsByStatus(projectId, ["planned"])
    .filter((s) => depsSatisfied(projectId, s.key).ok)
    .map((s) => s.key);
}

/** one session at a time in a shared directory */
export function dirBusyWithin(projectId: string, cwd: string, exceptKey?: string): SessionRecord | null {
  return sessionsByStatus(projectId, ["running"]).find((s) => s.cwd === cwd && s.key !== exceptKey) ?? null;
}

/* ---------------------------------------------------------------- activity + chat */

export function addActivity(projectId: string, kind: ActivityKind, text: string, detail?: string): void {
  const rec: ProjectActivity = { id: newId(), projectId, ts: Date.now(), kind, text: text.slice(0, 500), detail: detail?.slice(0, 4_000) ?? null };
  updateDb((d) => {
    d.projectActivity.push(rec);
    if (d.projectActivity.length > 5000) d.projectActivity.splice(0, d.projectActivity.length - 5000);
  });
  emitActivity({ agentId: projectChannel(projectId), turnId: "project", kind: "status", title: `activity:${kind}`, detail: rec.text, meta: rec.detail ?? undefined });
}

export function listActivity(projectId: string, limit = 200): ProjectActivity[] {
  return readDb()
    .projectActivity.filter((a) => a.projectId === projectId)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

export function addMessage(m: Omit<ProjectMessage, "id" | "createdAt">): ProjectMessage {
  const rec: ProjectMessage = { id: newId(), createdAt: now(), ...m };
  updateDb((d) => {
    d.projectMessages.push(rec);
  });
  emitActivity({ agentId: projectChannel(m.projectId), turnId: "project", kind: "status", title: `message:${m.role}`, detail: rec.id });
  return rec;
}

export function listMessages(projectId: string): ProjectMessage[] {
  return readDb().projectMessages.filter((m) => m.projectId === projectId);
}

/* ---------------------------------------------------------------- snapshots for the Director */

function view(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)} …[truncated for this view]` : s;
}

export function planDocument(projectId: string): string {
  const p = getProject(projectId);
  if (!p) return "(project not found)";
  const lines = [`# Project goal (complete, as given by the owner)\n${p.goal}`];
  if (p.planSummary) lines.push(`\n# Plan summary\n${p.planSummary}`);
  lines.push("\n# Milestones");
  for (const m of milestonesOf(projectId)) {
    lines.push(`\n${m.key} — ${m.name}${m.dependsOn.length ? ` (after ${m.dependsOn.join(", ")})` : ""}`);
    lines.push(`Goal: ${m.goal}`);
    if (m.acceptance) lines.push(`Acceptance: ${m.acceptance}`);
  }
  return lines.join("\n");
}

export function stateSnapshot(projectId: string): string {
  const p = getProject(projectId);
  if (!p) return "(project not found)";
  const lines = [
    `Run state: ${p.state}${p.integrationBranch ? ` · integration branch: ${p.integrationBranch}` : ""}${p.baseBranch ? ` · base branch: ${p.baseBranch}` : ""}`,
    `Repository: ${p.rootPath}`,
    `Goal: ${view(p.goal, 1_200)}`,
  ];
  const milestones = milestonesOf(projectId);
  if (milestones.length === 0) lines.push("No milestone plan yet — produce one with project_set_plan.");
  for (const m of milestones) {
    lines.push(`\n${m.key} — ${m.name} [${m.status}]${m.dependsOn.length ? ` (after ${m.dependsOn.join(", ")})` : ""}`);
    lines.push(`  goal: ${view(m.goal, 200)}`);
    if (m.acceptance) lines.push(`  acceptance: ${view(m.acceptance, 200)}`);
    for (const s of m.sessions) {
      const dep = s.dependsOn.length ? ` deps:[${s.dependsOn.join(",")}]` : "";
      const extras = [
        s.branch ? `branch ${s.branch}` : "shared dir",
        s.agentId ? `agent ${s.agentId}` : "",
        s.status === "paused" && s.stopReason ? (s.stopReason === "user_stop" ? "stopped by the owner" : s.stopReason === "restart" ? "interrupted by a restart" : "stopped by project pause") : "",
        s.resultSummary ? `result: ${s.resultSummary.slice(0, 120)}` : "",
        s.startedAt ? `reviews ${Math.min(s.reviewsConsumed, MAX_REVIEW_ROUNDS)}/${MAX_REVIEW_ROUNDS} spent${s.lastVerdict ? ` · last verdict: ${s.lastVerdict}` : ""}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(`  ${s.key} ${s.name} [${s.status}]${dep} — ${extras}`);
    }
  }
  const recent = listActivity(projectId, 8).reverse();
  if (recent.length) {
    lines.push("\nRecent project activity:");
    for (const a of recent) lines.push(`  ${new Date(a.ts).toISOString().slice(11, 16)} ${a.text}`);
  }
  return lines.join("\n");
}

export function findingsAsText(items: Finding[]): string {
  return items
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.title}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ""}` : ""}\n   ${f.detail}${f.recommendation ? `\n   Recommendation: ${f.recommendation}` : ""}`)
    .join("\n");
}
