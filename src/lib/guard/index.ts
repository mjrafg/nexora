/* ------------------------------------------------------------------
   Side-Effect Execution Guard.

     never executed      → claim PENDING, execute
     already executing   → do not start another copy; await the winner
     already SUCCEEDED   → return the previous result, deduplicated
     previously FAILED   → allow the retry (new attempt)
     UNCERTAIN outcome   → do NOT repeat; tell the agent to verify first

   The guard is the single place every tool source (MCP, internal, API)
   passes through. It never sees or stores secret values: arguments are
   scrubbed before they are summarized, and only a bounded result summary
   plus an external reference (message id, record id…) is kept.
   ------------------------------------------------------------------ */

import { createHash } from "node:crypto";
import { classifyTool, isSideEffecting, type SideEffectClass, type ToolAnnotations } from "./classify";
import { activeExecution, bumpScopeEpoch, claim, scopeEpoch, settle, type ActionExecution } from "./ledger";

export * from "./classify";
export * from "./ledger";

export type GuardOutcome = "executed" | "deduplicated" | "in_flight_reused" | "uncertain_blocked" | "read_only";

export type GuardInfo = {
  outcome: GuardOutcome;
  class: SideEffectClass;
  executionId?: string;
  status?: ActionExecution["status"];
  originalAt?: string;
  originalAgentId?: string;
  attempt?: number;
  externalReference?: string;
  providerIdempotency?: boolean;
};

export type ExecResult = { ok: boolean; text: string; images?: { mimeType: string; data: string }[] };

export type GuardedInput = {
  scopeId: string;
  agentId: string;
  toolSource: "mcp" | "internal";
  serverName: string;
  toolName: string;
  /** canonical identity, e.g. "zoho_mail.sendEmail" */
  toolIdentity: string;
  description?: string;
  annotations?: ToolAnnotations | null;
  override?: SideEffectClass | null;
  inputSchema?: { properties?: Record<string, unknown> } | null;
  args: Record<string, unknown>;
  /** secret strings to scrub from anything persisted or logged */
  secrets?: string[];
  /** the result itself is secret (payment details): store no summary, dedup replies carry none */
  sensitiveResult?: boolean;
  exec: (args: Record<string, unknown>) => Promise<ExecResult>;
};

export type GuardedOutput = ExecResult & { guard: GuardInfo };

/* ---------------------------------------------------------------- fingerprint */

const EXCLUDED_KEYS = /^(idempotency[_-]?key|idempotency[_-]?token|client[_-]?request[_-]?id|request[_-]?id|nonce|timestamp|ts|sent[_-]?at|created[_-]?at|trace[_-]?id|correlation[_-]?id|x[_-]?request[_-]?id)$/i;

function normalize(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      if (EXCLUDED_KEYS.test(k)) continue;
      const n = normalize((v as Record<string, unknown>)[k]);
      if (n !== undefined) out[k] = n;
    }
    return out;
  }
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  return v;
}

export function canonicalJson(args: Record<string, unknown>): string {
  return JSON.stringify(normalize(args) ?? {});
}

