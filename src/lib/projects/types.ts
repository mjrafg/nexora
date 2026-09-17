/* ------------------------------------------------------------------
   Project Director engine types — an independent port/adaptation of
   Tandem's project orchestration (Tandem itself is never modified).

   A Project is a git directory + a goal. A Director agent plans milestones,
   decomposes them into Sessions just in time, launches Builder agents from the
   Engineering department in isolated worktrees, has each result judged by an
   independent Reviewer (two review rounds, one final repair), integrates,
   delivers, and completes.
   ------------------------------------------------------------------ */

export type ProjectState = "PLANNING" | "RUNNING" | "PAUSING" | "PAUSED" | "RESUMING" | "COMPLETED" | "NEEDS_USER" | "FAILED";

export type MilestoneStatus = "planned" | "running" | "integrating" | "completed";

export type SessionStatus =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "needs_attention"
  | "paused"
  | "abandoned";

export type ReviewVerdict = "pass" | "findings";

export type Finding = {
  severity: "major" | "minor";
  title: string;
  file?: string;
  line?: number;
  detail: string;
  recommendation?: string;
};

export type ProjectRecord = {
  id: string;
  title: string;
  /** absolute directory on this server */
  rootPath: string;
  goal: string;
  state: ProjectState;
  /** agents (ids) — identity is independent of their runtime */
  directorAgentId: string;
  builderAgentId: string;
  /** reviewer: an agent id (independent session, read-only tools) */
  reviewerAgentId: string;
  integrationBranch: string | null;
  baseBranch: string | null;
  planSummary: string | null;
  /** 0 = no plan review pending; 1..3 = round awaiting/being reviewed */
  planReviewRound: number;
  pendingRecovery: PendingRecovery | null;
  /** runtime-native session id of the Director's CLI conversation, per runtime */
  directorSessions: Partial<Record<string, string>>;
  createdAt: string;
  updatedAt: string;
};

export type PendingRecovery = {
  sessionKey: string;
  action: "continue" | "restart" | "abandon" | "wait";
  reasoning: string;
  newPrompt?: string;
  extraMinutes?: number;
  round: number;
  context: string;
  awaitingRevision?: boolean;
};

export type MilestoneRecord = {
  id: string;
  projectId: string;
  key: string;
  name: string;
  goal: string;
  acceptance: string;
  status: MilestoneStatus;
  orderIdx: number;
  dependsOn: string[];
};

export type SessionGrant = {
  /** native permission ids, already checked against the owner's ceiling */
  tools: string[];
  /** MCP server ids someone on this project was already trusted with */
  servers: string[];
  grantedAt: string;
  grantedBy: string;
};

export type SessionRecord = {
  id: string;
  projectId: string;
  milestoneId: string;
  key: string;
  name: string;
  purpose: string;
  /** the self-contained contract given to the Builder */
  prompt: string;
  status: SessionStatus;
  dependsOn: string[];
  /** isolated sessions get their own branch + worktree */
  branch: string | null;
  cwd: string | null;
  /** Builder agent chosen by the Director (null = project default) */
  agentId: string | null;
  /**
   * Permissions and tool servers the Director gave this session. Scoped to
   * the session: the agent keeps nothing when it ends.
   */
  grants?: SessionGrant | null;
  /**
   * What each role could actually reach on this session's turns.
   *
   * Not the agent's permanent permissions: the set the engine attached and
   * described, after the Reviewer's narrowing and the Director's grant. This
   * is the record that answers "was it told it had something it could not
   * call?" — the question that had no answer when a Builder was promised a
   * browser its turn never received.
   */
  capabilities?: { builder: string[]; reviewer: string[] } | null;
  /** skills the Director chose for this session's Builder, and for its Reviewer */
  skills?: import("@/lib/skills/types").SkillSelection | null;
  reviewerSkills?: import("@/lib/skills/types").SkillSelection | null;
  /** the runtime-native session id of the Builder's conversation (for repairs/resume) */
  builderSessionId: string | null;
  /** the immutable request the Reviewer judges against (ported ledger semantics) */
  originalRequest: string;
  reviewsConsumed: number;
  finalRepairDone: boolean;
  lastVerdict: ReviewVerdict | null;
  lastFindings: Finding[];
  resultSummary: string | null;
  /** what this session's turns actually cost, when the runtime reports it */
  tokens?: { input: number; output: number; turns: number };
  /**
   * What the agents actually did, kept with the session.
   *
   * The live bus is an in-memory ring: close the process and every command,
   * file change and tool call a build made is gone. A chat keeps its steps on
   * the assistant message; a session had nowhere to keep them, so finished work
   * could only ever be inspected through its summary.
   */
  steps?: import("@/lib/activity").ActivityEvent[];
  stopReason: "user_stop" | "project_pause" | "restart" | null;
  errorText: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

export type ActivityKind = "plan" | "decision" | "session" | "integration" | "recovery" | "state" | "review" | "delivery";

export type ProjectActivity = {
  id: string;
  projectId: string;
  ts: number;
  kind: ActivityKind;
  text: string;
  detail?: string | null;
  /**
   * What an agent did to produce this line, when one did.
   *
   * A plan or recovery review is a real turn by the Reviewer, but it belongs to
   * no session and to no Director reply — so its steps had nowhere to live and
   * the record showed a verdict with nothing behind it.
   */
  steps?: import("@/lib/activity").ActivityEvent[];
};

/** Director ↔ owner conversation entries (the Project Chat). */
export type ProjectMessage = {
  id: string;
  projectId: string;
  role: "user" | "assistant" | "observation";
  content: string;
  createdAt: string;
  toolCalls?: { tool: string; ok: boolean; summary: string }[];
  usage?: { inputTokens?: number; outputTokens?: number };
  /** what the Director did to produce this reply — its own steps, kept */
  activity?: import("@/lib/activity").ActivityEvent[];
  error?: string;
};

/* ---- views ---- */

export type MilestoneView = MilestoneRecord & { sessions: SessionRecord[] };
export type ProjectView = ProjectRecord & {
  milestones: MilestoneView[];
  directorAgentName: string;
  builderAgentName: string;
  reviewerAgentName: string;
  counts: { sessions: number; running: number; completed: number };
  /** agents holding a turn at this instant — what "is it actually working?" means */
  busy: { name: string; role: string }[];
  /** the sessions currently executing */
  runningKeys: string[];
};

/* ---- director tool inputs ---- */

export type MilestoneInput = { key: string; name: string; goal: string; acceptance: string; dependsOn: string[] };
export type SessionInput = { key: string; name: string; purpose: string; prompt: string; dependsOn: string[]; isolated: boolean; agentId?: string | null; skills?: string[]; reviewerSkills?: string[]; grantTools?: string[]; grantServers?: string[] };
