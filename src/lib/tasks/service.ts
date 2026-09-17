/* ------------------------------------------------------------------
   Task execution.

   The loop this file owns:

     assigned → the agent is woken automatically (never "start the task")
              → it works with every Nexora system it already has
              → it completes, or blocks for a reason a human must resolve
              → its manager is woken with the outcome

   Two rules hold the whole thing together:

   1. The execution scope is `task:<id>` for the entire life of the task, so
      the side-effect guard, capability resolution, credential and payment
      waits and every resume all belong to the same piece of work — a wake
      after a capability is granted is the SAME scope, not a new one.
   2. A task moves out of TODO exactly once (see store.transition), so two
      events arriving together can never launch the same work twice.
   ------------------------------------------------------------------ */

import { now, readDb } from "@/lib/store/db";
import { isAgentBusy } from "@/lib/runtime/stop";
import { createChat } from "@/lib/chats/store";
import { getPrompt, renderPrompt } from "@/lib/prompts";
import { wakeAgent } from "./wake";
import type { TaskPriority, TaskRecord } from "./types";
import {
  OPEN_STATUSES, addTaskEvent, blockingChildren, byQueueOrder, childTasks, descendants, getTask, listTasks, managerOf, patchTask, taskEvents, toTaskView, transition,
} from "./store";

export const taskScope = (taskId: string) => `task:${taskId}`;
/** A manager's wake-up is its own scope: the guard must not dedupe it against the employee's work. */
export const managerScope = (taskId: string) => `task:${taskId}:manager`;

/* ---------------------------------------------------------------- dispatch */

// one dispatch per agent at a time, so a burst of events cannot double-start
const dispatching = new Set<string>();

/**
 * Give an agent its next piece of work, if it is free to take it.
 * Safe to call as often as you like: it is a no-op unless something changed.
 */
export async function dispatchAgent(agentId: string): Promise<TaskRecord | null> {
  if (dispatching.has(agentId)) return null;
  dispatching.add(agentId);
  try {
    const db = readDb();
    const agent = db.agents.find((a) => a.id === agentId);
    if (!agent) return null;
    const mine = listTasks({ agentId, status: OPEN_STATUSES });
    // one task at a time per agent: a second concurrent run would fight over
    // the same browser session and the same conversation
    if (mine.some((t) => t.status === "IN_PROGRESS")) return null;
    if (isAgentBusy(agentId)) return null;
    // an agent parked on a credential/capability/payment request is not idle
    if (agent.waitingFor) return null;
    const next = mine.filter((t) => t.status === "TODO").sort(byQueueOrder)[0];
    if (!next) return null;
    return await startTask(next.id);
  } finally {
    dispatching.delete(agentId);
  }
}

