export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readDb } from "@/lib/store/db";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { createChat, listChats } from "@/lib/chats/store";
import { chatSummaries } from "@/lib/chats/summary";

type Ctx = { params: Promise<{ id: string }> };

/** Every conversation this owner holds with one agent. */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!readDb().agents.some((a) => a.id === id)) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
  return NextResponse.json({ chats: chatSummaries(id, { includeArchived }) });
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (!readDb().agents.some((a) => a.id === id)) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    const body = await readJson<{ title?: string }>(req).catch(() => ({}) as { title?: string });
    const chat = createChat(id, str(body.title, 120));
    return NextResponse.json({ chat, chats: listChats(id) });
  } catch (err) {
    return jsonError(err);
  }
}
