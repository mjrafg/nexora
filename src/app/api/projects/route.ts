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

/**
 * A readable name taken from the goal, for a project the owner did not name.
 *
 * It is provisional on purpose: the Director renames the project when it
 * submits its plan, by which point it knows what the work actually is. This
 * only has to be good enough to recognise in a list for the first minute.
 */
function provisionalTitle(goal: string): string {
  const firstLine = goal.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  // people open a request with a run of politeness; strip all of it, not one
  const asked = sentence.replace(/^((please|could you|can you|i want to|i'd like to|i would like to|we need to|help me)\s+)+/i, "");
  const all = asked.split(/\s+/).filter(Boolean);
  const words = all.slice(0, 8);
  const joining = /^(a|an|the|with|and|or|for|to|of|in|on|that|which)$/i;
  // A cut sentence trails off: "…for invoices with line". When the tail holds a
  // joining word, end the title before it rather than mid-phrase.
  if (all.length > words.length) {
    const cut = words.slice(-2).findIndex((w) => joining.test(w));
    if (cut >= 0) words.length = Math.max(3, words.length - 2 + cut);
  }
  while (words.length > 3 && joining.test(words[words.length - 1])) words.pop();
  const short = words.join(" ").replace(/[.,;:]+$/, "");
  if (!short) return "Untitled project";
  return (short.length > 60 ? `${short.slice(0, 57)}…` : short).replace(/^./, (ch) => ch.toUpperCase());
}

export async function POST(req: Request) {
  try {
    const body = await readJson<{ title?: string; rootPath?: string; goal?: string; directorAgentId?: string; builderAgentId?: string; reviewerAgentId?: string; createDir?: boolean }>(req);
    const title = str(body.title, 80)?.trim() || provisionalTitle(str(body.goal, 20_000) ?? "");
    const rootPath = str(body.rootPath, 500)?.trim();
    const goal = str(body.goal, 20_000)?.trim();
    if (!title) throw new RuntimeError("Describe the project goal — the title is taken from it when you do not give one.");
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