export function fingerprintFor(scopeId: string, toolIdentity: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${scopeId}\n${toolIdentity}\n${canonicalJson(args)}`).digest("hex");
}

/* ---------------------------------------------------------------- helpers */

/** argument keys whose string values are never persisted or shown (activity, ledger, transcripts) */
export const SECRET_ARG_KEYS = /password|passwd|secret|token|api[_-]?key|cvv|cvc|otp|private[_-]?key|card[_-]?number|account[_-]?number|routing[_-]?number/i;

export function maskSecretArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) out[k] = SECRET_ARG_KEYS.test(k) && typeof v === "string" && v ? "•••" : v && typeof v === "object" && !Array.isArray(v) ? maskSecretArgs(v as Record<string, unknown>) : v;
  return out;
}

function scrub(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) while (out.includes(s)) out = out.split(s).join("•••");
  return out;
}

const REF_KEYS = /^(message[_-]?id|messageid|record[_-]?id|event[_-]?id|invoice[_-]?id|order[_-]?id|transaction[_-]?id|zone[_-]?id|account[_-]?id|payment[_-]?id|charge[_-]?id|ticket[_-]?id|issue[_-]?id|post[_-]?id|id)$/i;

/** Best-effort external reference (message id, record id…) from a tool result. */
export function extractReference(text: string): string | undefined {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const walk = (v: unknown, depth: number): string | undefined => {
      if (!v || typeof v !== "object" || depth > 3) return undefined;
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) if (REF_KEYS.test(k) && (typeof o[k] === "string" || typeof o[k] === "number")) return `${k}=${String(o[k]).slice(0, 80)}`;
      for (const k of ["data", "result", "response", "message", "record", "item"]) {
        const r = walk(o[k], depth + 1);
        if (r) return r;
      }
      return undefined;
    };
    const r = walk(parsed, 0);
    if (r) return r;
  } catch { /* not JSON */ }
  const m = trimmed.match(/\b([A-Za-z]*[Ii][Dd])\b["']?\s*[:=]\s*["']?([\w.-]{4,80})/);
  return m ? `${m[1]}=${m[2]}` : undefined;
}

const UNCERTAIN = /timed? ?out|timeout|ECONNRESET|socket hang up|ETIMEDOUT|EPIPE|aborted|network error|ECONNABORTED|premature|connection (?:closed|reset|lost)|exited \(code/i;

/** Was the failure confirmed before any mutation, or could the provider have completed it? */
export function isUncertainFailure(errorText: string): boolean {
  return UNCERTAIN.test(errorText);
}

const IDEMPOTENCY_PARAMS = ["idempotencyKey", "idempotency_key", "idempotencyToken", "idempotency_token", "clientRequestId", "client_request_id", "Idempotency-Key"];

/** Forward Nexora's key when the tool's schema declares a native idempotency parameter. */
export function withProviderIdempotency(args: Record<string, unknown>, schema: GuardedInput["inputSchema"], key: string): { args: Record<string, unknown>; used: boolean } {
  const props = schema?.properties ?? {};
  for (const p of IDEMPOTENCY_PARAMS) {
    if (p in props) {
      if (args[p] === undefined || args[p] === null || args[p] === "") return { args: { ...args, [p]: key }, used: true };
      return { args, used: true };
    }
  }
  return { args, used: false };
}

/* ---------------------------------------------------------------- in-flight registry (this process) */

const inFlight = new Map<string, Promise<GuardedOutput>>();

function dedupPayload(record: ActionExecution, reused: boolean): string {
  return JSON.stringify(
    {
      status: "already_completed",
      deduplicated: true,
      reusedInFlight: reused || undefined,
      executionId: record.id,
      message: `This exact action already completed successfully in the current work scope${reused ? " (it was in progress when you called again)" : ""}. Do not repeat it; continue with the next step.`,
      completedAt: record.completedAt,
      externalReference: record.externalReference,
      originalResult: record.resultSummary,
    },
    null,
    1
  );
}

function uncertainPayload(record: ActionExecution): string {
  return JSON.stringify(
    {
      status: "uncertain_outcome",
      deduplicated: true,
      executionId: record.id,
      message: `This exact action was attempted before in the current work scope, but its external outcome is UNKNOWN (${record.error ?? record.note ?? "the request may have completed"}). It was NOT repeated. Verify the external state with a read-only tool first (e.g. search the sent mailbox, list the records). Only if it definitely did not happen, call start_new_action_attempt with the reason, then perform the action again.`,
      attemptedAt: record.startedAt,
      error: record.error,
    },
    null,
    1
  );
}

/* ---------------------------------------------------------------- the guard */

export async function runGuarded(input: GuardedInput): Promise<GuardedOutput> {
  const cls = classifyTool({ name: input.toolName, description: input.description, annotations: input.annotations, override: input.override });
  if (!isSideEffecting(cls)) {
    const r = await input.exec(input.args);
    return { ...r, guard: { outcome: "read_only", class: cls } };
  }

  const epoch = scopeEpoch(input.scopeId);
  const fingerprint = fingerprintFor(input.scopeId, input.toolIdentity, input.args);
  const flightKey = `${input.scopeId}:${epoch}:${fingerprint}`;

  // another identical call is running in this process: reuse its outcome
  const running = inFlight.get(flightKey);
  if (running) {
    const winner = await running;
    if (winner.guard.executionId) {
      const rec = activeExecution(input.scopeId, epoch, fingerprint);
      if (rec?.status === "SUCCEEDED") {
        console.log(`[guard] duplicate prevented (in-flight reuse) ${input.toolIdentity} scope=${input.scopeId} exec=${rec.id}`);
        return { ok: true, text: dedupPayload(rec, true), guard: { outcome: "in_flight_reused", class: cls, executionId: rec.id, status: rec.status, originalAt: rec.startedAt, originalAgentId: rec.agentId, attempt: rec.attempt, externalReference: rec.externalReference } };
      }
      if (rec?.status === "UNCERTAIN") return { ok: true, text: uncertainPayload(rec), guard: { outcome: "uncertain_blocked", class: cls, executionId: rec.id, status: rec.status, originalAt: rec.startedAt, originalAgentId: rec.agentId, attempt: rec.attempt } };
    }
    // the winner failed cleanly: fall through and claim a new attempt
  }

  const argsSummary = scrub(canonicalJson(maskSecretArgs(input.args)), input.secrets).slice(0, 2_000);
  const claimed = claim({
    scopeId: input.scopeId,
    epoch,
    agentId: input.agentId,
    toolSource: input.toolSource,
    serverName: input.serverName,
    toolName: input.toolName,
    toolIdentity: input.toolIdentity,
    fingerprint,
    idempotencyKey: `nx-${fingerprint.slice(0, 32)}`,
    class: cls,
    argsSummary,
  });

  if (claimed.kind === "existing") {
    const rec = claimed.record;
    if (rec.status === "SUCCEEDED") {
      console.log(`[guard] duplicate prevented ${input.toolIdentity} scope=${input.scopeId} exec=${rec.id} (original ${rec.startedAt})`);
      return { ok: true, text: dedupPayload(rec, false), guard: { outcome: "deduplicated", class: cls, executionId: rec.id, status: rec.status, originalAt: rec.startedAt, originalAgentId: rec.agentId, attempt: rec.attempt, externalReference: rec.externalReference } };
    }
    if (rec.status === "UNCERTAIN") {
      console.log(`[guard] uncertain outcome — not repeated ${input.toolIdentity} scope=${input.scopeId} exec=${rec.id}`);
      return { ok: true, text: uncertainPayload(rec), guard: { outcome: "uncertain_blocked", class: cls, executionId: rec.id, status: rec.status, originalAt: rec.startedAt, originalAgentId: rec.agentId, attempt: rec.attempt } };
    }
    // PENDING from this process but no in-flight promise (should not happen) or from another process: treat as uncertain
    console.log(`[guard] pending row without a live execution — treated as uncertain ${input.toolIdentity} exec=${rec.id}`);
    return { ok: true, text: uncertainPayload(rec), guard: { outcome: "uncertain_blocked", class: cls, executionId: rec.id, status: rec.status, originalAt: rec.startedAt, originalAgentId: rec.agentId, attempt: rec.attempt } };
  }

  const record = claimed.record;
  const key = `${record.idempotencyKey}-${record.attempt}`;
  const { args: finalArgs, used: providerIdempotency } = withProviderIdempotency(input.args, input.inputSchema, key);
  console.log(`[guard] side-effect execution started ${input.toolIdentity} class=${cls} scope=${input.scopeId} exec=${record.id} attempt=${record.attempt}${providerIdempotency ? " provider-idempotency" : ""}`);
  if (providerIdempotency) console.log(`[guard] provider idempotency used for ${input.toolIdentity} key=${key}`);

  const run = (async (): Promise<GuardedOutput> => {
    let r: ExecResult;
    try {
      r = await input.exec(finalArgs);
    } catch (err) {
      r = { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
    if (r.ok) {
      const summary = input.sensitiveResult ? "(sensitive result — not stored)" : scrub(r.text, input.secrets).slice(0, 4_000);
      const externalReference = input.sensitiveResult ? undefined : extractReference(summary);
      settle(record.id, { status: "SUCCEEDED", resultSummary: summary, externalReference, providerIdempotency });
      console.log(`[guard] side-effect execution succeeded ${input.toolIdentity} exec=${record.id}${externalReference ? ` ref=${externalReference}` : ""}`);
      return { ...r, guard: { outcome: "executed", class: cls, executionId: record.id, status: "SUCCEEDED", attempt: record.attempt, externalReference, providerIdempotency } };
    }
    const errText = scrub(r.text, input.secrets).slice(0, 2_000);
    if (isUncertainFailure(errText)) {
      settle(record.id, { status: "UNCERTAIN", error: errText, providerIdempotency });
      console.log(`[guard] execution uncertain ${input.toolIdentity} exec=${record.id}: ${errText.slice(0, 160)}`);
      const text = `${errText}\n\n${JSON.stringify({ status: "uncertain_outcome", executionId: record.id, message: "The request may or may not have reached the provider. It will NOT be repeated automatically: verify the external state with a read-only tool before doing anything else." })}`;
      return { ok: false, text, guard: { outcome: "executed", class: cls, executionId: record.id, status: "UNCERTAIN", attempt: record.attempt, providerIdempotency } };
    }
    settle(record.id, { status: "FAILED", error: errText, providerIdempotency });
    console.log(`[guard] execution failed ${input.toolIdentity} exec=${record.id}: ${errText.slice(0, 160)}`);
    return { ...r, text: errText, guard: { outcome: "executed", class: cls, executionId: record.id, status: "FAILED", attempt: record.attempt, providerIdempotency } };
  })();
  inFlight.set(flightKey, run);
  try {
    return await run;
  } finally {
    inFlight.delete(flightKey);
  }
}

/** Deliberate repeat inside the same scope (audited). */
export function startNewActionAttempt(scopeId: string, reason: string, agentId?: string): number {
  return bumpScopeEpoch(scopeId, reason, agentId);
}
