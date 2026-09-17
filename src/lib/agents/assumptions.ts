/* ------------------------------------------------------------------
   Assumption ledger.

   An agent that keeps working instead of interrupting the owner has to
   say so — afterwards, not in the middle of the task. Every reversible
   choice it makes on the owner's behalf is recorded here with its reason
   and, when it stored one, the Custom Data key that now holds it. The
   workspace shows the assumptions of the current task above the
   composer, so the owner can correct anything in one place.
   ------------------------------------------------------------------ */

import { emitActivity } from "@/lib/activity";
import { newId, now, readDb, updateDb } from "@/lib/store/db";
import type { AgentAssumption } from "./types";

const MAX_ROWS = 2_000;

export function recordAssumption(input: { agentId: string; summary: string; detail?: string; customDataKey?: string; scopeId?: string }): AgentAssumption {
  const agent = readDb().agents.find((a) => a.id === input.agentId);
  const summary = input.summary.trim().slice(0, 200);
  if (!summary) throw new Error("summary is required: one line saying what you decided.");
  const rec: AgentAssumption = {
    id: newId(),
    agentId: input.agentId,
    agentName: agent?.name ?? input.agentId.slice(0, 8),
    scopeId: input.scopeId,
    summary,
    detail: input.detail?.trim().slice(0, 600) || undefined,
    customDataKey: input.customDataKey?.trim().toLowerCase().slice(0, 120) || undefined,
    createdAt: now(),
  };
  updateDb((d) => {
    d.agentAssumptions.push(rec);
    if (d.agentAssumptions.length > MAX_ROWS) d.agentAssumptions.splice(0, d.agentAssumptions.length - MAX_ROWS);
  });
  // inspectable in the run's activity, not in the conversation
  emitActivity({ agentId: input.agentId, turnId: input.scopeId ?? "assumption", kind: "status", title: "Assumption", detail: `${summary}${rec.detail ? ` — ${rec.detail}` : ""}`, status: "done" });
  return rec;
}

export function listAssumptions(agentId: string, opts: { scopeId?: string; limit?: number } = {}): AgentAssumption[] {
  const rows = readDb().agentAssumptions.filter((a) => a.agentId === agentId && (!opts.scopeId || a.scopeId === opts.scopeId));
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, opts.limit ?? 50);
}

/**
 * The assumptions of the task the agent is working on now: the execution scope
 * of the thread in question, or — when that scope has none yet, or the work was
 * driven outside a chat turn — the most recent task that recorded any.
 */
export function currentAssumptions(agentId: string, chatId?: string): AgentAssumption[] {
  const all = listAssumptions(agentId, { limit: 200 });
  if (!all.length) return [];
  const convs = readDb().conversations.filter((c) => c.agentId === agentId);
  const scopeId = (chatId ? convs.find((c) => c.chatId === chatId) : convs.at(-1))?.executionScopeId;
  const current = scopeId ? all.filter((a) => a.scopeId === scopeId) : [];
  if (current.length) return current.reverse();
  const latest = all[0].scopeId;
  return all.filter((a) => a.scopeId === latest).reverse();
}
