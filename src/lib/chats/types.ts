/* ------------------------------------------------------------------
   Chat threads.

   An agent is a person you can hold several separate conversations with.
   Each thread owns its own transcript, its own runtime session (so the
   provider's context is per thread, not per agent), its own execution
   scope and its own context meter.
   ------------------------------------------------------------------ */

import type { RuntimeType } from "@/lib/runtime/types";

export type ChatThread = {
  id: string;
  agentId: string;
  title: string;
  /** the title is still Nexora's; the owner renaming it pins the title for good */
  autoTitle: boolean;
  createdAt: string;
  updatedAt: string;
  /** archived threads stay readable and exportable, they are just out of the way */
  archivedAt?: string | null;
};

/** One context compaction, recorded with the provider's own before/after. */
export type ChatCompaction = {
  id: string;
  chatId: string;
  agentId: string;
  runtimeType: RuntimeType;
  model: string | null;
  beforeTokens?: number;
  afterTokens?: number;
  windowTokens?: number;
  /** were the numbers reported by the provider, or estimated by Nexora? */
  source: "provider" | "estimated";
  reason: "manual" | "auto";
  sessionId?: string;
  durationMs?: number;
  at: string;
};

/**
 * What the active provider context looks like right now.
 *
 * `usedTokens` is the last size the provider itself reported (or the size
 * recorded by a compaction, whichever is newer). Everything that happened
 * after that anchor is Nexora's own estimate and stays separate in
 * `pendingTokens`, so a provider number is never quietly mixed with a guess.
 */
export type ChatContextUsage = {
  chatId: string;
  runtimeType: RuntimeType;
  model: string | null;
  sessionId: string | null;
  usedTokens: number | null;
  pendingTokens: number;
  windowTokens: number | null;
  total: number | null;
  pct: number | null;
  source: "provider" | "estimated" | "none";
  /** how many turns are in this thread (for the popover) */
  turns: number;
  /**
   * Can this runtime compact its own session (and is the conversation big
   * enough that it would help), and if not, why not.
   */
  compact: { available: boolean; worthwhile: boolean; reason?: string };
  autoCompact: { enabled: boolean; pct: number; maxTokens: number };
  lastCompaction?: ChatCompaction | null;
};

export type CompactOutcome = {
  ok: boolean;
  runtimeType: RuntimeType;
  model: string | null;
  beforeTokens?: number;
  afterTokens?: number;
  windowTokens?: number;
  source?: "provider" | "estimated";
  durationMs: number;
  error?: string;
};
