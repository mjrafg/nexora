/* ------------------------------------------------------------------
   The work tools.

   Employees get a small set for their own tasks. Agents with direct
   reports additionally get the management set — seeing the team, creating
   work, moving it, and changing it. A manager may only touch its own
   reports' work; the owner, acting through the UI, may touch anything.
   ------------------------------------------------------------------ */

import { readDb } from "@/lib/store/db";
import { registerToolServer, type InternalToolDef, type InternalToolServer, type ToolCallContext } from "@/lib/tools/internal";
import type { TaskPriority, TaskRecord } from "./types";
import { PRIORITIES } from "./types";
import {
  OPEN_STATUSES, addTaskEvent, blockingChildren, canParent, childTasks, createTask, directReports, getTask, isManager, listTasks, managerOf, taskEvents, teamOf, toTaskView,
} from "./store";
import { assignTask, blockTask, cancelTask, completeTask, dispatchAgent, updateTask } from "./service";
import { assertUsableFolder } from "@/lib/fs-browse";

const s = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const ok = (text: string) => ({ ok: true, text });
const fail = (text: string) => ({ ok: false, text });
const priority = (v: unknown): TaskPriority | undefined => {
  const up = s(v, 20).toUpperCase() as TaskPriority;
  return PRIORITIES.includes(up) ? up : undefined;
};

/** A task an agent may act on: its own work, or its report's work. */
function reachable(agentId: string, task: TaskRecord | undefined, mode: "own" | "manage"): string | null {
  if (!task) return "No task with that id.";
  if (mode === "own") return task.assignedToAgentId === agentId ? null : "That task is not assigned to you.";
  if (task.assignedToAgentId === agentId) return null;
  const reports = directReports(agentId).map((a) => a.id);
  if (task.assignedToAgentId && reports.includes(task.assignedToAgentId)) return null;
  if (task.createdByAgentId === agentId || task.managerAgentId === agentId) return null;
  return "That task belongs to someone outside your team.";
}

/** The task this agent is working in right now, read from its execution scope. */
function currentTask(ctx: ToolCallContext, agentId: string): TaskRecord | undefined {
  const scope = ctx.scopeId ?? "";
  if (!scope.startsWith("task:") || scope.endsWith(":manager")) return undefined;
  const t = getTask(scope.slice("task:".length));
  return t && t.assignedToAgentId === agentId && OPEN_STATUSES.includes(t.status) ? t : undefined;
}

function brief(t: TaskRecord) {
  const v = toTaskView(t);
  const kids = childTasks(t.id);
  return {
    task_id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    ...(t.parentTaskId ? { part_of_task: t.parentTaskId } : {}),
    ...(kids.length ? { delegated: kids.map((k) => ({ task_id: k.id, title: k.title, status: k.status, assigned_to: toTaskView(k).assignedTo?.name ?? null })) } : {}),
    ...(v.waitingForTeam ? { waiting_for: "delegated work to come back" } : {}),
    assigned_to: v.assignedTo ? { agent_id: v.assignedTo.id, name: v.assignedTo.name, role: v.assignedTo.role } : null,
    created_by: v.createdBy?.name ?? null,
    working_directory: t.workingDirectory ?? undefined,
    blocked_reason: t.blockedReason ?? undefined,
    result_summary: t.resultSummary ?? undefined,
    created_at: t.createdAt,
  };
}

/* ---------------------------------------------------------------- definitions */

