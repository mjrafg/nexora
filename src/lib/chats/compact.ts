/* ------------------------------------------------------------------
   Provider-native context compaction.

   Nexora never summarizes a conversation itself and never hands it to
   another model. It asks the runtime that OWNS the thread's session to
   compact its own context — Claude Code runs `/compact` inside the resumed
   session — and records exactly what the provider reported before and after.
   Where a runtime cannot do that, compaction is honestly unavailable.
   ------------------------------------------------------------------ */

import { newId, now, readDb, updateDb } from "@/lib/store/db";
import { resolveRuntime } from "@/lib/runtime";
import { isAgentBusy } from "@/lib/runtime/stop";
import { claudeSlash, parseClaudeContext } from "@/lib/runtime/adapters/claude-code";
import { agentWorkspace } from "@/lib/runtime/adapters/cli";
import { CONTEXT_LIMITS, compactWorthwhile, computeChatUsage, compactSupport, recordModelWindow, shouldAutoCompact } from "./context";
import { conversationFor, getChat } from "./store";
import type { ChatCompaction, CompactOutcome } from "./types";

export async function compactChat(chatId: string, reason: "manual" | "auto" = "manual"): Promise<CompactOutcome> {
  const started = Date.now();
  const chat = getChat(chatId);
  if (!chat) return { ok: false, runtimeType: "api", model: null, durationMs: 0, error: "Chat not found." };

  const db = readDb();
  const agent = db.agents.find((a) => a.id === chat.agentId);
  const config = agent && db.runtimeConfigs.find((r) => r.id === agent.runtimeConfigId);
  if (!agent || !config) return { ok: false, runtimeType: "api", model: null, durationMs: 0, error: "This agent has no runtime configured." };

  const support = compactSupport(config.runtimeType);
  const base = { runtimeType: config.runtimeType, model: config.model };
  if (!support.available) return { ok: false, ...base, durationMs: 0, error: support.reason };

  if (isAgentBusy(agent.id)) {
    return { ok: false, ...base, durationMs: 0, error: `${agent.name} is working right now — compaction drives the same session, so let the turn finish first.` };
  }

  const sessionId = conversationFor(chatId)?.sessions[config.runtimeType];
  if (!sessionId) {
    return { ok: false, ...base, durationMs: 0, error: "This chat has no provider session yet — send a message first." };
  }

  const resolved = resolveRuntime(config);
  const cwd = agentWorkspace(agent.id, config.advancedSettings.workingDirectory);

  // before: the provider's own reading, with the meter as the fallback
  const before = await readNative(resolved, sessionId, cwd);
  const estimate = computeChatUsage(chatId);
  const beforeTokens = before?.usedTokens ?? estimate?.total ?? undefined;
  const windowBefore = before?.windowTokens ?? estimate?.windowTokens ?? undefined;

  // a short conversation comes back bigger, not smaller — say so and stop
  if (!compactWorthwhile({ total: beforeTokens ?? null, windowTokens: windowBefore ?? null })) {
    const floor = Math.max(CONTEXT_LIMITS.compactFloorTokens, windowBefore ? Math.round(windowBefore * 0.2) : 0);
    return {
      ok: false, ...base, durationMs: Date.now() - started,
      error: `Nothing to compact yet — this conversation is ${(beforeTokens ?? 0).toLocaleString()} tokens${
        windowBefore ? ` of a ${windowBefore.toLocaleString()} window` : ""
      }. Compacting a short session replaces it with a summary plus the runtime's own scaffolding and ends up larger, so Nexora waits until about ${floor.toLocaleString()} tokens.`,
    };
  }

  const run = await claudeSlash(resolved, { sessionId, cwd, command: "/compact", timeoutMs: 10 * 60_000 });
  if (!run.ok) return { ok: false, ...base, durationMs: Date.now() - started, error: run.error };
  if (/\bAPI Error\b|error (?:while )?compacting|compaction failed/i.test(run.text)) {
    return { ok: false, ...base, durationMs: Date.now() - started, error: `Claude Code accepted /compact but reported: ${run.text.slice(0, 300)}` };
  }

  const after = await readNative(resolved, sessionId, cwd);
  // A compaction that changed nothing is a failure whatever the CLI said: its
  // summarization is itself a model call and can be refused. Recording that as
  // a success would re-anchor the meter and hide that nothing happened.
  if (before && after && after.usedTokens >= before.usedTokens * 0.95) {
    return {
      ok: false, ...base, durationMs: Date.now() - started,
      error: `Claude Code accepted /compact but the context did not shrink (${before.usedTokens.toLocaleString()} → ${after.usedTokens.toLocaleString()} tokens) — its summarization call most likely failed. Nothing was recorded; the meter re-reads the real size after the next turn.`,
    };
  }

  const record: ChatCompaction = {
    id: newId(),
    chatId,
    agentId: agent.id,
    runtimeType: config.runtimeType,
    model: config.model,
    beforeTokens,
    afterTokens: after?.usedTokens,
    windowTokens: after?.windowTokens ?? windowBefore,
    source: before && after ? "provider" : "estimated",
    reason,
    sessionId,
    durationMs: Date.now() - started,
    at: now(),
  };
  updateDb((d) => { d.chatCompactions.push(record); });
  recordModelWindow(config.runtimeType, config.model, record.windowTokens);

  return {
    ok: true, ...base,
    beforeTokens: record.beforeTokens,
    afterTokens: record.afterTokens,
    windowTokens: record.windowTokens,
    source: record.source,
    durationMs: record.durationMs!,
  };
}

async function readNative(
  resolved: ReturnType<typeof resolveRuntime>,
  sessionId: string,
  cwd: string
): Promise<{ usedTokens: number; windowTokens: number } | null> {
  const res = await claudeSlash(resolved, { sessionId, cwd, command: "/context", timeoutMs: 120_000 });
  if (!res.ok) return null;
  const parsed = parseClaudeContext(res.text);
  if (parsed) recordModelWindow(resolved.config.runtimeType, resolved.config.model, parsed.windowTokens);
  return parsed;
}

/**
 * Called before a turn: if the thread is over the line and its runtime can
 * compact itself, do it first. Failure is never fatal — the turn goes ahead
 * with the context it has.
 */
export async function autoCompactIfNeeded(chatId: string): Promise<void> {
  const usage = computeChatUsage(chatId);
  if (!usage || !shouldAutoCompact(usage)) return;
  const out = await compactChat(chatId, "auto").catch((err) => ({ ok: false, error: String(err) }) as CompactOutcome);
  if (!out.ok) console.warn("[context] auto-compaction skipped:", out.error);
}
