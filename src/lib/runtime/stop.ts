/* ------------------------------------------------------------------
   Live turns, so the owner can stop one.

   Exactly one turn runs per agent at a time (sendAgentMessage serializes
   them), so a single registry keyed by agent is enough. Stopping kills the
   runtime's child process and aborts in-flight API requests; the turn then
   ends as "stopped", never as a failure.
   ------------------------------------------------------------------ */

export type LiveTurn = {
  agentId: string;
  chatId: string;
  turnId: string;
  startedAt: number;
  /** set once the runtime has spawned something killable */
  kill?: () => void;
  controller: AbortController;
  stopped: boolean;
  stoppedAt?: number;
};

/*
 * Keyed by TURN, not by agent. A chat serializes turns per agent, but project
 * work does not: two sessions of the same milestone can run in parallel with
 * the same Builder. Keying by agent there would let the second turn evict the
 * first from the registry — the first would then look idle, never release, and
 * a Stop could abort the wrong process.
 */
const live = new Map<string, LiveTurn>();

const turnsOf = (agentId: string) => [...live.values()].filter((t) => t.agentId === agentId);
/**
 * The registry's own key. Not the caller's turnId: a project session's turnId
 * is its key ("session:S1.1"), which two projects can both be running at once.
 * Callers still address turns by (agentId, turnId), which is unique in practice.
 */
const keyOf = (t: LiveTurn) => `${t.agentId}\u0000${t.turnId}`;
const find = (agentId: string, turnId: string) => live.get(`${agentId}\u0000${turnId}`);

export function registerTurn(agentId: string, chatId: string, turnId: string): LiveTurn {
  const turn: LiveTurn = { agentId, chatId, turnId, startedAt: Date.now(), controller: new AbortController(), stopped: false };
  live.set(keyOf(turn), turn);
  return turn;
}

export function releaseTurn(agentId: string, turnId: string): void {
  live.delete(`${agentId}\u0000${turnId}`);
}

/** The agent's most recently started turn — what a chat's Stop button means. */
export function liveTurn(agentId: string): LiveTurn | undefined {
  return turnsOf(agentId).sort((a, b) => b.startedAt - a.startedAt)[0];
}

export function isAgentBusy(agentId: string): boolean {
  return turnsOf(agentId).length > 0;
}

/** Everything this agent is running right now (a project can be more than one). */
export function liveTurnsOf(agentId: string): LiveTurn[] {
  return turnsOf(agentId);
}

/** True when a turn was actually running and has now been asked to stop. */
export function stopTurn(agentId: string): { stopped: boolean; chatId?: string; turnId?: string } {
  const turns = turnsOf(agentId);
  if (!turns.length) return { stopped: false };
  // stopping an agent stops everything it is doing, not just its newest turn
  for (const turn of turns) {
    turn.stopped = true;
    turn.stoppedAt = Date.now();
    try { turn.controller.abort(); } catch { /* already aborted */ }
    try { turn.kill?.(); } catch (err) { console.error("[stop] could not kill the runtime process:", err); }
  }
  const newest = turns.sort((a, b) => b.startedAt - a.startedAt)[0];
  return { stopped: true, chatId: newest.chatId, turnId: newest.turnId };
}

/** Was this turn stopped by the owner (rather than failing on its own)? */
export function wasStopped(agentId: string, turnId: string): boolean {
  return !!find(agentId, turnId)?.stopped;
}

/** Stop one specific turn — what stopping a single project session means. */
export function stopOneTurn(agentId: string, turnId: string): boolean {
  const turn = find(agentId, turnId);
  if (!turn) return false;
  turn.stopped = true;
  turn.stoppedAt = Date.now();
  try { turn.controller.abort(); } catch { /* already aborted */ }
  try { turn.kill?.(); } catch (err) { console.error("[stop] could not kill the runtime process:", err); }
  return true;
}
