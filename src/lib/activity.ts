/* ------------------------------------------------------------------
   Live activity bus. In-memory per-agent event log + subscribers, streamed
   to the browser over SSE so the owner watches tools/commands execute in
   real time (like Tandem's live timeline). Events are also persisted onto
   the assistant message so history shows what happened.
   ------------------------------------------------------------------ */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { GuardInfo } from "@/lib/guard";

/** "note" is the agent talking: what it says between its tool calls. */
export type ActivityKind = "status" | "tool" | "command" | "file" | "reasoning" | "result" | "model" | "browser" | "note";

/** Sanitized browser action facts (ported from Tandem's BrowserActionPayload) — never cookies, storage or secrets. */
export type BrowserActionMeta = {
  action: string;
  url?: string;
  title?: string;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  ref?: string;
  /** already redacted for sensitive input */
  value?: string;
  /** served screenshot URL */
  screenshotUrl?: string;
  console?: { level: string; text: string }[];
  error?: string;
  /** which browser session drove the action */
  session?: string;
};
export type ActivityStatus = "running" | "done" | "failed";

/**
 * Who actually did this, when the channel is not a person.
 *
 * Project work is emitted on a project channel so the whole run reads as one
 * stream — but a stream that cannot say whether the Builder or the Reviewer
 * ran a command is not an answer to "who is doing what". Every event carried
 * on a shared channel names its actor.
 */
export type ActivityActor = {
  agentId: string;
  name: string;
  /** "Director" | "Builder" | "Reviewer" — the hat, not the job title */
  role: string;
  /** the session this belongs to, when it belongs to one */
  sessionKey?: string;
};

export type ActivityEvent = {
  id: string;
  agentId: string;
  turnId: string;
  kind: ActivityKind;
  /** the thing itself — tool name, command, file path, runtime label */
  title: string;
  /** right-hand context — MCP server name, model id, runtime */
  meta?: string;
  /** sanitized input / command / detail */
  detail?: string;
  /** sanitized output when done */
  output?: string;
  status?: ActivityStatus;
  /** filled automatically when a running event later completes */
  durationMs?: number;
  browser?: BrowserActionMeta;
  /** side-effect guard verdict for tool events (executed / deduplicated / uncertain…) */
  guard?: GuardInfo;
  /** set when the channel is shared (a project) rather than one agent's own */
  actor?: ActivityActor;
  ts: number;
};

const bus = new EventEmitter();
bus.setMaxListeners(0);

const RING = 300;
/** A project channel carries three agents' work for a whole build; one turn's
 *  worth of history is not enough to open the page on and understand the run. */
const WIDE_RING = 3_000;
const ringFor = (channel: string) => (channel.startsWith("project:") ? WIDE_RING : RING);
const recent = new Map<string, ActivityEvent[]>();

export function subscribeActivity(agentId: string, cb: (ev: ActivityEvent) => void): () => void {
  const handler = (ev: ActivityEvent) => {
    if (ev.agentId === agentId) cb(ev);
  };
  bus.on("event", handler);
  return () => bus.off("event", handler);
}

export function recentActivity(agentId: string, sinceTs = 0): ActivityEvent[] {
  return (recent.get(agentId) ?? []).filter((e) => e.ts >= sinceTs);
}

/** Emit a new event; returns its id so callers can update it (running → done). */
export function emitActivity(input: Omit<ActivityEvent, "id" | "ts"> & { id?: string; ts?: number }): string {
  const ev: ActivityEvent = { id: input.id ?? randomUUID(), ts: input.ts ?? Date.now(), ...input } as ActivityEvent;
  const list = recent.get(ev.agentId) ?? [];
  const existingIdx = list.findIndex((e) => e.id === ev.id);
  if (existingIdx >= 0) {
    const prev = list[existingIdx];
    // keep the original start time and derive how long the step took
    ev.ts = prev.ts;
    if (ev.durationMs === undefined && ev.status && ev.status !== "running") ev.durationMs = Date.now() - prev.ts;
    if (ev.detail === undefined) ev.detail = prev.detail;
    if (ev.meta === undefined) ev.meta = prev.meta;
    if (ev.browser === undefined) ev.browser = prev.browser;
    if (ev.guard === undefined) ev.guard = prev.guard;
    list[existingIdx] = ev;
  } else list.push(ev);
  while (list.length > ringFor(ev.agentId)) list.shift();
  recent.set(ev.agentId, list);
  bus.emit("event", ev);
  return ev.id;
}

/** A per-turn emitter bound to an agent, with helpers for running→done tools. */
export function turnEmitter(agentId: string, turnId: string, opts: { actor?: ActivityActor; mirror?: string[] } = {}) {
  const { actor, mirror = [] } = opts;
  // the same event, also delivered to the acting agent's own channel, so the
  // agent's page shows the work it is doing inside a project
  const fan = (ev: Omit<ActivityEvent, "id" | "ts"> & { id?: string; ts?: number }): string => {
    const id = emitActivity({ ...ev, ...(actor ? { actor } : {}) });
    for (const ch of mirror) {
      if (ch === ev.agentId) continue;
      emitActivity({ ...ev, id: `${id}@${ch}`, agentId: ch, ...(actor ? { actor } : {}) });
    }
    return id;
  };
  return {
    turnId,
    actor,
    status(title: string, detail?: string) {
      fan({ agentId, turnId, kind: "status", title, detail });
    },
    start(kind: ActivityKind, title: string, detail?: string, meta?: string): string {
      return fan({ agentId, turnId, kind, title, detail, meta, status: "running" });
    },
    finish(id: string, kind: ActivityKind, title: string, patch: { detail?: string; output?: string; meta?: string; status: ActivityStatus; guard?: GuardInfo }) {
      fan({ id, agentId, turnId, kind, title, ...patch });
    },
    event(ev: Omit<ActivityEvent, "id" | "agentId" | "turnId" | "ts"> & { id?: string }) {
      return fan({ agentId, turnId, ...ev });
    },
  };
}

/** The same channel and turn, seen as a different person doing a different job. */
export function asActor(emit: TurnEmitter, actor: ActivityActor, channel: string): TurnEmitter {
  return turnEmitter(channel, emit.turnId, { actor, mirror: [actor.agentId] });
}

export type TurnEmitter = ReturnType<typeof turnEmitter>;
