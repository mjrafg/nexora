/* ------------------------------------------------------------------
   Core runtime/provider/agent types.

   Agent identity is independent from its AI runtime:

     Agent → RuntimeConfig → RuntimeType → ProviderConnection → Model
   ------------------------------------------------------------------ */

import type { DeptId } from "@/lib/mock-data";

export type RuntimeType = "claude-code" | "codex" | "api";
export type ProviderType = "anthropic" | "openai" | "openrouter" | "custom";

/** How a ProviderConnection authenticates. Secrets never live on this object. */
export type AuthReference =
  | { kind: "none" } // rely on the runtime's own login (e.g. `claude` / `codex` CLI auth)
  | { kind: "env"; variable: string } // read from process.env at call time
  | { kind: "stored"; secretId: string }; // stored in the local secrets file

export type ConnectionStatus = "connected" | "not-configured" | "error" | "unknown";

export type ProviderConnection = {
  id: string;
  name: string;
  providerType: ProviderType;
  auth: AuthReference;
  baseUrl?: string;
  /** Last test result, if any. */
  status: ConnectionStatus;
  lastTestedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type AdvancedSettings = {
  maxTokens?: number;
  temperature?: number;
  /** CLI runtimes: max agentic turns per message. */
  maxTurns?: number;
  /** CLI runtimes: working directory the agent operates in. */
  workingDirectory?: string;
  /** Codex: reasoning effort override. */
  reasoningEffort?: "low" | "medium" | "high";
};

export type RuntimeConfig = {
  id: string;
  runtimeType: RuntimeType;
  providerConnectionId: string;
  model: string;
  advancedSettings: AdvancedSettings;
};

export type AgentRecord = {
  id: string;
  name: string;
  role: string;
  dept: DeptId;
  instructions: string;
  skills: string[];
  toolPermissions: string[];
  runtimeConfigId: string;
  mcpGrants: import("@/lib/mcp/types").McpGrant[];
  status: "online" | "busy" | "idle";
  /** Built-in system agents (e.g. the Capability Manager) carry a stable role marker. */
  system?: "capability-manager";
  /** who this agent reports to; an agent with direct reports IS a manager (no separate entity) */
  managerAgentId?: string | null;
  /** What the agent is blocked on — a typed reference to a real request (see @/lib/agents/waiting). */
  waitingFor?: import("@/lib/agents/waiting").AgentWaiting | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  agentId: string;
  /** the thread this message belongs to (an agent can have many) */
  chatId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  /** "system" marks messages Nexora itself injected (e.g. an automatic resume after a capability was granted). */
  origin?: "owner" | "system";
  /** Snapshot of the runtime that produced an assistant message. */
  runtime?: { runtimeType: RuntimeType; providerType: ProviderType; model: string };
  error?: string;
  /** the owner pressed Stop: the turn was cut short, it did not fail */
  stopped?: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    durationMs?: number;
    /** size of the provider's session context after this turn, as the provider reported it */
    contextTokens?: number;
    /** the provider's context window for the model that served the turn */
    contextWindow?: number;
  };
  toolCalls?: import("@/lib/mcp/types").ToolCallRecord[];
  activity?: import("@/lib/activity").ActivityEvent[];
};

export type Conversation = {
  /** the thread this provider session belongs to */
  chatId: string;
  agentId: string;
  /** Runtime-native session ids, keyed by runtime type (e.g. Claude Code session id). */
  sessions: Partial<Record<RuntimeType, string>>;
  /** logical work scope for side-effect deduplication: a new one per owner request; kept across system resumes */
  executionScopeId?: string;
  scopeStartedAt?: string;
};

/* ---------- Runtime adapter contract ---------- */

export type ResolvedRuntime = {
  config: RuntimeConfig;
  connection: ProviderConnection;
  /** Resolved secret value, or null when the runtime should use its own auth. */
  secret: string | null;
};

export type HistoryTurn = { role: ChatRole; content: string };

