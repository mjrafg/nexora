/* ------------------------------------------------------------------
   Runtime registry + execution service.

     Owner message → load Agent → instructions/skills/tools
       → runtime config → provider connection + model → execute
   ------------------------------------------------------------------ */

import { departments } from "@/lib/mock-data";
import { getSecret, newId, now, readDb, updateDb } from "@/lib/store/db";
import { apiRuntime } from "./adapters/api";
import { claudeCodeRuntime } from "./adapters/claude-code";
import { codexRuntime } from "./adapters/codex";
import { PROVIDERS, RUNTIMES, TOOL_CATALOG } from "./catalog";
import type {
  AgentRecord,
  AgentRuntime,
  AgentView,
  ChatMessage,
  ExtraMcpServer,
  HistoryTurn,
  ProviderConnection,
  ResolvedRuntime,
  RuntimeChatResult,
  RuntimeConfig,
  RuntimeTestResult,
  RuntimeType,
} from "./types";
import type { AllowedTool, ToolCallRecord } from "@/lib/mcp/types";
import type { TurnEmitter } from "@/lib/activity";
import { RuntimeError, TurnBudgetExhausted, TurnStopped } from "./types";
import { registerTurn, releaseTurn, wasStopped } from "./stop";
import { autoTitle, chatForSend, chatMessages, touchChat } from "@/lib/chats/store";
import { TURN_BUDGET } from "./budget";
import { recentActivity, turnEmitter } from "@/lib/activity";
import { resolveAgentWaiting } from "@/lib/agents/waiting";
import { randomUUID } from "node:crypto";
import { toolBundle } from "@/lib/tools/bundle";
import type { InternalToolServer } from "@/lib/tools/internal";
import { serversForAgent } from "@/lib/tools/servers";
import { getPrompt, renderPrompt } from "@/lib/prompts";
import { pokeOffice } from "@/lib/office/floor";
import { directReports } from "@/lib/tasks/store";

const REGISTRY: Record<RuntimeType, AgentRuntime> = {
  "claude-code": claudeCodeRuntime,
  codex: codexRuntime,
  api: apiRuntime,
};

export function getRuntime(type: RuntimeType): AgentRuntime {
  const rt = REGISTRY[type];
  if (!rt) throw new RuntimeError(`Unknown runtime type: ${type}`);
  return rt;
}

/* ---------- resolution ---------- */

export function resolveSecret(conn: ProviderConnection): string | null {
  switch (conn.auth.kind) {
    case "env":
      return process.env[conn.auth.variable]?.trim() || null;
    case "stored":
      return getSecret(conn.auth.secretId);
    default:
      return null;
  }
}

export function validateCombination(runtimeType: RuntimeType, conn: ProviderConnection) {
  const rt = RUNTIMES[runtimeType];
  if (!rt) throw new RuntimeError(`Unknown runtime type: ${runtimeType}`);
  if (!rt.providers.includes(conn.providerType)) {
    throw new RuntimeError(
      `${rt.label} cannot run through ${PROVIDERS[conn.providerType].label}`,
      `Supported providers: ${rt.providers.map((p) => PROVIDERS[p].label).join(", ")}`
    );
  }
}

export function resolveRuntime(config: RuntimeConfig): ResolvedRuntime {
  const db = readDb();
  const connection = db.providerConnections.find((c) => c.id === config.providerConnectionId);
  if (!connection) throw new RuntimeError("Provider connection not found", config.providerConnectionId);
  validateCombination(config.runtimeType, connection);
  if (!config.model?.trim()) throw new RuntimeError("Model is required");
  return { config, connection, secret: resolveSecret(connection) };
}

/* ---------- prompt assembly ---------- */

