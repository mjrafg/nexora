export const dynamic = "force-dynamic";

import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { listProjects, toProjectView } from "@/lib/projects/store";
import { createProjectRun } from "@/lib/projects/director";
import { agentRuntimeType } from "@/lib/runtime";
import { readDb } from "@/lib/store/db";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";

export async function GET() {
  return NextResponse.json({ projects: listProjects().map(toProjectView) });
}

export async function POST(req: Request) {
  try {
    const body = await readJson<{ title?: string; rootPath?: string; goal?: string; directorAgentId?: string; builderAgentId?: string; reviewerAgentId?: string; createDir?: boolean }>(req);
    const title = str(body.title, 80)?.trim();
    const rootPath = str(body.rootPath, 500)?.trim();
    const goal = str(body.goal, 20_000)?.trim();
    if (!title) throw new RuntimeError("Title is required.");
    if (!rootPath || !path.isAbsolute(rootPath)) throw new RuntimeError("Repository directory must be an absolute path on this server.");
    if (!goal) throw new RuntimeError("Describe the project goal.");
    if (!fs.existsSync(rootPath)) {
      if (!body.createDir) throw new RuntimeError("Directory does not exist. Tick “create it” to have it created.");
      fs.mkdirSync(rootPath, { recursive: true });
    } else if (!fs.statSync(rootPath).isDirectory()) throw new RuntimeError("Path is not a directory.");
    const agents = readDb().agents;
    const need = (id: string | undefined, what: string) => {
      if (!id || !agents.some((a) => a.id === id)) throw new RuntimeError(`${what} agent is required.`);
      return id;
    };
    const directorAgentId = need(body.directorAgentId, "Director");
    const builderAgentId = need(body.builderAgentId, "Builder");
    const reviewerAgentId = need(body.reviewerAgentId, "Reviewer");
    if (agentRuntimeType(builderAgentId) === "api") throw new RuntimeError("The Builder agent must run on Claude Code or Codex.");
    const project = createProjectRun({ title, rootPath, goal, directorAgentId, builderAgentId, reviewerAgentId });
    return NextResponse.json({ project: toProjectView(project) }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
