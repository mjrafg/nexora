export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { deleteProject, getProject, listActivity, listMessages, toProjectView } from "@/lib/projects/store";
import { stopAllSessions } from "@/lib/projects/session";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const p = getProject(id);
  if (!p) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  return NextResponse.json({ project: toProjectView(p), activity: listActivity(id, 300), messages: listMessages(id) });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getProject(id)) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  stopAllSessions(id);
  deleteProject(id);
  return NextResponse.json({ ok: true });
}