export function buildSystemPrompt(agent: AgentRecord): string {
  const dept = departments[agent.dept];
  const tools = agent.toolPermissions
    .map((id) => TOOL_CATALOG.find((t) => t.id === id))
    .filter(Boolean)
    .map((t) => `- ${t!.label}: ${t!.description}`);
  const parts = [
    `# Identity`,
    `Name: ${agent.name}`,
    `Role: ${agent.role}`,
    `Department: ${dept?.name ?? agent.dept}`,
    ``,
    `# Instructions`,
    agent.instructions.trim(),
  ];
  if (agent.skills.length) parts.push(``, `# Skills`, agent.skills.map((s) => `- ${s}`).join("\n"));
  if (tools.length) parts.push(``, `# Tool permissions granted by the owner`, tools.join("\n"));
  parts.push(``, getPrompt("agent-autonomy-rule"));
  if (agent.toolPermissions.includes("credentials") || agent.toolPermissions.includes("credentials_manage")) parts.push(``, getPrompt("credential-handling-rule"));
  if (agent.toolPermissions.includes("payments_use") || agent.toolPermissions.includes("payments_manage")) parts.push(``, getPrompt("payment-handling-rule"));
  if (agent.toolPermissions.includes("company_profile") || agent.toolPermissions.includes("company_profile_manage") || agent.toolPermissions.includes("company_custom_data_manage") || agent.system === "capability-manager") parts.push(``, getPrompt("company-profile-rule"));
  if (agent.toolPermissions.includes("browser")) parts.push(``, getPrompt("browser-behavior-rule"));
  if (agent.toolPermissions.includes("company_profile_manage")) parts.push(getPrompt("company-profile-write-rule"));
  // everyone carries company work; an agent with people reporting to it also
  // manages — and that rule goes LAST, because it decides whether the rules
  // above ("do it yourself", "get the access you need") are even addressed to it
  const reports = directReports(agent.id);
  parts.push(``, getPrompt("task-execution-rule"));
  if (agent.system === "capability-manager") parts.push(``, getPrompt("capability-manager-playbook"));
  else parts.push(``, `# Missing capabilities`, getPrompt(reports.length ? "manager-capability-note" : "request-capability-note"));
  if (reports.length) {
    parts.push(``, getPrompt("manager-management-rule"), ``, getPrompt("delegation-rule"));
    // managers of managers run the company's work rather than a department's
    const leads = reports.filter((r) => directReports(r.id).length);
    if (leads.length) parts.push(``, getPrompt("ceo-coordination-rule"));
    parts.push(``, `Your direct reports: ${reports.map((r) => `${r.name} (${r.role})${directReports(r.id).length ? ` — manages ${directReports(r.id).length}` : ""}`).join(", ")}.`);
  }
  parts.push(``, renderPrompt("agent-closing-line", { name: agent.name }));
  return parts.join("\n");
}

/* ---------- views ---------- */

export function toAgentView(agent: AgentRecord): AgentView {
  const db = readDb();
  // validated against the backing request: a stale reference renders as "not waiting"
  const waiting = resolveAgentWaiting(agent);
  const runtime = db.runtimeConfigs.find((r) => r.id === agent.runtimeConfigId);
  if (!runtime) throw new RuntimeError("Runtime config missing for agent", agent.id);
  const conn = db.providerConnections.find((c) => c.id === runtime.providerConnectionId);
  const reports = directReports(agent.id);
  const manager = agent.managerAgentId ? db.agents.find((a) => a.id === agent.managerAgentId) : undefined;
  return {
    ...agent,
    waiting,
    manager: manager ? { id: manager.id, name: manager.name, role: manager.role, dept: manager.dept } : null,
    reports: reports.map((r) => ({ id: r.id, name: r.name, role: r.role, dept: r.dept })),
    runtime,
    connection: conn
      ? { id: conn.id, name: conn.name, providerType: conn.providerType, status: conn.status, baseUrl: conn.baseUrl }
      : { id: runtime.providerConnectionId, name: "(missing connection)", providerType: "custom", status: "error" },
  };
}

/* ---------- chat execution ---------- */

/** One thread's transcript, as the runtime sees it. */
export function historyFor(chatId: string): HistoryTurn[] {
  return chatMessages(chatId)
    .filter((m) => !m.error)
    .map((m) => ({ role: m.role, content: m.content }));
}

export type SendOptions = {
  /** which conversation thread the message belongs to (default: the thread that owns the scope, else the newest) */
  chatId?: string;
  /** run the turn in this folder instead of the agent's own workspace (a task pinned to a directory) */
  cwd?: string;
  /** who authored the message: the owner (default) or Nexora itself (auto-resume, manager wake-ups) */
  origin?: "owner" | "system";
  /** capability request this message concerns (for the Capability Manager's own chat) */
  requestId?: string;
  /**
   * Logical work scope for side-effect deduplication. Owner messages start a
   * new scope; system messages (auto-resume) continue the scope they name,
   * else the conversation's current one.
   */
  scopeId?: string;
};

