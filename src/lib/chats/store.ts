/* ------------------------------------------------------------------
   Chat thread store. Threads are the unit a conversation lives in:
   messages, the runtime session, the execution scope and the context
   meter all hang off a thread id.
   ------------------------------------------------------------------ */

import { newId, now, readDb, updateDb } from "@/lib/store/db";
import type { ChatMessage, Conversation } from "@/lib/runtime/types";
import type { ChatThread } from "./types";

export const DEFAULT_TITLE = "New chat";

export function listChats(agentId: string, opts: { includeArchived?: boolean } = {}): ChatThread[] {
  return readDb()
    .chats.filter((c) => c.agentId === agentId && (opts.includeArchived || !c.archivedAt))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getChat(chatId: string): ChatThread | undefined {
  return readDb().chats.find((c) => c.id === chatId);
}

export function createChat(agentId: string, title?: string): ChatThread {
  const ts = now();
  const chat: ChatThread = {
    id: newId(),
    agentId,
    title: title?.trim() || DEFAULT_TITLE,
    autoTitle: !title?.trim(),
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
  };
  updateDb((d) => { d.chats.push(chat); });
  return chat;
}

/** The thread a message belongs in when the caller did not name one. */
export function ensureChat(agentId: string): ChatThread {
  return listChats(agentId)[0] ?? createChat(agentId);
}

/**
 * Which thread a send belongs to.
 *   explicit chatId  → that thread
 *   a resume (scope) → the thread that owns that execution scope
 *   otherwise        → the agent's most recent thread
 */
export function chatForSend(agentId: string, opts: { chatId?: string; scopeId?: string }): ChatThread {
  if (opts.chatId) {
    const named = getChat(opts.chatId);
    if (named && named.agentId === agentId) return named;
  }
  if (opts.scopeId) {
    const conv = readDb().conversations.find((c) => c.agentId === agentId && c.executionScopeId === opts.scopeId);
    const owner = conv?.chatId ? getChat(conv.chatId) : undefined;
    if (owner) return owner;
  }
  return ensureChat(agentId);
}

export function renameChat(chatId: string, title: string): ChatThread | undefined {
  return updateDb((d) => {
    const c = d.chats.find((x) => x.id === chatId);
    if (!c) return undefined;
    c.title = title.trim().slice(0, 120) || DEFAULT_TITLE;
    c.autoTitle = false;
    c.updatedAt = now();
    return c;
  });
}

export function setArchived(chatId: string, archived: boolean): ChatThread | undefined {
  return updateDb((d) => {
    const c = d.chats.find((x) => x.id === chatId);
    if (!c) return undefined;
    c.archivedAt = archived ? now() : null;
    c.updatedAt = now();
    return c;
  });
}

/** A thread's own transcript, oldest first. */
export function chatMessages(chatId: string): ChatMessage[] {
  return readDb().messages.filter((m) => m.chatId === chatId);
}

export function conversationFor(chatId: string): Conversation | undefined {
  return readDb().conversations.find((c) => c.chatId === chatId);
}

/** Title a thread from its first owner message, until the owner names it. */
export function autoTitle(chatId: string, firstMessage: string): void {
  updateDb((d) => {
    const c = d.chats.find((x) => x.id === chatId);
    if (!c || !c.autoTitle) return;
    const already = d.messages.filter((m) => m.chatId === chatId && m.role === "user");
    if (already.length > 1) return; // only the first owner message names the thread
    const line = firstMessage.replace(/\s+/g, " ").trim();
    if (!line) return;
    c.title = line.length > 62 ? `${line.slice(0, 60)}…` : line;
    c.updatedAt = now();
  });
}

export function touchChat(chatId: string): void {
  updateDb((d) => {
    const c = d.chats.find((x) => x.id === chatId);
    if (c) c.updatedAt = now();
  });
}

/** Remove a thread and everything that belongs to it. */
export function deleteChat(chatId: string): boolean {
  return updateDb((d) => {
    const i = d.chats.findIndex((c) => c.id === chatId);
    if (i < 0) return false;
    d.chats.splice(i, 1);
    d.messages = d.messages.filter((m) => m.chatId !== chatId);
    d.conversations = d.conversations.filter((c) => c.chatId !== chatId);
    d.chatCompactions = d.chatCompactions.filter((c) => c.chatId !== chatId);
    return true;
  });
}

/** Everything an agent owns, when the agent itself is removed. */
export function deleteAgentChats(agentId: string): void {
  updateDb((d) => {
    d.chats = d.chats.filter((c) => c.agentId !== agentId);
    d.chatCompactions = d.chatCompactions.filter((c) => c.agentId !== agentId);
  });
}
