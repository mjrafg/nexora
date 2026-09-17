export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readDb } from "@/lib/store/db";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";
import { OPEN_STATUSES, addTaskEvent, createTask, listTasks, member, toTaskView } from "@/lib/tasks/store";
import { assignTask } from "@/lib/tasks/service";
import { PRIORITIES, type TaskPriority, type TaskStatus } from "@/lib/tasks/types";
import { assertUsableFolder } from "@/lib/fs-browse";

const STATUSES: TaskStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"];

/** All company work, with the workload of every agent that holds any. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const status = params.get("status");
  const agentId = params.get("agent") ?? undefined;
  const managerAgentId = params.get("manager") ?? undefined;
  const tasks = listTasks({
    agentId,
    managerAgentId,
    status: status === "open" ? OPEN_STATUSES : status && STATUSES.includes(status as TaskStatus) ? [status as TaskStatus] : undefined,
  });
  const db = readDb();
  const holders = new Set(tasks.map((t) => t.assignedToAgentId).filter(Boolean) as string[]);
  return NextResponse.json({
    tasks: tasks.map(toTaskView),
    workload: db.agents.filter((a) => holders.has(a.id)).map((a) => member(a)),
  });
}

/** The owner creates work directly — no manager needed. */
export async function POST(req: Request) {
  try {
    const body = await readJson<{ title?: string; description?: string; priority?: string; assignedToAgentId?: string; workingDirectory?: string }>(req);
    const title = str(body.title, 200)?.trim();
    const description = str(body.description, 8_000)?.trim() ?? "";
    if (!title) throw new RuntimeError("A task needs a title");
    const to = str(body.assignedToAgentId, 80)?.trim() || null;
    if (to && !readDb().agents.some((a) => a.id === to)) throw new RuntimeError("That agent does not exist");
    const priority = (str(body.priority, 20)?.toUpperCase() as TaskPriority) || "NORMAL";
    const folder = str(body.workingDirectory, 1_000)?.trim();
    const task = createTask({
      title,
      description,
      workingDirectory: folder ? assertUsableFolder(folder) : null,
      priority: PRIORITIES.includes(priority) ? priority : "NORMAL",
      assignedToAgentId: to,
      createdByOwner: true,
    });
    addTaskEvent(task.id, "created", "The owner created this task", { by: "owner" });
    if (to) await assignTask(task.id, to, { by: "owner" });
    return NextResponse.json({ task: toTaskView(readDb().tasks.find((t) => t.id === task.id)!) }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
