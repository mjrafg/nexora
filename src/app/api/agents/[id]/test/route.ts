import { NextResponse } from "next/server";
import { readDb } from "@/lib/store/db";
import { testRuntimeConfig } from "@/lib/runtime";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const db = readDb();
  const agent = db.agents.find((a) => a.id === id);
  const rc = agent && db.runtimeConfigs.find((r) => r.id === agent.runtimeConfigId);
  if (!agent || !rc) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json(await testRuntimeConfig(rc));
}
