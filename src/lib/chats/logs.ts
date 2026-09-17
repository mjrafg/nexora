/* ------------------------------------------------------------------
   The flat log of a chat.

   Everything Nexora recorded for a thread, in the order it happened and at
   full recorded detail: owner and agent messages, every step an agent took
   (tool calls, commands, file work, browser actions with their URLs),
   guard verdicts, tool input and output, usage, errors, stops and
   compactions. This is the same material the exports render — one shape,
   so what you read on screen is what you download.
   ------------------------------------------------------------------ */

import { readDb } from "@/lib/store/db";
import type { GuardInfo } from "@/lib/guard";
import { chatMessages } from "./store";

export type LogEntryKind = "message" | "step" | "tool" | "compaction";

/**
 * What the entry IS, independent of how it was recorded. A CLI runtime logs a
 * tool call as an activity step while the API runtime logs a tool record; both
 * are a tool call, and the log has to let you filter for one thing and get
 * every one of them.
 */
export type LogEntryGroup = "message" | "tool" | "browser" | "command" | "file" | "model" | "status" | "compaction";

export type ChatLogEntry = {
  id: string;
  at: string;
  kind: LogEntryKind;
  group: LogEntryGroup;
  /** what it was: "Owner", the agent's name, "Tool", "Browser", "Command"… */
  label: string;
  title: string;
  meta?: string;
  status?: "running" | "done" | "failed";
  durationMs?: number;
  /** input / command / arguments, exactly as recorded */
  input?: string;
  /** output / result, exactly as recorded */
  output?: string;
  url?: string;
  guard?: GuardInfo;
  /** the message this entry belongs to, so the viewer can group by turn */
  messageId?: string;
  error?: string;
  stopped?: boolean;
  usage?: Record<string, number | undefined>;
};

const LABELS: Record<string, string> = {
  model: "Model",
  tool: "Tool",
  command: "Command",
  file: "File",
  browser: "Browser",
  result: "Result",
  reasoning: "Reasoning",
  status: "Status",
};

const GROUPS: Record<string, LogEntryGroup> = {
  model: "model",
  tool: "tool",
  command: "command",
  file: "file",
  browser: "browser",
  result: "status",
  reasoning: "status",
  status: "status",
};

export function chatLog(chatId: string): ChatLogEntry[] {
  const db = readDb();
  const messages = chatMessages(chatId);
  const agentName = db.agents.find((a) => a.id === messages[0]?.agentId)?.name ?? "Agent";
  const entries: ChatLogEntry[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      entries.push({
        id: m.id, at: m.createdAt, kind: "message", group: "message", messageId: m.id,
        label: m.origin === "system" ? "Nexora" : "Owner",
        title: firstLine(m.content), input: m.content,
      });
      continue;
    }
    // the steps of the turn come before the reply that concluded it
    for (const e of m.activity ?? []) {
      entries.push({
        id: e.id, at: new Date(e.ts).toISOString(), kind: "step", group: GROUPS[e.kind] ?? "status", messageId: m.id,
        label: LABELS[e.kind] ?? e.kind, title: e.title, meta: e.meta,
        status: e.status, durationMs: e.durationMs,
        input: e.detail, output: e.output,
        url: e.browser?.url, guard: e.guard,
      });
    }
    for (const tc of m.toolCalls ?? []) {
      entries.push({
        id: `${m.id}:${tc.server}:${tc.tool}:${entries.length}`, at: m.createdAt, kind: "tool", group: "tool", messageId: m.id,
        label: "Tool", title: `${tc.server} → ${tc.tool}`, meta: tc.server,
        status: tc.ok ? "done" : "failed", durationMs: tc.durationMs,
        input: JSON.stringify(tc.args, null, 2), output: tc.ok ? tc.result : tc.error,
        guard: tc.guard,
      });
    }
    entries.push({
      id: m.id, at: m.createdAt, kind: "message", group: "message", messageId: m.id,
      label: agentName, title: firstLine(m.content), output: m.content,
      status: m.error ? "failed" : "done", error: m.error, stopped: m.stopped,
      durationMs: m.usage?.durationMs,
      usage: m.usage ? { ...m.usage } : undefined,
    });
  }

  for (const c of db.chatCompactions.filter((x) => x.chatId === chatId)) {
    entries.push({
      id: c.id, at: c.at, kind: "compaction", group: "compaction",
      label: "Context", title: `Compacted ${fmt(c.beforeTokens)} → ${fmt(c.afterTokens)} tokens`,
      meta: `${c.runtimeType} · ${c.source}-measured · ${c.reason}`,
      durationMs: c.durationMs, status: "done",
    });
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind));
}

const fmt = (n?: number) => (n == null ? "?" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const firstLine = (s: string) => (s.split("\n").find((l) => l.trim()) ?? "").slice(0, 160);