/** Resolve (and persist) the execution scope for this message. */
function scopeForMessage(agentId: string, chatId: string, opts: SendOptions): string {
  return updateDb((d) => {
    let conv = d.conversations.find((c) => c.chatId === chatId);
    if (!conv) {
      conv = { chatId, agentId, sessions: {} };
      d.conversations.push(conv);
    }
    if (opts.scopeId) conv.executionScopeId = opts.scopeId;
    else if (opts.origin !== "system" || !conv.executionScopeId) {
      conv.executionScopeId = `chat:${chatId}:${randomUUID().slice(0, 8)}`;
      conv.scopeStartedAt = now();
    }
    return conv.executionScopeId;
  });
}

/** The scope an agent's most recent conversation is in (what request_capability captures). */
export function currentScopeId(agentId: string): string | undefined {
  return readDb()
    .conversations.filter((c) => c.agentId === agentId)
    .map((c) => c.executionScopeId)
    .filter(Boolean)
    .at(-1);
}

// one turn at a time per agent: a system resume must never interleave with an in-flight owner turn
const agentQueues = new Map<string, Promise<unknown>>();

export function sendAgentMessage(agentId: string, text: string, opts: SendOptions = {}): Promise<{ user: ChatMessage; assistant: ChatMessage }> {
  const prev = agentQueues.get(agentId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => sendAgentMessageNow(agentId, text, opts));
  agentQueues.set(agentId, run.catch(() => undefined));
  return run;
}

