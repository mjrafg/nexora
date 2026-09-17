/* Chat list rows: enough to choose a conversation without opening it. */

import { readDb } from "@/lib/store/db";
import { listChats } from "./store";
import type { ChatThread } from "./types";

export type ChatSummary = ChatThread & {
  messageCount: number;
  lastMessageAt: string | null;
  /** first line of the last message, for the list */
  preview: string;
  /** the last turn ended because the owner stopped it */
  lastStopped: boolean;
  /** the last turn failed */
  lastFailed: boolean;
};

export function chatSummaries(agentId: string, opts: { includeArchived?: boolean } = {}): ChatSummary[] {
  const messages = readDb().messages.filter((m) => m.agentId === agentId);
  return listChats(agentId, opts).map((chat) => {
    const mine = messages.filter((m) => m.chatId === chat.id);
    const last = mine.at(-1);
    return {
      ...chat,
      messageCount: mine.length,
      lastMessageAt: last?.createdAt ?? null,
      preview: (last?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
      lastStopped: !!last?.stopped,
      lastFailed: !!last?.error,
    };
  });
}
