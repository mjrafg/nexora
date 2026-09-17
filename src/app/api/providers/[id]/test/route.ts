import { NextResponse } from "next/server";
import { readDb } from "@/lib/store/db";
import { testRuntimeConfig } from "@/lib/runtime";
import { PROVIDERS } from "@/lib/runtime/catalog";
import { readJson, str } from "@/lib/api-helpers";

type Ctx = { params: Promise<{ id: string }> };

/** Test a connection through the direct API runtime with a probe model. */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const conn = readDb().providerConnections.find((c) => c.id === id);
  if (!conn) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  const body = await readJson<{ model?: string }>(req).catch(() => ({}) as { model?: string });
  const meta = PROVIDERS[conn.providerType];
  const model = str(body.model, 200)?.trim() || meta.models[0]?.id;
  if (!model) return NextResponse.json({ ok: false, message: "A model id is required to test this connection", durationMs: 0 });
  const runtimeType = meta.runtimes.includes("api") ? "api" : meta.runtimes[0];
  return NextResponse.json(await testRuntimeConfig({ runtimeType, providerConnectionId: id, model }));
}
