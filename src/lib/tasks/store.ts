/* ------------------------------------------------------------------
   Task persistence and the queries the UI, the tools and the dispatcher
   all share. Nothing here starts work — see service.ts for that.
   ------------------------------------------------------------------ */

import { newId, now, readDb, updateDb } from "@/lib/store/db";
import type { AgentRecord } from "@/lib/runtime/types";
import { isAgentBusy } from "@/lib/runtime/stop";
import { resolveAgentWaiting } from "@/lib/agents/waiting";
import { TOOL_CATALOG } from "@/lib/runtime/catalog";
import type { TaskEvent, TaskEventKind, TaskLink, TaskPriority, TaskRecord, TaskStatus, TaskView, TeamMember } from "./types";
import { PRIORITY_RANK } from "./types";

export const OPEN_STATUSES: TaskStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED"];

/* ---------------------------------------------------------------- reads */

export function getTask(id: string): TaskRecord | undefined {
  return readDb().tasks.find((t) => t.id === id);
}

export function listTasks(filter: { agentId?: string; managerAgentId?: string; status?: TaskStatus[] } = {}): TaskRecord[] {
  return readDb()
    .tasks.filter(
      (t) =>
        (!filter.agentId || t.assignedToAgentId === filter.agentId) &&
        (!filter.managerAgentId || t.managerAgentId === filter.managerAgentId) &&
        (!filter.status || filter.status.includes(t.status))
    )
    .sort(byQueueOrder);
}

/** Urgency first, then oldest — the order the dispatcher wakes work in. */
export function byQueueOrder(a: TaskRecord, b: TaskRecord): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.localeCompare(b.createdAt);
}

export function taskEvents(taskId: string): TaskEvent[] {
  return readDb().taskEvents.filter((e) => e.taskId === taskId);
}

export function toTaskView(t: TaskRecord): TaskView {
  const db = readDb();
  const agents = db.agents;
  const one = (id?: string | null) => agents.find((a) => a.id === id);
  const assignee = one(t.assignedToAgentId);
  const manager = one(t.managerAgentId);
  const creator = one(t.createdByAgentId);
  const kids = db.tasks.filter((x) => x.parentTaskId === t.id).sort(byQueueOrder);
  const parent = t.parentTaskId ? db.tasks.find((x) => x.id === t.parentTaskId) : undefined;
  return {
    ...t,
    assignedTo: assignee ? { id: assignee.id, name: assignee.name, role: assignee.role, dept: assignee.dept } : null,
    manager: manager ? { id: manager.id, name: manager.name, role: manager.role } : null,
    createdBy: t.createdByOwner ? { id: "owner", name: "Owner" } : creator ? { id: creator.id, name: creator.name } : null,
    parent: parent ? toLink(parent) : null,
    children: kids.map(toLink),
    // delegated and quiet: the work is out with the team, not stalled
    waitingForTeam: t.status === "IN_PROGRESS" && kids.some((k) => OPEN_STATUSES.includes(k.status)) && !isAgentBusy(t.assignedToAgentId ?? ""),
  };
}

export function toLink(t: TaskRecord): TaskLink {
  const a = readDb().agents.find((x) => x.id === t.assignedToAgentId);
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    assignedTo: a ? { id: a.id, name: a.name, role: a.role } : null,
    resultSummary: t.resultSummary ?? undefined,
    blockedReason: t.blockedReason ?? undefined,
  };
}

/* ---------------------------------------------------------------- delegation */

export function childTasks(parentTaskId: string): TaskRecord[] {
  return readDb().tasks.filter((t) => t.parentTaskId === parentTaskId).sort(byQueueOrder);
}

/**
 * The delegated work that must be settled before the parent can honestly be
 * called finished: anything still queued, running, or stuck on a blocker.
 */
export function blockingChildren(parentTaskId: string): TaskRecord[] {
  return childTasks(parentTaskId).filter((t) => OPEN_STATUSES.includes(t.status));
}

/** Every task under this one, to any depth. */
export function descendants(parentTaskId: string): TaskRecord[] {
  const all = readDb().tasks;
  const out: TaskRecord[] = [];
  const walk = (id: string, depth: number) => {
    if (depth > 20) return;
    for (const t of all.filter((x) => x.parentTaskId === id)) {
      if (out.some((o) => o.id === t.id)) continue;
      out.push(t);
      walk(t.id, depth + 1);
    }
  };
  walk(parentTaskId, 0);
  return out;
}

/**
 * May `childId` hang under `parentId`? Not itself, not something that already
 * sits above it — a loop in the tree would make "is my work finished?"
 * unanswerable.
 */
export function canParent(childId: string, parentId: string): string | null {
  if (!parentId) return null;
  if (childId === parentId) return "A task cannot be a child of itself.";
  const all = readDb().tasks;
  if (!all.some((t) => t.id === parentId)) return "No task with that id to hang this under.";
  for (let up = all.find((t) => t.id === parentId), hops = 0; up && hops < 20; hops++) {
    if (up.id === childId) return "That would put the work underneath itself.";
    up = up.parentTaskId ? all.find((t) => t.id === up!.parentTaskId) : undefined;
  }
  return null;
}

/* ---------------------------------------------------------------- org */

export function directReports(managerAgentId: string): AgentRecord[] {
  return readDb().agents.filter((a) => a.managerAgentId === managerAgentId);
}

