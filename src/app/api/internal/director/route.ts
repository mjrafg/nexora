export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { handleDirectorTool, internalToken } from "@/lib/projects/director";

/** Token-authenticated callback used by the Director's stdio MCP server. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { token?: string; projectId?: string; op?: string; args?: Record<string, unknown> };
  if (body.token !== internalToken()) return NextResponse.json({ ok: false, error: "Bad internal token." }, { status: 403 });
  if (!body.projectId || !body.op) return NextResponse.json({ ok: false, error: "projectId and op are required." }, { status: 400 });
  const r = await handleDirectorTool(body.projectId, body.op, body.args ?? {});
  return NextResponse.json(r, { status: r.ok ? 200 : 200 });
}
