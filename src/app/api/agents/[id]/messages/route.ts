export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readDb } from "@/lib/store/db";
import { sendAgentMessage } from "@/lib/runtime";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";
import { chatMessages, ensureChat, getChat } from "@/lib/chats/store";
import { computeChatUsage } from "@/lib/chats/context";

type Ctx = { params: Promise<{ id: string }> };

/** A thread's transcript. Without `?chat=` the agent's most recent thread is used. */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const db = readDb();
  if (!db.agents.some((a) => a.id === id)) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  const asked = new URL(req.url).searchParams.get("chat");
  const chat = asked ? getChat(asked) : ensureChat(id);
  if (!chat || chat.agentId !== id) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  return NextResponse.json({ chat, messages: chatMessages(chat.id), usage: computeChatUsage(chat.id) });
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await readJson<{ message?: string; chatId?: string }>(req);
    const message = str(body.message, 50_000)?.trim();
    if (!message) throw new RuntimeError("Message is required");
    const chatId = str(body.chatId, 80);
    if (chatId) {
      const chat = getChat(chatId);
      if (!chat || chat.agentId !== id) throw new RuntimeError("Chat not found", chatId);
    }
    const result = await sendAgentMessage(id, message, chatId ? { chatId } : {});
    return NextResponse.json({ ...result, usage: computeChatUsage(result.assistant.chatId) });
  } catch (err) {
    return jsonError(err, err instanceof RuntimeError && err.message === "Agent not found" ? 404 : 400);
  }
}
