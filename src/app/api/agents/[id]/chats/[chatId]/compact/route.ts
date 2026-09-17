export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { compactChat } from "@/lib/chats/compact";
import { computeChatUsage } from "@/lib/chats/context";
import { getChat } from "@/lib/chats/store";

type Ctx = { params: Promise<{ id: string; chatId: string }> };

/** The provider compacts its own session; Nexora only records what it reported. */
export async function POST(_req: Request, ctx: Ctx) {
  const { id, chatId } = await ctx.params;
  const chat = getChat(chatId);
  if (!chat || chat.agentId !== id) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  const outcome = await compactChat(chatId, "manual");
  const usage = computeChatUsage(chatId);
  return NextResponse.json({ outcome, usage }, { status: outcome.ok ? 200 : 422 });
}