const EMPLOYEE_TOOLS: InternalToolDef[] = [
  {
    name: "list_my_tasks",
    description: "The company work assigned to you, most urgent first. Use it when you are asked what you are working on, or to pick up where you left off.",
    inputSchema: { type: "object", properties: { status: { type: "string", description: "TODO | IN_PROGRESS | BLOCKED | DONE | CANCELLED — omit for everything still open" } } },
  },
  {
    name: "get_task",
    description: "Everything recorded about one task: what was asked, its history, who is accountable, and the result if it is finished.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
  },
  {
    name: "start_task",
    description: "Mark a task you are picking up as in progress. Nexora normally does this for you when the task is assigned; use it only when you start something yourself.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
    sideEffect: "SIDE_EFFECT",
  },
  {
    name: "add_task_note",
    description: "Record one short, useful fact on the task — something a person reading it later would need. Not a running commentary: your steps are already logged.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, note: { type: "string" } }, required: ["task_id", "note"] },
    sideEffect: "SIDE_EFFECT",
  },
  {
    name: "complete_task",
    description: "Finish a task. The summary must say what you actually achieved and how you verified it — never just 'done'. Put figures, links, file names or ticket ids in `result`. Do not complete work you only attempted.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        summary: { type: "string", description: "What was achieved and how it was verified, in plain language." },
        result: { type: "object", description: "Optional structured detail: counts, links, files, ids." },
      },
      required: ["task_id", "summary"],
    },
    sideEffect: "SIDE_EFFECT",
  },
  {
    name: "block_task",
    description: "Stop a task that genuinely cannot continue, with a precise reason. Before you use this: a missing tool or account is a request_capability; a missing login is a credential request; missing company information is a company request; money is the payment system. Block only when a human outside Nexora must act.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, reason: { type: "string", description: "Exactly what stops you, and what you already tried." } }, required: ["task_id", "reason"] },
    sideEffect: "SIDE_EFFECT",
  },
];

const MANAGER_TOOLS: InternalToolDef[] = [
  {
    name: "list_team",
    description: "Your direct reports: their role, their skills, the access they already hold, what they are doing right now and how much work they carry. Read this before deciding who should take a piece of work — and before concluding that Nexora is missing something, because a report often already has it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_team_tasks",
    description: "The work your team holds, most urgent first — what is queued, running, blocked or finished.",
    inputSchema: { type: "object", properties: { status: { type: "string", description: "TODO | IN_PROGRESS | BLOCKED | DONE | CANCELLED — omit for everything still open" }, agent_id: { type: "string", description: "One report only" } } },
  },
  {
    name: "create_task",
    description: "Create a real piece of company work and give it to whoever is best placed to do it. They are woken automatically — nobody has to tell them to start. Leave assigned_to out only if you intend to decide after looking at the team.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "One line, the outcome wanted." },
        description: { type: "string", description: "What is wanted and why, with the context they need to succeed. Do not dictate implementation." },
        assigned_to: { type: "string", description: "agent_id of the report who should do it." },
        priority: { type: "string", description: "LOW | NORMAL | HIGH | CRITICAL (default NORMAL)" },
        working_directory: { type: "string", description: "Absolute path to the folder this work happens in, when it has one (a repository or project directory). The agent is started inside it. It must already exist." },
        parent_task_id: { type: "string", description: "The objective this is a piece of. Leave it out while you are working a task — Nexora attaches it to the task you are in." },
      },
      required: ["title", "description"],
    },
    sideEffect: "SIDE_EFFECT",
  },
  {
    name: "assign_task",
    description: "Give an unassigned task to one of your reports. They start automatically.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, assigned_to: { type: "string" }, reason: { type: "string" } }, required: ["task_id", "assigned_to"] },
    sideEffect: "SIDE_EFFECT",
  },
  {
    name: "reassign_task",
    description: "Move a task to someone else. The previous holder stops, the new one picks it up with the full history, and nothing recorded is lost.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, assigned_to: { type: "string" }, reason: { type: "string", description: "Why it is moving — it is recorded." } }, required: ["task_id", "assigned_to"] },
    sideEffect: "SIDE_EFFECT",
  },
  {
    name: "update_task",
    description: "Change what a task asks for or how urgent it is — for example after a blocker, to give a new instruction. You can also attach it to the larger objective it turned out to be part of.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, title: { type: "string" }, description: { type: "string" }, priority: { type: "string" }, working_directory: { type: "string", description: "Absolute path to the folder this work happens in. It must already exist." }, parent_task_id: { type: "string", description: "The objective this is a piece of. Pass an empty string to detach it." } }, required: ["task_id"] },
    sideEffect: "SIDE_EFFECT",
  },
  {
    name: "cancel_task",
    description: "Stop a task for good. Anyone running it stops; it never restarts.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, reason: { type: "string" } }, required: ["task_id", "reason"] },
    sideEffect: "SIDE_EFFECT",
  },
];

