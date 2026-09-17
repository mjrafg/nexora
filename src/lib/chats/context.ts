/* ------------------------------------------------------------------
   Context management for a chat thread.

   Nexora never invents a context number. `usedTokens` is what the provider
   itself last reported for the thread's session (or what a compaction
   measured, whichever is newer); everything recorded after that anchor is a
   Nexora estimate and is reported separately as `pendingTokens`. When the
   provider has reported nothing at all — a runtime that does not expose its
   session size — the whole figure is an estimate and is labelled as one.
   ------------------------------------------------------------------ */

import { readDb, updateDb } from "@/lib/store/db";
import type { ActivityEvent } from "@/lib/activity";
import type { ChatMessage, RuntimeType } from "@/lib/runtime/types";
import type { ChatContextUsage } from "./types";
import { chatMessages, conversationFor, getChat } from "./store";

/** Compact when the thread passes either of these. Both are env-overridable. */
export const CONTEXT_LIMITS = {
  warnPct: num(process.env.NEXORA_CONTEXT_WARN_PCT, 70),
  critPct: num(process.env.NEXORA_CONTEXT_CRIT_PCT, 88),
  autoCompact: process.env.NEXORA_AUTO_COMPACT !== "0",
  compactPct: num(process.env.NEXORA_COMPACT_PCT, 85),
  compactMaxTokens: num(process.env.NEXORA_COMPACT_MAX_TOKENS, 200_000),
  /**
   * Below this there is nothing to gain: compacting a short session replaces a
   * cheap transcript with a summary plus the runtime's own scaffolding, and the
   * context comes back BIGGER (measured on Claude Code: 3.1k → 19.7k). Nexora
   * refuses rather than making the conversation worse.
   */
  compactFloorTokens: num(process.env.NEXORA_COMPACT_FLOOR_TOKENS, 25_000),
};

