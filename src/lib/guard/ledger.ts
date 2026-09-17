/* ------------------------------------------------------------------
   Action Execution Ledger — persistent record of every side-effecting
   tool execution, keyed by (scope, epoch, fingerprint).

   data/actions.json is the source of truth; an in-memory copy is kept
   write-through. `claim()` is SYNCHRONOUS from lookup to persisted insert,
   which on Node's single thread is the uniqueness guarantee equivalent to
   UNIQUE(scope_id, fingerprint): two concurrent identical calls can never
   both create a PENDING row — the second sees the first.

   Statuses: PENDING → SUCCEEDED | FAILED | UNCERTAIN. A process restart
   turns leftover PENDING rows into UNCERTAIN (the external outcome is
   unknown); PENDING rows are never cleaned up while their process lives.
   ------------------------------------------------------------------ */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "@/lib/store/db";
import type { SideEffectClass } from "./classify";

export type ActionStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "UNCERTAIN";

export type ActionExecution = {
  id: string;
  scopeId: string;
  /** bumped by start_new_action_attempt so an intentional repeat is a new logical operation */
  epoch: number;
  agentId: string;
  toolSource: "mcp" | "internal";
  serverName: string;
  toolName: string;
  /** canonical identity, e.g. zoho_mail.sendEmail */
  toolIdentity: string;
  fingerprint: string;
  idempotencyKey: string;
  class: SideEffectClass;
  status: ActionStatus;
  /** retry number for the same fingerprint after a confirmed FAILED */
  attempt: number;
  startedAt: string;
  completedAt?: string;
  /** sanitized, truncated arguments (never secrets) */
  argsSummary: string;
  resultSummary?: string;
  externalReference?: string;
  error?: string;
  note?: string;
  pid: number;
  providerIdempotency?: boolean;
};

type ScopeMeta = { epoch: number; reason?: string; at: string; agentId?: string };

type LedgerFile = { version: 1; executions: ActionExecution[]; scopes: Record<string, ScopeMeta> };

const FILE = path.join(DATA_DIR, "actions.json");
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_ROWS = 5000;

let cache: LedgerFile | null = null;

function load(): LedgerFile {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, "utf8")) as LedgerFile;
    cache.executions ??= [];
    cache.scopes ??= {};
  } catch {
    cache = { version: 1, executions: [], scopes: {} };
  }
  return cache;
}

function persist(): void {
  const data = load();
  compact(data);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

/** bounded audit history: finished rows expire after 30 days; PENDING rows are never dropped */
function compact(data: LedgerFile): void {
  const cutoff = Date.now() - RETENTION_MS;
  data.executions = data.executions.filter((e) => e.status === "PENDING" || Date.parse(e.completedAt ?? e.startedAt) >= cutoff);
  if (data.executions.length > MAX_ROWS) {
    const finished = data.executions.filter((e) => e.status !== "PENDING").sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const drop = new Set(finished.slice(0, data.executions.length - MAX_ROWS).map((e) => e.id));
    data.executions = data.executions.filter((e) => !drop.has(e.id));
  }
}

/* ---------------------------------------------------------------- scopes / epochs */

export function scopeEpoch(scopeId: string): number {
  return load().scopes[scopeId]?.epoch ?? 0;
}

/** Deliberate, audited repeat: every later identical action in this scope is a new logical operation. */
export function bumpScopeEpoch(scopeId: string, reason: string, agentId?: string): number {
  const data = load();
  const next = (data.scopes[scopeId]?.epoch ?? 0) + 1;
  data.scopes[scopeId] = { epoch: next, reason: reason.slice(0, 300), at: new Date().toISOString(), agentId };
  persist();
  console.log(`[guard] new action attempt epoch ${next} for scope ${scopeId} (${agentId ?? "?"}): ${reason.slice(0, 120)}`);
  return next;
}

/* ---------------------------------------------------------------- claims */

export type ClaimResult =
  | { kind: "created"; record: ActionExecution }
  | { kind: "existing"; record: ActionExecution };

/** The active (latest-attempt) row for a scope+epoch+fingerprint, if any. */
export function activeExecution(scopeId: string, epoch: number, fingerprint: string): ActionExecution | null {
  const rows = load().executions.filter((e) => e.scopeId === scopeId && e.epoch === epoch && e.fingerprint === fingerprint);
  if (rows.length === 0) return null;
  return rows.sort((a, b) => b.attempt - a.attempt)[0];
}

/**
 * Atomically claim the right to execute. Synchronous end to end: the lookup
 * and the PENDING insert cannot interleave with another claim.
 * A previous FAILED row does not block — a new attempt is created.
 */
export function claim(input: Omit<ActionExecution, "id" | "status" | "attempt" | "startedAt" | "pid" | "epoch"> & { epoch?: number }): ClaimResult {
  const data = load();
  const epoch = input.epoch ?? scopeEpoch(input.scopeId);
  const existing = activeExecution(input.scopeId, epoch, input.fingerprint);
  if (existing && existing.status !== "FAILED") return { kind: "existing", record: existing };
  const record: ActionExecution = {
    ...input,
    epoch,
    id: randomUUID(),
    status: "PENDING",
    attempt: existing ? existing.attempt + 1 : 1,
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };
  data.executions.push(record);
  persist();
  return { kind: "created", record };
}

export function settle(id: string, patch: Partial<Pick<ActionExecution, "status" | "resultSummary" | "externalReference" | "error" | "note" | "providerIdempotency">>): ActionExecution | null {
  const data = load();
  const row = data.executions.find((e) => e.id === id);
  if (!row) return null;
  Object.assign(row, patch);
  if (patch.status && patch.status !== "PENDING") row.completedAt = new Date().toISOString();
  persist();
  return row;
}

export function getExecution(id: string): ActionExecution | null {
  return load().executions.find((e) => e.id === id) ?? null;
}

export function listExecutions(filter: { scopeId?: string; agentId?: string; limit?: number } = {}): ActionExecution[] {
  return load()
    .executions.filter((e) => (!filter.scopeId || e.scopeId === filter.scopeId) && (!filter.agentId || e.agentId === filter.agentId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, filter.limit ?? 200);
}

/**
 * Boot: rows left PENDING by a previous process have an unknown external
 * outcome — the request may or may not have reached the provider. They become
 * UNCERTAIN so a resumed agent verifies instead of repeating.
 */
export function recoverLedger(): number {
  const data = load();
  let n = 0;
  for (const e of data.executions) {
    if (e.status === "PENDING" && e.pid !== process.pid) {
      e.status = "UNCERTAIN";
      e.completedAt = new Date().toISOString();
      e.note = "Nexora restarted while this action was in flight; the external outcome is unknown.";
      n += 1;
    }
  }
  if (n) {
    persist();
    console.log(`[guard] ${n} in-flight action(s) from a previous process marked UNCERTAIN`);
  } else compact(data);
  return n;
}
