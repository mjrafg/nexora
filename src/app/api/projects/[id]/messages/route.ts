export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getProject, listMessages } from "@/lib/projects/store";
import { directorUserMessage } from "@/lib/projects/director";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getProject(id)) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  return NextResponse.json({ messages: listMessages(id) });
}

/** Post to the Project Chat: the Director takes a turn asynchronously; watch the activity stream. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (!getProject(id)) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const body = await readJson<{ message?: string }>(req);
    const message = str(body.message, 20_000)?.trim();
    if (!message) throw new RuntimeError("Message is required");
    directorUserMessage(id, message);
    return NextResponse.json({ ok: true, queued: true });
  } catch (err) {
    return jsonError(err);
  }
}
