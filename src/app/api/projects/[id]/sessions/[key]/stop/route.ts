export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getProject, getSession, toProjectView } from "@/lib/projects/store";
import { stopSession } from "@/lib/projects/session";

/**
 * Stop one running session, leaving the rest of the project alone.
 *
 * The work on its branch and worktree stays where it is; the session is
 * recorded as stopped rather than failed, and the Director is told it may be
 * resumed. Pausing the whole project remains the way to stop everything.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string; key: string }> }) {
  const { id, key } = await ctx.params;
  if (!getProject(id)) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const session = getSession(id, decodeURIComponent(key));
  if (!session) return NextResponse.json({ error: `Unknown session: ${key}` }, { status: 404 });
  if (session.status !== "running") return NextResponse.json({ error: `${session.key} is ${session.status}, not running.` }, { status: 409 });
  if (!stopSession(session.id)) return NextResponse.json({ error: `${session.key} has nothing running to stop.` }, { status: 409 });
  return NextResponse.json({ ok: true, project: toProjectView(getProject(id)!) });
}