export function isManager(agentId: string): boolean {
  return readDb().agents.some((a) => a.managerAgentId === agentId);
}

export function managerOf(agentId: string): AgentRecord | undefined {
  const db = readDb();
  const mine = db.agents.find((a) => a.id === agentId);
  return mine?.managerAgentId ? db.agents.find((a) => a.id === mine.managerAgentId) : undefined;
}

/** What a manager needs to choose someone: role, current state, workload. */
export function teamOf(managerAgentId: string): TeamMember[] {
  return directReports(managerAgentId).map((a) => member(a));
}

export function member(agent: AgentRecord): TeamMember {
  const mine = listTasks({ agentId: agent.id, status: OPEN_STATUSES });
  const active = mine.filter((t) => t.status === "IN_PROGRESS");
  const blocked = mine.filter((t) => t.status === "BLOCKED");
  const waiting = resolveAgentWaiting(agent);
  const status: TeamMember["status"] = waiting
    ? "WAITING"
    : active.length || isAgentBusy(agent.id)
      ? "WORKING"
      : blocked.length
        ? "BLOCKED"
        : "IDLE";
  return {
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    dept: agent.dept,
    status,
    activeTasks: active.length,
    pendingTasks: mine.filter((t) => t.status === "TODO").length,
    blockedTasks: blocked.length,
    currentTask: active[0]?.title,
    waitingFor: waiting ? `${waiting.headline}: ${waiting.label}` : undefined,
    // a manager cannot choose well from role and workload alone: what someone
    // is already allowed to touch is usually the deciding fact
    skills: agent.skills.slice(0, 12),
    tools: agent.toolPermissions.map((id) => TOOL_CATALOG.find((t) => t.id === id)?.label ?? id),
  };
}

/* ---------------------------------------------------------------- writes */

export function createTask(input: {
  title: string;
  description: string;
  priority?: TaskPriority;
  assignedToAgentId?: string | null;
  managerAgentId?: string | null;
  createdByAgentId?: string | null;
  createdByOwner: boolean;
  workingDirectory?: string | null;
  originChatId?: string | null;
  parentTaskId?: string | null;
}): TaskRecord {
  const ts = now();
  const assignee = input.assignedToAgentId ?? null;
  const task: TaskRecord = {
    id: newId(),
    title: input.title.trim().slice(0, 200),
    description: input.description.trim().slice(0, 8_000),
    status: "TODO",
    priority: input.priority ?? "NORMAL",
    createdByAgentId: input.createdByAgentId ?? null,
    createdByOwner: input.createdByOwner,
    assignedToAgentId: assignee,
    // accountability follows the assignee's manager unless the creator is one
    managerAgentId: input.managerAgentId ?? (assignee ? managerOf(assignee)?.id ?? null : null),
    chatId: null,
    parentTaskId: input.parentTaskId ?? null,
    originChatId: input.originChatId ?? null,
    workingDirectory: input.workingDirectory ?? null,
    createdAt: ts,
    updatedAt: ts,
  };
  updateDb((d) => { d.tasks.push(task); });
  return task;
}

export function patchTask(id: string, patch: Partial<TaskRecord>): TaskRecord | undefined {
  return updateDb((d) => {
    const t = d.tasks.find((x) => x.id === id);
    if (!t) return undefined;
    Object.assign(t, patch, { updatedAt: now() });
    return { ...t };
  });
}

/**
 * Move a task to a new status only from the statuses that may legally lead
 * there. Returns null when the transition no longer applies — which is how
 * two wake events racing for the same task resolve into exactly one run.
 */
export function transition(id: string, from: TaskStatus[], to: TaskStatus, patch: Partial<TaskRecord> = {}): TaskRecord | null {
  return updateDb((d) => {
    const t = d.tasks.find((x) => x.id === id);
    if (!t || !from.includes(t.status)) return null;
    Object.assign(t, patch, { status: to, updatedAt: now() });
    return { ...t };
  });
}

export function addTaskEvent(taskId: string, kind: TaskEventKind, text: string, opts: { agentId?: string | null; by?: TaskEvent["by"] } = {}): TaskEvent {
  const ev: TaskEvent = {
    id: newId(),
    taskId,
    kind,
    text: text.slice(0, 600),
    agentId: opts.agentId ?? null,
    by: opts.by ?? "system",
    at: now(),
  };
  updateDb((d) => {
    d.taskEvents.push(ev);
    if (d.taskEvents.length > 5_000) d.taskEvents.splice(0, d.taskEvents.length - 5_000);
  });
  // whatever is watching the company sees this within a second
  void import("@/lib/office/floor").then((m) => m.pokeOffice(`task:${kind}`, opts.agentId ?? undefined)).catch(() => undefined);
  return ev;
}

/** Everything an agent owns, when the agent is removed. */
export function releaseAgentTasks(agentId: string): void {
  const open = listTasks({ agentId, status: OPEN_STATUSES });
  for (const t of open) {
    patchTask(t.id, { assignedToAgentId: null, status: t.status === "IN_PROGRESS" ? "TODO" : t.status });
    addTaskEvent(t.id, "updated", "Unassigned: the agent who held this task was removed.");
  }
  updateDb((d) => {
    for (const t of d.tasks) if (t.managerAgentId === agentId) t.managerAgentId = null;
  });
}
