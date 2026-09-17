/* ------------------------------------------------------------------
   Live activity bus. In-memory per-agent event log + subscribers, streamed
   to the browser over SSE so the owner watches tools/commands execute in
   real time (like Tandem's live timeline). Events are also persisted onto
   the assistant message so history shows what happened.
   ------------------------------------------------------------------ */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { GuardInfo } from "@/lib/guard";

export type ActivityKind = "status" | "tool" | "command" | "file" | "reasoning" | "result" | "model" | "browser";

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
  ts: number;
};

const bus = new EventEmitter();
bus.setMaxListeners(0);

const RING = 300;
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
  while (list.length > RING) list.shift();
  recent.set(ev.agentId, list);
  bus.emit("event", ev);
  return ev.id;
}

/** A per-turn emitter bound to an agent, with helpers for running→done tools. */
export function turnEmitter(agentId: string, turnId: string) {
  return {
    turnId,
    status(title: string, detail?: string) {
      emitActivity({ agentId, turnId, kind: "status", title, detail });
    },
    start(kind: ActivityKind, title: string, detail?: string, meta?: string): string {
      return emitActivity({ agentId, turnId, kind, title, detail, meta, status: "running" });
    },
    finish(id: string, kind: ActivityKind, title: string, patch: { detail?: string; output?: string; meta?: string; status: ActivityStatus; guard?: GuardInfo }) {
      emitActivity({ id, agentId, turnId, kind, title, ...patch });
    },
    event(ev: Omit<ActivityEvent, "id" | "agentId" | "turnId" | "ts"> & { id?: string }) {
      return emitActivity({ agentId, turnId, ...ev });
    },
  };
}

export type TurnEmitter = ReturnType<typeof turnEmitter>;