async function sendAgentMessageNow(agentId: string, text: string, opts: SendOptions): Promise<{ user: ChatMessage; assistant: ChatMessage }> {
  const db = readDb();
  const agent = db.agents.find((a) => a.id === agentId);
  if (!agent) throw new RuntimeError("Agent not found", agentId);
  const config = db.runtimeConfigs.find((r) => r.id === agent.runtimeConfigId);
  if (!config) throw new RuntimeError("Runtime config missing for agent", agentId);

  const resolved = resolveRuntime(config);
  const runtime = getRuntime(config.runtimeType);
  // the thread this message belongs to: the one named, the one that owns the
  // scope being resumed, or the agent's most recent one
  const chat = chatForSend(agentId, opts);
  const chatId = chat.id;
  if (opts.origin !== "system") autoTitle(chatId, text);
  // a full session is compacted by its own provider before the turn, never by Nexora
  await autoCompactBeforeTurn(chatId);
  const history = historyFor(chatId);
  const conversation = readDb().conversations.find((c) => c.chatId === chatId);
  const sessionId = conversation?.sessions[config.runtimeType];

  const user: ChatMessage = { id: newId(), agentId, chatId, role: "user", content: text, createdAt: now(), ...(opts.origin === "system" ? { origin: "system" as const } : {}) };
  const snapshot = { runtimeType: config.runtimeType, providerType: resolved.connection.providerType, model: config.model };
  const turnId = randomUUID();
  const emit = turnEmitter(agentId, turnId);
  const turnStart = Date.now();
  const runtimeLabel = RUNTIMES[config.runtimeType]?.label ?? config.runtimeType;
  const askId = emit.start("model", `Asked ${runtimeLabel}`, undefined, config.model);
  // the owner can stop this turn from the chat: the registry holds the kill handle
  const live = registerTurn(agentId, chatId, turnId);
  pokeOffice("turn:started", agentId);

  // Every tool (Nexora's own + granted MCP) goes through the Tool Runner → side-effect guard, on every runtime
  const isCli = config.runtimeType !== "api";
  const scopeId = scopeForMessage(agentId, chatId, opts);
  const bundle = toolBundle(agent, { agentId, turnId, emit, scopeId, chatId }, serversForAgent(agent));
  const mcpTools = isCli ? [] : bundle.tools;
  const callTool = bundle.call;

  // how many steps this turn may take before the owner is asked to extend it
  const budget = await turnBudgetFor(agentId, scopeId);
  let assistant: ChatMessage;
  try {
    const result = await runtime.chat({
      agent,
      systemPrompt: buildSystemPrompt(agent),
      history,
      message: text,
      resolved,
      sessionId,
      mcpTools,
      callTool,
      emit,
      extraServers: isCli ? bundle.extraServers : undefined,
      silentToolPrefixes: bundle.silentToolPrefixes,
      turnBudget: budget.limit,
      cwdOverride: opts.cwd ?? folderForScope(scopeId),
      onSpawn: (kill) => { live.kill = kill; if (live.stopped) kill(); },
      abortSignal: live.controller.signal,
    });
    if (live.stopped) throw new TurnStopped(0);
    await clearGrant(agentId, scopeId);
    emit.finish(askId, "model", `Asked ${runtimeLabel}`, { meta: config.model, status: "done" });
    const activity = recentActivity(agentId, turnStart).filter((e) => e.turnId === turnId);
    assistant = { id: newId(), agentId, chatId, role: "assistant", content: result.text, createdAt: now(), runtime: snapshot, usage: result.usage, toolCalls: result.toolCalls?.map(stripImages), activity };
    updateDb((d) => {
      d.messages.push(user, assistant);
      if (result.sessionId) {
        let conv = d.conversations.find((c) => c.chatId === chatId);
        if (!conv) {
          conv = { chatId, agentId, sessions: {} };
          d.conversations.push(conv);
        }
        conv.sessions[config.runtimeType] = result.sessionId;
      }
    });
  } catch (err) {
    // the owner pressed Stop: the turn ended early, nothing failed
    if (err instanceof TurnStopped || wasStopped(agentId, turnId)) {
      emit.finish(askId, "model", `Asked ${runtimeLabel}`, { meta: config.model, status: "done" });
      const activity = recentActivity(agentId, turnStart).filter((ev) => ev.turnId === turnId);
      const steps = activity.filter((e) => e.kind === "tool" || e.kind === "command" || e.kind === "browser" || e.kind === "file").length;
      const step = [...activity].reverse().find((e) => e.kind === "browser" || e.kind === "tool" || e.kind === "command")?.title;
      assistant = {
        id: newId(), agentId, chatId, role: "assistant", createdAt: now(), runtime: snapshot, activity, stopped: true,
        content: `Stopped by you${steps ? ` after ${steps} step${steps === 1 ? "" : "s"}` : ""}.${step ? ` I was in the middle of: ${step}.` : ""} Nothing further was done — tell me how to continue and I pick up from here.`,
      };
      updateDb((d) => { d.messages.push(user, assistant); });
      bundle.release();
      releaseTurn(agentId, turnId);
      touchChat(chatId);
      return { user, assistant };
    }
    // running out of steps is not a failure: the work is unfinished and the
    // owner decides whether it continues (see owner-actions/turn budget)
    if (err instanceof TurnBudgetExhausted) {
      emit.finish(askId, "model", `Asked ${runtimeLabel}`, { meta: config.model, status: "done" });
      const activity = recentActivity(agentId, turnStart).filter((ev) => ev.turnId === turnId);
      const step = [...activity].reverse().find((e) => e.kind === "browser" || e.kind === "tool")?.title;
      assistant = {
        id: newId(), agentId, chatId, role: "assistant", createdAt: now(), runtime: snapshot, activity,
        content: `I paused after ${err.limit} steps — the task is not finished.${step ? ` Last step: ${step}.` : ""} I asked you in **Needs You** whether to continue; nothing is lost and I pick up exactly where I stopped.`,
      };
      updateDb((d) => { d.messages.push(user, assistant); });
      void askToContinue(agent, scopeId, err.limit, step).catch((e) => console.error("[turn-budget] could not ask the owner:", e));
      bundle.release();
      releaseTurn(agentId, turnId);
      touchChat(chatId);
      return { user, assistant };
    }
    const e = err instanceof RuntimeError ? err : new RuntimeError("Runtime failed", String(err));
    emit.finish(askId, "model", `Asked ${runtimeLabel}`, { meta: config.model, status: "failed" });
    emit.event({ kind: "result", title: "Failed", detail: e.message, status: "failed" });
    const activity = recentActivity(agentId, turnStart).filter((ev) => ev.turnId === turnId);
    assistant = {
      id: newId(),
      agentId,
      chatId,
      role: "assistant",
      content: e.detail ? `${e.message}\n${e.detail}` : e.message,
      createdAt: now(),
      runtime: snapshot,
      error: e.message,
      activity,
    };
    updateDb((d) => {
      d.messages.push(user, assistant);
    });
  } finally {
    bundle.release();
    releaseTurn(agentId, turnId);
    touchChat(chatId);
    pokeOffice("turn:ended", agentId);
  }
  return { user, assistant };
}

/**
 * Work pinned to a folder must come back to that folder on every wake — a
 * capability or credential resume carries the task's scope but knows nothing
 * about directories, so the folder is resolved from the scope itself.
 */