export type RuntimeChatRequest = {
  agent: AgentRecord;
  /** Fully rendered system prompt (identity, instructions, skills, tools). */
  systemPrompt: string;
  history: HistoryTurn[];
  message: string;
  resolved: ResolvedRuntime;
  /** Existing runtime-native session id for this agent+runtime, if any. */
  sessionId?: string;
  /** MCP tools this agent is permitted to use (already grant-filtered). */
  mcpTools: import("@/lib/mcp/types").AllowedTool[];
  /** Execute one permitted MCP tool (enforces the grant, scrubs secrets). */
  callTool: (fullName: string, args: Record<string, unknown>) => Promise<import("@/lib/mcp/types").ToolCallRecord>;
  /** Live-activity emitter for this turn. */
  emit: import("@/lib/activity").TurnEmitter;
  /** Project sessions: run in this directory instead of the agent workspace. */
  cwdOverride?: string;
  /** Project sessions: explicit built-in tool set ("builder" = full edit/exec; "reader" = read-only). */
  toolProfile?: "builder" | "reader" | "verifier";
  /** Extra stdio MCP servers to expose (e.g. the Director's orchestration tools). */
  extraServers?: ExtraMcpServer[];
  /** Steps this turn may take before it must ask the owner to continue. */
  turnBudget?: number;
  /** Skip rendering prior history into the prompt (the caller supplies a complete message). */
  freshPrompt?: boolean;
  /** Aborted when the owner stops the turn (API runtimes; CLI runtimes are killed via onSpawn). */
  abortSignal?: AbortSignal;
  /** Called with the child process so long runs can be stopped (pause). */
  onSpawn?: (kill: () => void) => void;
  /** Wall-clock limit for this turn. */
  timeoutMs?: number;
  /** mcp__<slug>__ prefixes of tool servers that record their own activity (adapters must not duplicate them). */
  silentToolPrefixes?: string[];
};

export type ExtraMcpServer = {
  slug: string;
  /** display name for activity labels */
  name?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** tool names on that server the CLI may call */
  tools: string[];
};

export type RuntimeChatResult = {
  text: string;
  sessionId?: string;
  usage?: ChatMessage["usage"];
  toolCalls?: import("@/lib/mcp/types").ToolCallRecord[];
};

export type RuntimeTestResult = {
  ok: boolean;
  message: string;
  detail?: string;
  durationMs: number;
};

export interface AgentRuntime {
  readonly type: RuntimeType;
  chat(req: RuntimeChatRequest): Promise<RuntimeChatResult>;
  test(resolved: ResolvedRuntime): Promise<RuntimeTestResult>;
}

/** The turn stopped because it ran out of steps, not because anything failed. */
export class TurnBudgetExhausted extends Error {
  constructor(public readonly limit: number) {
    super(`The task used all ${limit} steps allowed for one turn and is not finished.`);
    this.name = "TurnBudgetExhausted";
  }
}

/** The owner pressed Stop. Nothing failed; the turn simply ended early. */
export class TurnStopped extends Error {
  constructor(public readonly steps: number, public readonly lastStep?: string) {
    super("Stopped by the owner");
    this.name = "TurnStopped";
  }
}

export class RuntimeError extends Error {
  constructor(message: string, public readonly detail?: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

/** Agent + its resolved runtime, as returned by the API. */
export type OrgLink = { id: string; name: string; role: string; dept: DeptId };

/** Agent + its resolved runtime and its place in the company. */
export type AgentView = AgentRecord & {
  /** the waiting state resolved against its backing request (null when there is none, or it is stale) */
  waiting: import("@/lib/agents/waiting").AgentWaitingView | null;
  /** who they report to, and who reports to them — an agent with reports is a manager */
  manager: OrgLink | null;
  reports: OrgLink[];
  runtime: RuntimeConfig;
  connection: Pick<ProviderConnection, "id" | "name" | "providerType" | "status" | "baseUrl">;
};
