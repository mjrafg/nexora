export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { deleteChat, getChat, renameChat, setArchived } from "@/lib/chats/store";
import { computeChatUsage } from "@/lib/chats/context";
import { chatMessages } from "@/lib/chats/store";
import { readDb } from "@/lib/store/db";

type Ctx = { params: Promise<{ id: string; chatId: string }> };

function owned(agentId: string, chatId: string) {
  const chat = getChat(chatId);
  return chat && chat.agentId === agentId ? chat : null;
}

/** One thread with its transcript, its context meter and its compactions. */
export async function GET(_req: Request, ctx: Ctx) {
  const { id, chatId } = await ctx.params;
  const chat = owned(id, chatId);
  if (!chat) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  return NextResponse.json({
    chat,
    messages: chatMessages(chatId),
    usage: computeChatUsage(chatId),
    compactions: readDb().chatCompactions.filter((c) => c.chatId === chatId),
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id, chatId } = await ctx.params;
    if (!owned(id, chatId)) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    const body = await readJson<{ title?: string; archived?: boolean }>(req);
    let chat = getChat(chatId);
    if (body.title !== undefined) chat = renameChat(chatId, str(body.title, 120) ?? "");
    if (body.archived !== undefined) chat = setArchived(chatId, !!body.archived);
    return NextResponse.json({ chat });
  } catch (err) {
    return jsonError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id, chatId } = await ctx.params;
  if (!owned(id, chatId)) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  return NextResponse.json({ ok: deleteChat(chatId) });
}