function folderForScope(scopeId: string | undefined): string | undefined {
  if (!scopeId?.startsWith("task:")) return undefined;
  const taskId = scopeId.slice("task:".length).split(":")[0];
  try {
    const dir = readDb().tasks.find((t) => t.id === taskId)?.workingDirectory;
    return dir ?? undefined;
  } catch {
    return undefined;
  }
}

/** Provider-native compaction before a turn, when the thread is full enough to need it. */
async function autoCompactBeforeTurn(chatId: string): Promise<void> {
  try {
    const { autoCompactIfNeeded } = await import("@/lib/chats/compact");
    await autoCompactIfNeeded(chatId);
  } catch (err) {
    console.warn("[context] auto-compaction check failed:", err);
  }
}

/* ---------------------------------------------------------------- turn budget */

export { TURN_BUDGET } from "./budget";

/** Steps per turn: the company default, plus whatever the owner granted this task. */
async function turnBudgetFor(agentId: string, scopeId?: string): Promise<{ limit: number; base: number; granted: number }> {
  const base = TURN_BUDGET.approveAt;
  let granted = 0;
  try {
    const { takeTurnGrant } = await import("@/lib/owner-actions/service");
    granted = takeTurnGrant(agentId, scopeId);
  } catch { /* first boot */ }
  return { limit: base + granted, base, granted };
}

async function clearGrant(agentId: string, scopeId?: string): Promise<void> {
  try {
    const { clearTurnGrant } = await import("@/lib/owner-actions/service");
    clearTurnGrant(agentId, scopeId);
  } catch { /* nothing granted */ }
}

/** Ask the owner whether a long task should keep going, with what it was doing. */
async function askToContinue(agent: AgentRecord, scopeId: string | undefined, used: number, step?: string): Promise<void> {
  const { createOwnerAction } = await import("@/lib/owner-actions/service");
  await createOwnerAction({
    agentId: agent.id,
    kind: "turn_budget",
    title: `${agent.name} used ${used} steps and is still working`,
    reason: `The task is unfinished after ${used} steps.${step ? ` Its last step was: ${step}.` : ""} Continuing resumes the same task exactly where it stopped.`,
    blocking: true,
    taskId: scopeId,
    dedupeKey: `turn_budget:${scopeId ?? agent.id}`,
    payload: {
      turns: { used, limit: used, grant: TURN_BUDGET.grant, step },
      choices: [
        { value: "continue", label: `Continue (+${TURN_BUDGET.grant} steps)`, style: "primary" },
        { value: "until_done", label: "Allow until the task completes" },
        { value: "stop", label: "Stop the task", style: "danger" },
      ],
    },
  });
}

/** persisted tool-call records never carry image bytes or sensitive results (payment details) */
function stripImages(tc: ToolCallRecord): ToolCallRecord {
  const rest = { ...tc };
  delete rest.images;
  if (rest.sensitive && rest.ok) rest.result = "(sensitive payment details — not stored)";
  return rest;
}

/* ---------- test ---------- */

export async function testRuntimeConfig(input: {
  runtimeType: RuntimeType;
  providerConnectionId: string;
  model: string;
  advancedSettings?: RuntimeConfig["advancedSettings"];
}): Promise<RuntimeTestResult> {
  const started = Date.now();
  try {
    const config: RuntimeConfig = {
      id: "_test",
      runtimeType: input.runtimeType,
      providerConnectionId: input.providerConnectionId,
      model: input.model,
      advancedSettings: input.advancedSettings ?? {},
    };
    const resolved = resolveRuntime(config);
    const result = await getRuntime(config.runtimeType).test(resolved);
    updateDb((d) => {
      const conn = d.providerConnections.find((c) => c.id === input.providerConnectionId);
      if (conn) {
        conn.status = result.ok ? "connected" : "error";
        conn.lastTestedAt = now();
        conn.lastError = result.ok ? undefined : `${result.message}${result.detail ? ` — ${result.detail}` : ""}`;
        conn.updatedAt = now();
      }
    });
    return result;
  } catch (err) {
    const e = err instanceof RuntimeError ? err : new RuntimeError("Test failed", String(err));
    return { ok: false, message: e.message, detail: e.detail, durationMs: Date.now() - started };
  }
}

/* ---------- parameterized turn (used by the Project Director engine) ---------- */

