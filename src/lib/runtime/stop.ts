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

const live = new Map<string, LiveTurn>();

export function registerTurn(agentId: string, chatId: string, turnId: string): LiveTurn {
  const turn: LiveTurn = { agentId, chatId, turnId, startedAt: Date.now(), controller: new AbortController(), stopped: false };
  live.set(agentId, turn);
  return turn;
}

export function releaseTurn(agentId: string, turnId: string): void {
  if (live.get(agentId)?.turnId === turnId) live.delete(agentId);
}

export function liveTurn(agentId: string): LiveTurn | undefined {
  return live.get(agentId);
}

export function isAgentBusy(agentId: string): boolean {
  return live.has(agentId);
}

/** True when a turn was actually running and has now been asked to stop. */
export function stopTurn(agentId: string): { stopped: boolean; chatId?: string; turnId?: string } {
  const turn = live.get(agentId);
  if (!turn) return { stopped: false };
  turn.stopped = true;
  turn.stoppedAt = Date.now();
  try { turn.controller.abort(); } catch { /* already aborted */ }
  try { turn.kill?.(); } catch (err) { console.error("[stop] could not kill the runtime process:", err); }
  return { stopped: true, chatId: turn.chatId, turnId: turn.turnId };
}

/** Was this turn stopped by the owner (rather than failing on its own)? */
export function wasStopped(agentId: string, turnId: string): boolean {
  const turn = live.get(agentId);
  return !!turn && turn.turnId === turnId && turn.stopped;
}
