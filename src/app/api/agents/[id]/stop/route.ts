export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readDb } from "@/lib/store/db";
import { liveTurn, stopTurn } from "@/lib/runtime/stop";

type Ctx = { params: Promise<{ id: string }> };

/** Is a turn running right now, and which thread is it in? */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const turn = liveTurn(id);
  return NextResponse.json({
    running: !!turn,
    chatId: turn?.chatId ?? null,
    startedAt: turn ? new Date(turn.startedAt).toISOString() : null,
    stopped: turn?.stopped ?? false,
  });
}

/** Stop the turn the agent is running. The turn ends as stopped, not failed. */
export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!readDb().agents.some((a) => a.id === id)) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  const result = stopTurn(id);
  return NextResponse.json(result);
}