export type AgentTurnInput = {
  agentId: string;
  /** logical work scope for side-effect deduplication (default: this turn) */
  scopeId?: string;
  systemPrompt: string;
  message: string;
  history?: HistoryTurn[];
  /** runtime-native session id to resume (Builder repairs, Director continuity) */
  sessionId?: string;
  cwdOverride?: string;
  toolProfile?: "builder" | "reader";
  /** stdio MCP servers for CLI runtimes (e.g. the Director's tools) */
  extraServers?: ExtraMcpServer[];
  /** in-app tools for the API runtime (same tools as extraServers, executed in-process) */
  extraTools?: { tools: AllowedTool[]; call: (fullName: string, args: Record<string, unknown>) => Promise<ToolCallRecord> };
  includeGrantedMcp?: boolean;
  /** Nexora internal tool servers to expose on this turn (browser, capability requests…) */
  servers?: InternalToolServer[];
  emit: TurnEmitter;
  timeoutMs?: number;
  onSpawn?: (kill: () => void) => void;
  freshPrompt?: boolean;
};

/** Which runtime an agent is on (for callers that need CLI-only behavior). */
export function agentRuntimeType(agentId: string): RuntimeType | null {
  const db = readDb();
  const agent = db.agents.find((a) => a.id === agentId);
  const cfg = agent && db.runtimeConfigs.find((r) => r.id === agent.runtimeConfigId);
  return cfg?.runtimeType ?? null;
}

export async function runAgentTurn(input: AgentTurnInput): Promise<RuntimeChatResult> {
  const db = readDb();
  const agent = db.agents.find((a) => a.id === input.agentId);
  if (!agent) throw new RuntimeError("Agent not found", input.agentId);
  const config = db.runtimeConfigs.find((r) => r.id === agent.runtimeConfigId);
  if (!config) throw new RuntimeError("Runtime config missing for agent", agent.id);
  const resolved = resolveRuntime(config);
  const runtime = getRuntime(config.runtimeType);
  const isCli = config.runtimeType !== "api";
  const extra = input.extraTools;
  const scopeId = input.scopeId ?? `turn:${input.emit.turnId}`;
  // granted MCP + Nexora servers go through the runner (guarded); the Director's engine tools keep their own path
  const bundle = toolBundle(agent, { agentId: agent.id, turnId: input.emit.turnId, emit: input.emit, scopeId }, input.servers ?? [], { includeGrantedMcp: input.includeGrantedMcp !== false });
  const mcpTools = isCli ? [] : [...(extra?.tools ?? []), ...bundle.tools];
  const callTool = async (fullName: string, args: Record<string, unknown>) => {
    if (extra && extra.tools.some((t) => t.fullName === fullName)) return extra.call(fullName, args);
    return bundle.call(fullName, args);
  };
  // A project turn is work like any other: register it so the agent shows as
  // working on the floor and in the header, and so the owner can stop it. This
  // used to be done only on the chat path, which is why a Builder could run for
  // twenty minutes while the whole app reported it idle.
  const live = registerTurn(agent.id, input.scopeId ?? `turn:${input.emit.turnId}`, input.emit.turnId);
  pokeOffice("turn:started", agent.id);
  try {
  const result = await runtime.chat({
    agent,
    systemPrompt: input.systemPrompt,
    history: input.history ?? [],
    message: input.message,
    resolved,
    sessionId: input.sessionId,
    mcpTools,
    callTool,
    emit: input.emit,
    cwdOverride: input.cwdOverride,
    toolProfile: input.toolProfile,
    extraServers: isCli ? [...(input.extraServers ?? []), ...bundle.extraServers] : undefined,
    silentToolPrefixes: bundle.silentToolPrefixes,
    freshPrompt: input.freshPrompt,
    // keep the caller's own onSpawn working while giving the registry the kill handle
    onSpawn: (kill) => { live.kill = kill; if (live.stopped) kill(); input.onSpawn?.(kill); },
    abortSignal: live.controller.signal,
    timeoutMs: input.timeoutMs,
  });
  if (live.stopped) throw new TurnStopped(0);
  return result;
  } catch (err) {
    // an owner who pressed Stop did not encounter a failure; say so, so the
    // caller can record it as stopped work rather than broken work
    if (live.stopped || wasStopped(agent.id, input.emit.turnId)) throw new TurnStopped(0);
    throw err;
  } finally {
    releaseTurn(agent.id, input.emit.turnId);
    pokeOffice("turn:ended", agent.id);
    bundle.release();
  }
}
