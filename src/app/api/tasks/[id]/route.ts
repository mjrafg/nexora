export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readDb } from "@/lib/store/db";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";
import { getTask, taskEvents, toTaskView } from "@/lib/tasks/store";
import { assignTask, cancelTask, dispatchAgent, startTask, updateTask } from "@/lib/tasks/service";
import { PRIORITIES, type TaskPriority } from "@/lib/tasks/types";
import { assertUsableFolder } from "@/lib/fs-browse";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  return NextResponse.json({ task: toTaskView(task), history: taskEvents(id) });
}

/** The owner's own controls: priority, instructions, who holds it, cancel, retry. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (!getTask(id)) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    const body = await readJson<{ title?: string; description?: string; priority?: string; assignedToAgentId?: string; workingDirectory?: string | null; cancel?: { reason?: string }; retry?: boolean }>(req);

    if (body.cancel) {
      const cancelled = await cancelTask(id, str(body.cancel.reason, 300) ?? "", { by: "owner" });
      return NextResponse.json({ task: cancelled ? toTaskView(cancelled) : null });
    }
    if (body.title !== undefined || body.description !== undefined || body.priority !== undefined) {
      const priority = str(body.priority, 20)?.toUpperCase() as TaskPriority | undefined;
      if (priority && !PRIORITIES.includes(priority)) throw new RuntimeError("Unknown priority");
      updateTask(id, { title: str(body.title, 200) || undefined, description: str(body.description, 8_000) ?? undefined, priority }, { by: "owner" });
    }
    if (body.workingDirectory !== undefined) {
      const raw = str(body.workingDirectory ?? "", 1_000)?.trim();
      const { patchTask, addTaskEvent } = await import("@/lib/tasks/store");
      const dir = raw ? assertUsableFolder(raw) : null;
      patchTask(id, { workingDirectory: dir });
      addTaskEvent(id, "updated", dir ? `The owner set the working folder to ${dir}` : "The owner cleared the working folder — the agent works in its own workspace", { by: "owner" });
    }
    if (body.assignedToAgentId !== undefined) {
      const to = str(body.assignedToAgentId, 80)?.trim();
      if (!to) throw new RuntimeError("Choose an agent to hold this task");
      if (!readDb().agents.some((a) => a.id === to)) throw new RuntimeError("That agent does not exist");
      await assignTask(id, to, { by: "owner" });
    }
    if (body.retry) {
      const task = getTask(id)!;
      if (!task.assignedToAgentId) throw new RuntimeError("Assign this task before restarting it");
      if (task.status === "BLOCKED") {
        const { patchTask, addTaskEvent } = await import("@/lib/tasks/store");
        patchTask(id, { status: "TODO", blockedReason: null });
        addTaskEvent(id, "unblocked", "The owner released the blocker and sent it back", { by: "owner" });
      }
      await (getTask(id)!.status === "TODO" ? startTask(id) : dispatchAgent(task.assignedToAgentId));
    }
    return NextResponse.json({ task: toTaskView(getTask(id)!), history: taskEvents(id) });
  } catch (err) {
    return jsonError(err);
  }
}