/* ---------------------------------------------------------------- execution */

export const tasksToolServer: InternalToolServer = registerToolServer({
  slug: "work",
  name: "Work",
  tools: [...EMPLOYEE_TOOLS, ...MANAGER_TOOLS],
  toolsFor: (agent) => (isManager(agent.id) ? [...EMPLOYEE_TOOLS, ...MANAGER_TOOLS] : EMPLOYEE_TOOLS),

  async call(tool: string, args: Record<string, unknown>, ctx: ToolCallContext) {
    const me = ctx.agentId;
    switch (tool) {
      /* ---- employee ---- */
      case "list_my_tasks": {
        const status = s(args.status, 20).toUpperCase();
        const rows = listTasks({ agentId: me, status: status ? [status as TaskRecord["status"]] : OPEN_STATUSES });
        return ok(JSON.stringify({ tasks: rows.map(brief) }, null, 1));
      }
      case "get_task": {
        const task = getTask(s(args.task_id, 80));
        const denied = reachable(me, task, isManager(me) ? "manage" : "own");
        if (denied) return fail(denied);
        return ok(JSON.stringify({ ...brief(task!), description: task!.description, history: taskEvents(task!.id).map((e) => `${e.at} — ${e.text}`) }, null, 1));
      }
      case "start_task": {
        const task = getTask(s(args.task_id, 80));
        const denied = reachable(me, task, "own");
        if (denied) return fail(denied);
        if (task!.status === "IN_PROGRESS") return ok("Already in progress — carry on.");
        const { startTask } = await import("./service");
        const started = await startTask(task!.id);
        return started ? ok(`Started "${started.title}".`) : fail(`That task is ${task!.status} and cannot be started.`);
      }
      case "add_task_note": {
        const task = getTask(s(args.task_id, 80));
        const denied = reachable(me, task, isManager(me) ? "manage" : "own");
        if (denied) return fail(denied);
        const note = s(args.note, 600);
        if (!note) return fail("A note needs text.");
        addTaskEvent(task!.id, "note", note, { agentId: me, by: "agent" });
        return ok("Noted on the task.");
      }
      case "complete_task": {
        const task = getTask(s(args.task_id, 80));
        const denied = reachable(me, task, "own");
        if (denied) return fail(denied);
        const summary = s(args.summary, 4_000);
        if (summary.length < 15) return fail("The summary must say what you achieved and how you verified it — a word or two is not a result.");
        const done = await completeTask(task!.id, me, summary, (args.result as Record<string, unknown>) ?? undefined);
        if (!done) return fail(refusal(task!.id, me, "completed"));
        const mgr = toTaskView(done).manager;
        return ok(`Completed "${done.title}".${mgr ? ` ${mgr.name} has been told.` : ""}`);
      }
      case "block_task": {
        const task = getTask(s(args.task_id, 80));
        const denied = reachable(me, task, "own");
        if (denied) return fail(denied);
        const reason = s(args.reason, 1_000);
        if (reason.length < 15) return fail("Say precisely what stops you and what you already tried — a vague blocker cannot be acted on.");
        const blocked = await blockTask(task!.id, me, reason);
        if (!blocked) return fail(refusal(task!.id, me, "blocked"));
        const mgr = toTaskView(blocked).manager;
        return ok(`Blocked "${blocked.title}".${mgr ? ` ${mgr.name} has been told and will decide what happens next.` : " The owner has been told."}`);
      }

      /* ---- manager ---- */
      case "list_team": {
        const team = teamOf(me);
        if (!team.length) return ok(JSON.stringify({ team: [], note: "You have no direct reports. Do this work yourself, or ask the owner to assign you a team." }, null, 1));
        return ok(JSON.stringify({ team: team.map((m) => ({
          agent_id: m.agentId, name: m.name, role: m.role, status: m.status,
          active_tasks: m.activeTasks, pending_tasks: m.pendingTasks, blocked_tasks: m.blockedTasks,
          ...(m.skills.length ? { skills: m.skills } : {}),
          access: m.tools.length ? m.tools : ["no special access"],
          ...(m.currentTask ? { current_task: m.currentTask } : {}),
          ...(m.waitingFor ? { waiting_for: m.waitingFor } : {}),
        })) }, null, 1));
      }
      case "list_team_tasks": {
        const status = s(args.status, 20).toUpperCase();
        const only = s(args.agent_id, 80);
        const reports = directReports(me).map((a) => a.id);
        const rows = listTasks({ status: status ? [status as TaskRecord["status"]] : OPEN_STATUSES })
          .filter((t) => (only ? t.assignedToAgentId === only : true))
          .filter((t) => (t.assignedToAgentId && reports.includes(t.assignedToAgentId)) || t.managerAgentId === me || t.createdByAgentId === me || t.assignedToAgentId === me);
        return ok(JSON.stringify({ tasks: rows.map(brief) }, null, 1));
      }
      case "create_task": {
        const title = s(args.title, 200);
        const description = s(args.description, 8_000);
        if (!title || !description) return fail("A task needs a title and a description of the outcome wanted.");
        const to = s(args.assigned_to, 80);
        if (to && !canDirect(me, to)) return fail("You can only give work to your own direct reports (or yourself).");
        const folder = s(args.working_directory, 1_000);
        let workingDirectory: string | null = null;
        if (folder) {
          try { workingDirectory = assertUsableFolder(folder); }
          catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
        }
        // work delegated while carrying out a task belongs to that task —
        // nobody has to say so, and the objective stays followable end to end
        const holding = currentTask(ctx, me);
        const asked = s(args.parent_task_id, 80);
        const parentTaskId = asked || holding?.id || null;
        if (parentTaskId) {
          const all = readDb().tasks;
          if (!all.some((t) => t.id === parentTaskId)) return fail("No task with that parent_task_id.");
          if (asked && !holding && reachable(me, getTask(asked), "manage")) return fail("That is not work you are accountable for, so nothing can be hung under it.");
        }
        const task = createTask({
          title, description, priority: priority(args.priority), workingDirectory, parentTaskId,
          assignedToAgentId: to || null, managerAgentId: me, createdByAgentId: me, createdByOwner: false,
          // the conversation this delegation came out of: the outcome is
          // reported back there, so whoever asked is told without asking
          originChatId: ctx.chatId ?? null,
        });

        const creator = readDb().agents.find((a) => a.id === me)?.name ?? "A manager";
        addTaskEvent(task.id, "created", `${creator} created this task`, { agentId: me, by: "agent" });
        const partOf = parentTaskId ? { part_of_task: parentTaskId } : {};
        const waiting = holding
          ? { your_task: `You are still accountable for “${holding.title}”. Do not complete it until this comes back — you are woken with the result. End your turn now.` }
          : {};
        if (to) {
          await assignTask(task.id, to, { by: "agent", byAgentId: me });
          const name = readDb().agents.find((a) => a.id === to)?.name ?? to;
          return ok(JSON.stringify({ task_id: task.id, status: "TODO", assigned_to: name, ...partOf, note: `${name} has been woken and starts on it now.`, ...waiting }, null, 1));
        }
        return ok(JSON.stringify({ task_id: task.id, status: "TODO", assigned_to: null, ...partOf, note: "Nobody holds this yet — call assign_task once you have chosen.", ...waiting }, null, 1));
      }
      case "assign_task":
      case "reassign_task": {
        const task = getTask(s(args.task_id, 80));
        const denied = reachable(me, task, "manage");
        if (denied) return fail(denied);
        const to = s(args.assigned_to, 80);
        if (!canDirect(me, to)) return fail("You can only give work to your own direct reports (or yourself).");
        const updated = await assignTask(task!.id, to, { by: "agent", byAgentId: me, reason: s(args.reason, 300) });
        const name = readDb().agents.find((a) => a.id === to)?.name ?? to;
        return updated ? ok(`"${updated.title}" is now ${name}'s, and they have started.`) : fail("That task could not be assigned.");
      }
      case "update_task": {
        const task = getTask(s(args.task_id, 80));
        const denied = reachable(me, task, "manage");
        if (denied) return fail(denied);
        const dir = s(args.working_directory, 1_000);
        if (dir) {
          try {
            const { patchTask } = await import("./store");
            patchTask(task!.id, { workingDirectory: assertUsableFolder(dir) });
          } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
        }
        if (args.parent_task_id !== undefined) {
          const into = s(args.parent_task_id, 80);
          if (into) {
            const bad = canParent(task!.id, into);
            if (bad) return fail(bad);
            const denied = reachable(me, getTask(into), "manage");
            if (denied) return fail("That objective belongs to someone outside your team.");
          }
          const { patchTask } = await import("./store");
          patchTask(task!.id, { parentTaskId: into || null });
          addTaskEvent(task!.id, "updated", into ? `Attached to the objective ${into}` : "Detached from its parent objective", { agentId: me, by: "agent" });
        }
        const updated = updateTask(task!.id, { title: s(args.title, 200) || undefined, description: s(args.description, 8_000) || undefined, priority: priority(args.priority) }, { by: "agent", byAgentId: me });
        return updated ? ok(`Updated "${updated.title}" — priority ${updated.priority}, status ${updated.status}.`) : fail("That task could not be updated.");
      }
      case "cancel_task": {
        const task = getTask(s(args.task_id, 80));
        const denied = reachable(me, task, "manage");
        if (denied) return fail(denied);
        const cancelled = await cancelTask(task!.id, s(args.reason, 300), { by: "agent", byAgentId: me });
        return cancelled ? ok(`Cancelled "${cancelled.title}". Nobody will pick it up again.`) : fail("That task could not be cancelled.");
      }
      default:
        return fail(`Unknown work tool: ${tool}`);
    }
  },
});