/** Move a task into execution and wake its agent with everything it needs. */
export async function startTask(taskId: string): Promise<TaskRecord | null> {
  const before = getTask(taskId);
  if (!before?.assignedToAgentId) return null;
  const agentId = before.assignedToAgentId;
  const db = readDb();
  const agent = db.agents.find((a) => a.id === agentId);
  if (!agent) return null;

  // the work gets its own conversation, so the transcript of a task is the
  // task — and so an auto-resume lands back in the right thread
  const chatId = before.chatId ?? createChat(agentId, before.title).id;
  const task = transition(taskId, ["TODO"], "IN_PROGRESS", { startedAt: now(), chatId });
  if (!task) return null; // another event got there first

  addTaskEvent(taskId, "started", `${agent.name} started work`, { agentId, by: "system" });
  const { sendAgentMessage } = await import("@/lib/runtime");
  void sendAgentMessage(agentId, briefFor(task), { origin: "system", scopeId: taskScope(taskId), chatId, cwd: task.workingDirectory ?? undefined })
    .catch((err) => {
      console.error("[tasks] execution failed:", err);
      addTaskEvent(taskId, "note", `Execution could not start: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => { void afterRun(agentId); });
  return task;
}

/** When a run ends, the agent may be free for the next queued task. */
async function afterRun(agentId: string): Promise<void> {
  const still = listTasks({ agentId, status: ["IN_PROGRESS"] });
  // a task still IN_PROGRESS after its turn ended is waiting on something
  // (a capability, a credential, the owner) — its own resume will wake it
  const agent = readDb().agents.find((a) => a.id === agentId);
  if (still.length || agent?.waitingFor) return;
  await dispatchAgent(agentId).catch((err) => console.error("[tasks] dispatch failed:", err));
}

/** The brief an agent is woken with: the work, who wants it, and nothing else. */
function briefFor(task: TaskRecord): string {
  const view = toTaskView(task);
  const from = view.createdBy?.name ?? "Nexora";
  return renderPrompt("task-brief", {
    title: task.title,
    priority: task.priority,
    assigned_by: `${from}${view.manager && view.manager.id !== task.assignedToAgentId ? ` · reports to ${view.manager.name}` : ""}`,
    task_id: task.id,
    // the folder line carries its own line break so the brief reads the same
    // whether or not the work is pinned to a directory
    folder_block: task.workingDirectory ? `${renderPrompt("task-brief-folder-line", { folder: task.workingDirectory })}\n` : "",
    description: task.description || getPrompt("task-brief-no-detail"),
  });
}

/* ---------------------------------------------------------------- assignment */

export async function assignTask(taskId: string, agentId: string, opts: { by?: "owner" | "agent"; byAgentId?: string; reason?: string } = {}): Promise<TaskRecord | null> {
  const task = getTask(taskId);
  if (!task) return null;
  const db = readDb();
  const agent = db.agents.find((a) => a.id === agentId);
  if (!agent) return null;
  const previous = task.assignedToAgentId;
  // already theirs (a task created with an assignee comes through here): there
  // is nothing to record, but they still have to be woken for it
  if (previous === agentId && task.status !== "CANCELLED") {
    if (OPEN_STATUSES.includes(task.status)) void dispatchAgent(agentId);
    return task;
  }

  // the old holder must stop: a running turn is cut, and its queue moves on
  if (previous && previous !== agentId) await stopAgentWork(previous, taskId);

  const updated = patchTask(taskId, {
    assignedToAgentId: agentId,
    managerAgentId: task.managerAgentId ?? managerOf(agentId)?.id ?? null,
    // a reassigned task starts again for the new holder; its history stays
    status: task.status === "DONE" || task.status === "CANCELLED" ? task.status : "TODO",
    startedAt: null,
    chatId: null,
  });
  const actor = opts.byAgentId ? db.agents.find((a) => a.id === opts.byAgentId)?.name ?? "A manager" : "The owner";
  addTaskEvent(
    taskId,
    previous ? "reassigned" : "assigned",
    previous
      ? `${actor} moved this from ${db.agents.find((a) => a.id === previous)?.name ?? "someone"} to ${agent.name}${opts.reason ? ` — ${opts.reason}` : ""}`
      : `${actor} assigned this to ${agent.name}${opts.reason ? ` — ${opts.reason}` : ""}`,
    { agentId, by: opts.by ?? "owner" }
  );
  if (updated && OPEN_STATUSES.includes(updated.status)) void dispatchAgent(agentId);
  return updated ?? null;
}

/** Stop whatever the agent is doing for this task, without pretending it finished. */
async function stopAgentWork(agentId: string, taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (task?.status !== "IN_PROGRESS") return;
  const { stopTurn } = await import("@/lib/runtime/stop");
  stopTurn(agentId);
}

export function updateTask(taskId: string, patch: { title?: string; description?: string; priority?: TaskPriority }, by: { by: "owner" | "agent"; byAgentId?: string }): TaskRecord | null {
  const task = getTask(taskId);
  if (!task) return null;
  const changes: string[] = [];
  if (patch.priority && patch.priority !== task.priority) changes.push(`priority ${task.priority} → ${patch.priority}`);
  if (patch.title && patch.title !== task.title) changes.push("title");
  if (patch.description && patch.description !== task.description) changes.push("description");
  const updated = patchTask(taskId, {
    ...(patch.title ? { title: patch.title.trim().slice(0, 200) } : {}),
    ...(patch.description ? { description: patch.description.trim().slice(0, 8_000) } : {}),
    ...(patch.priority ? { priority: patch.priority } : {}),
  });
  if (changes.length) {
    const actor = by.byAgentId ? readDb().agents.find((a) => a.id === by.byAgentId)?.name ?? "A manager" : "The owner";
    addTaskEvent(taskId, patch.priority ? "priority" : "updated", `${actor} changed ${changes.join(", ")}`, { by: by.by });
  }
  // a task that just became urgent may deserve to run before what is queued
  if (updated && updated.status === "TODO" && updated.assignedToAgentId) void dispatchAgent(updated.assignedToAgentId);
  return updated ?? null;
}

export async function cancelTask(taskId: string, reason: string, by: { by: "owner" | "agent"; byAgentId?: string }): Promise<TaskRecord | null> {
  const task = getTask(taskId);
  if (!task || task.status === "CANCELLED") return task ?? null;
  const wasRunning = task.status === "IN_PROGRESS" && task.assignedToAgentId;
  const updated = patchTask(taskId, { status: "CANCELLED", blockedReason: null, completedAt: now() });
  const actor = by.byAgentId ? readDb().agents.find((a) => a.id === by.byAgentId)?.name ?? "A manager" : "The owner";
  addTaskEvent(taskId, "cancelled", `${actor} cancelled this — ${reason || "no reason given"}`, { by: by.by });
  if (wasRunning && task.assignedToAgentId) {
    const { stopTurn } = await import("@/lib/runtime/stop");
    stopTurn(task.assignedToAgentId);
    void dispatchAgent(task.assignedToAgentId);
  }
  // nothing was delegated out of this for its own sake: if the objective is
  // dropped, the work underneath it is dropped too, queued or running
  for (const child of descendants(taskId)) {
    if (!OPEN_STATUSES.includes(child.status)) continue;
    const running = child.status === "IN_PROGRESS" && child.assignedToAgentId;
    patchTask(child.id, { status: "CANCELLED", blockedReason: null, completedAt: now() });
    addTaskEvent(child.id, "cancelled", `Cancelled with the work it was part of: “${task.title}”`, { by: by.by });
    if (running && child.assignedToAgentId) {
      const { stopTurn } = await import("@/lib/runtime/stop");
      stopTurn(child.assignedToAgentId);
      void dispatchAgent(child.assignedToAgentId);
    }
  }
  return updated ?? null;
}

/* ---------------------------------------------------------------- outcomes */

export async function completeTask(taskId: string, agentId: string, summary: string, result?: Record<string, unknown>): Promise<TaskRecord | null> {
  // a worker whose task was moved on while it was thinking must not be able
  // to finish it out from under whoever holds it now
  if (getTask(taskId)?.assignedToAgentId !== agentId) return null;
  // delegating is not delivering: while work handed out of this is still
  // queued, running or stuck, this cannot honestly be called finished
  if (blockingChildren(taskId).length) return null;
  const kids = childTasks(taskId);
  const task = transition(taskId, ["IN_PROGRESS", "TODO", "BLOCKED"], "DONE", {
    resultSummary: summary.trim().slice(0, 4_000),
    // what was delegated is recorded by Nexora, not by the summary — a piece
    // of work that was cancelled cannot quietly read as delivered
    result: kids.length ? { ...(result ?? {}), delegated: kids.map((k) => ({ task_id: k.id, title: k.title, status: k.status, assigned_to: toTaskView(k).assignedTo?.name ?? null })) } : result ?? null,
    blockedReason: null,
    completedAt: now(),
  });
  if (!task) return null;
  const dropped = kids.filter((k) => k.status === "CANCELLED");
  addTaskEvent(taskId, "completed", summary.slice(0, 300), { agentId, by: "agent" });
  if (dropped.length) addTaskEvent(taskId, "note", `Finished with ${dropped.length} delegated task(s) cancelled rather than delivered: ${dropped.map((d) => `“${d.title}”`).join(", ")}`, { agentId, by: "system" });
  await reportOutcome(task, "DONE");
  void dispatchAgent(agentId);
  return task;
}

export async function blockTask(taskId: string, agentId: string, reason: string): Promise<TaskRecord | null> {
  if (getTask(taskId)?.assignedToAgentId !== agentId) return null;
  const task = transition(taskId, ["IN_PROGRESS", "TODO"], "BLOCKED", { blockedReason: reason.trim().slice(0, 1_000) });
  if (!task) return null;
  addTaskEvent(taskId, "blocked", reason.slice(0, 300), { agentId, by: "agent" });
  await reportOutcome(task, "BLOCKED");
  void dispatchAgent(agentId);
  return task;
}

/**
 * Somebody is waiting to hear how this went. Who, depends on where the work
 * came from:
 *
 *   delegated out of another task → the person holding THAT task, woken
 *     inside it, so they carry on with their own objective in front of them;
 *   otherwise                     → the manager accountable for it, in the
 *     conversation the work was asked for in;
 *   nobody                        → the owner, in Needs You.
 *
 * Always as an event, never by polling, and never more than one turn for
 * several outcomes that land together.
 */
async function reportOutcome(task: TaskRecord, outcome: "DONE" | "BLOCKED"): Promise<void> {
  const view = toTaskView(task);
  const employee = view.assignedTo?.name ?? "An agent";

  const parent = task.parentTaskId ? getTask(task.parentTaskId) : undefined;
  if (parent && OPEN_STATUSES.includes(parent.status) && parent.assignedToAgentId) {
    const siblings = blockingChildren(parent.id).filter((c) => c.id !== task.id);
    wakeAgent({
      agentId: parent.assignedToAgentId,
      scopeId: taskScope(parent.id),
      chatId: parent.chatId ?? undefined,
      text: renderPrompt(outcome === "DONE" ? "delegated-work-finished" : "delegated-work-blocked", {
        objective_title: parent.title,
        objective_id: parent.id,
        task_title: task.title,
        task_id: task.id,
        employee,
        result: task.resultSummary ?? "(nothing recorded)",
        reason: task.blockedReason ?? "(nothing recorded)",
        detail_block: task.result && outcome === "DONE" ? `\n\nDetail: ${JSON.stringify(task.result).slice(0, 800)}` : "",
        tail: siblings.length
          ? renderPrompt("delegated-work-still-out", {
              count: siblings.length,
              list: siblings.map((c) => `“${c.title}” — ${toTaskView(c).assignedTo?.name ?? "unassigned"} (${c.status})`).join("; "),
            })
          : getPrompt("delegated-work-all-back"),
      }),
    });
    return;
  }

  if (!task.managerAgentId) {
    if (outcome === "BLOCKED") await tellOwner(task, employee);
    return;
  }
  const text = renderPrompt(outcome === "DONE" ? "task-finished-manager-report" : "task-blocked-manager-report", {
    title: task.title,
    employee,
    task_id: task.id,
    result: task.resultSummary ?? "(no summary)",
    // an empty detail still contributed a line break before the closing
    detail_block: task.result ? `\n\nDetail: ${JSON.stringify(task.result).slice(0, 800)}` : "\n",
    reason: task.blockedReason ?? "(no reason given)",
    history: recentHistory(task.id),
  });
  // back into the conversation the work came out of, when there is one: a
  // result that lands in some other thread is a result the owner never sees
  const home = task.originChatId ? readDb().chats.find((c) => c.id === task.originChatId && c.agentId === task.managerAgentId) : undefined;
  wakeAgent({
    agentId: task.managerAgentId,
    scopeId: managerScope(task.id),
    chatId: home?.id,
    text,
  });
}

/** No manager: the owner is the manager, and Needs You is where they look. */
async function tellOwner(task: TaskRecord, employee: string): Promise<void> {
  if (!task.assignedToAgentId) return;
  const { createOwnerAction } = await import("@/lib/owner-actions/service");
  await createOwnerAction({
    agentId: task.assignedToAgentId,
    kind: "decision",
    title: `${employee} is blocked on “${task.title}”`,
    reason: task.blockedReason ?? "No reason was given.",
    blocking: false,
    taskId: taskScope(task.id),
    dedupeKey: `task-blocked:${task.id}`,
    payload: {
      choices: [
        { value: "retry", label: "I have unblocked it — try again", style: "primary" },
        { value: "cancel", label: "Cancel the task", style: "danger" },
      ],
    },
  }).catch((err) => console.error("[tasks] owner notification failed:", err));
}

function recentHistory(taskId: string): string {
  return taskEvents(taskId).slice(-6).map((e) => `- ${e.text}`).join("\n") || "- (nothing recorded yet)";
}

/* ---------------------------------------------------------------- recovery */

/**
 * A restart kills every running turn. A task that was IN_PROGRESS did not
 * finish, and saying otherwise would be a lie — so it goes back into the
 * queue and is picked up again, in the same execution scope, which is what
 * keeps the side-effect guard protecting whatever it already did.
 */
export function recoverTasks(): { requeued: number } {
  const running = listTasks({ status: ["IN_PROGRESS"] });
  for (const t of running) {
    transition(t.id, ["IN_PROGRESS"], "TODO", { startedAt: null });
    addTaskEvent(t.id, "recovered", "Nexora restarted while this was running — it was put back in the queue and picked up again.", { agentId: t.assignedToAgentId, by: "system" });
  }
  const agents = new Set(listTasks({ status: ["TODO"] }).map((t) => t.assignedToAgentId).filter(Boolean) as string[]);
  setTimeout(() => {
    for (const id of agents) void dispatchAgent(id).catch(() => undefined);
  }, 4_000).unref?.();
  return { requeued: running.length };
}
