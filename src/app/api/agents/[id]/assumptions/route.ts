export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { currentAssumptions, listAssumptions } from "@/lib/agents/assumptions";
import { readDb } from "@/lib/store/db";

type Ctx = { params: Promise<{ id: string }> };

/** What the agent decided on the owner's behalf: the current task by default, `?all=1` for the history. */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!readDb().agents.some((a) => a.id === id)) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  const params = new URL(req.url).searchParams;
  const all = params.get("all") === "1";
  const chatId = params.get("chat") ?? undefined;
  return NextResponse.json({ assumptions: all ? listAssumptions(id, { limit: 100 }) : currentAssumptions(id, chatId) });
}