/** Why an outcome was refused, read from the task as it stands now. */
function refusal(taskId: string, agentId: string, verb: string): string {
  const fresh = getTask(taskId);
  if (!fresh) return "That task no longer exists.";
  if (fresh.assignedToAgentId !== agentId) return `That task is no longer yours — it moved to someone else while you were working on it. Nothing was recorded; stop here.`;
  const open = blockingChildren(taskId);
  if (verb === "completed" && open.length) {
    return `Not yet: ${open.length} piece${open.length === 1 ? "" : "s"} of work you delegated out of this ${open.length === 1 ? "is" : "are"} still open — ${open.map((c) => `“${c.title}” (${c.status}, ${toTaskView(c).assignedTo?.name ?? "unassigned"})`).join("; ")}. Delegating is not delivering. End your turn; you are woken as each piece comes back. If a piece is genuinely no longer needed, cancel_task it with the reason, then finish — and say in your summary what will not be delivered.`;
  }
  return `That task is ${fresh.status} and cannot be ${verb}.`;
}

/** A manager may hand work to its own reports, or keep it. */
function canDirect(managerId: string, targetId: string): boolean {
  if (!targetId) return false;
  if (targetId === managerId) return true;
  return directReports(managerId).some((a) => a.id === targetId);
}

/** Wake an agent for queued work when nothing else is running — used after the owner assigns. */
export { dispatchAgent, managerOf };
