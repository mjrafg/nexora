export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { buildSystemPrompt } from "@/lib/runtime";
import { readDb } from "@/lib/store/db";
import "@/lib/tools/servers";

type Ctx = { params: Promise<{ id: string }> };

/** The operating instructions this agent actually runs with — owner-visible, and asserted by the autonomy suite. */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const agent = readDb().agents.find((a) => a.id === id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json({ prompt: buildSystemPrompt(agent) });
}
