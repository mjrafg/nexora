export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getProject, toProjectView } from "@/lib/projects/store";
import { pauseProject } from "@/lib/projects/director";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!getProject(id)) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  pauseProject(id);
  return NextResponse.json({ project: toProjectView(getProject(id)!) });
}