/** Is this conversation big enough that compacting it would actually help? */
export function compactWorthwhile(usage: { total: number | null; windowTokens: number | null }): boolean {
  const floor = Math.max(CONTEXT_LIMITS.compactFloorTokens, usage.windowTokens ? usage.windowTokens * 0.2 : 0);
  return (usage.total ?? 0) >= floor;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function estimateTokens(s: string | undefined | null): number {
  return Math.ceil((s ?? "").length / 4);
}

/** Roughly what feeding this activity event back into the session costs. */
export function estimateActivityTokens(e: ActivityEvent): number {
  return 20 + estimateTokens(e.title) + estimateTokens(e.detail) + estimateTokens(e.output)
    + (e.browser ? 40 + estimateTokens(e.browser.url) + estimateTokens(e.browser.value) : 0);
}

export function estimateMessageTokens(m: ChatMessage): number {
  return estimateTokens(m.content)
    + (m.activity ?? []).reduce((n, e) => n + estimateActivityTokens(e), 0)
    + (m.toolCalls ?? []).reduce((n, t) => n + 40 + estimateTokens(JSON.stringify(t.args)) + estimateTokens(t.result), 0);
}

/* ---------- provider-reported context windows ---------- */

const key = (rt: RuntimeType, model: string | null | undefined) => (model ? `${rt}:${model}` : null);

/** Remember a window a provider actually reported, so later turns can use it. */
export function recordModelWindow(rt: RuntimeType, model: string | undefined, window: number | undefined): void {
  const k = key(rt, model);
  if (!k || !window || window <= 0) return;
  if (readDb().modelWindows[k] === window) return;
  updateDb((d) => { d.modelWindows[k] = window; });
}

export function knownModelWindow(rt: RuntimeType, model: string | null): number | null {
  const k = key(rt, model);
  return k ? readDb().modelWindows[k] ?? null : null;
}

/* ---------- the meter ---------- */

export function computeChatUsage(chatId: string): ChatContextUsage | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  const db = readDb();
  const agent = db.agents.find((a) => a.id === chat.agentId);
  const config = agent && db.runtimeConfigs.find((r) => r.id === agent.runtimeConfigId);
  const runtimeType: RuntimeType = config?.runtimeType ?? "api";
  const messages = chatMessages(chatId);
  const compactions = db.chatCompactions.filter((c) => c.chatId === chatId).sort((a, b) => a.at.localeCompare(b.at));
  const lastCompaction = compactions.at(-1) ?? null;

  // anchor: the newest hard number we have — a provider report, or a compaction
  let anchorAt = "";
  let usedTokens: number | null = null;
  let model: string | null = config?.model ?? null;
  let source: ChatContextUsage["source"] = "none";

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.usage?.contextTokens != null) {
      usedTokens = m.usage.contextTokens;
      model = m.runtime?.model ?? model;
      source = "provider";
      anchorAt = m.createdAt;
      break;
    }
  }
  if (lastCompaction?.afterTokens != null && lastCompaction.at > anchorAt) {
    usedTokens = lastCompaction.afterTokens;
    model = lastCompaction.model ?? model;
    source = lastCompaction.source;
    anchorAt = lastCompaction.at;
  }

  // window: the newest one a provider reported for this thread, else the newest
  // one ever observed for the same runtime + model. Never a Nexora constant.
  let windowTokens: number | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const w = messages[i].usage?.contextWindow;
    if (w) { windowTokens = w; break; }
  }
  windowTokens ??= lastCompaction?.windowTokens ?? null;
  windowTokens ??= knownModelWindow(runtimeType, model) ?? knownModelWindow(runtimeType, config?.model ?? null);

  let pendingTokens = 0;
  for (const m of messages) if (m.createdAt > anchorAt) pendingTokens += estimateMessageTokens(m);

  // no provider has ever reported this thread's size: estimate the whole thing,
  // and say so — an honest estimate beats an empty meter
  if (usedTokens == null) {
    usedTokens = messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
    pendingTokens = 0;
    source = messages.length ? "estimated" : "none";
  }

  const total = usedTokens + pendingTokens;
  const support = compactSupport(runtimeType);
  const worthwhile = support.available && compactWorthwhile({ total, windowTokens });
  return {
    chatId,
    runtimeType,
    model,
    sessionId: conversationFor(chatId)?.sessions[runtimeType] ?? null,
    usedTokens,
    pendingTokens,
    windowTokens,
    total,
    pct: windowTokens ? Math.round((total / windowTokens) * 100) : null,
    source,
    turns: messages.filter((m) => m.role === "assistant").length,
    compact: {
      ...support,
      worthwhile,
      reason: support.available && !worthwhile
        ? "There is nothing to compact yet. A short conversation comes back larger — a summary plus the runtime's own scaffolding — so this stays available until the context is genuinely full."
        : support.reason,
    },
    autoCompact: { enabled: CONTEXT_LIMITS.autoCompact, pct: CONTEXT_LIMITS.compactPct, maxTokens: CONTEXT_LIMITS.compactMaxTokens },
    lastCompaction,
  };
}

/**
 * Only a runtime that owns a resumable session can compact its own context.
 * Nexora never summarizes a conversation itself and never sends it to another
 * model, so where the provider cannot do it, it simply cannot be done.
 */
export function compactSupport(runtimeType: RuntimeType): { available: boolean; reason?: string } {
  if (runtimeType === "claude-code") return { available: true };
  if (runtimeType === "codex") {
    return {
      available: false,
      reason: "Codex has no compact operation that can be invoked from outside its own interface; it compacts automatically inside long runs. Start a new chat when this one gets heavy.",
    };
  }
  return {
    available: false,
    reason: "Direct API runtimes have no provider-side session to compact — Nexora sends the transcript each turn. Start a new chat to reset the context.",
  };
}

export function shouldAutoCompact(usage: ChatContextUsage): boolean {
  if (!CONTEXT_LIMITS.autoCompact || !usage.compact.available || !usage.compact.worthwhile) return false;
  if (usage.source === "none") return false;
  if (usage.total != null && usage.total >= CONTEXT_LIMITS.compactMaxTokens) return true;
  return usage.pct != null && usage.pct >= CONTEXT_LIMITS.compactPct;
}
