export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { chatLog } from "@/lib/chats/logs";
import { getChat } from "@/lib/chats/store";

type Ctx = { params: Promise<{ id: string; chatId: string }> };

/** Every recorded entry of a chat, flattened for the log viewer. */
export async function GET(_req: Request, ctx: Ctx) {
  const { id, chatId } = await ctx.params;
  const chat = getChat(chatId);
  if (!chat || chat.agentId !== id) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  return NextResponse.json({ chat, entries: chatLog(chatId) });
}
