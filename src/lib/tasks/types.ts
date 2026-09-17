/* ------------------------------------------------------------------
   Company work.

   A Task is general company work — "research competitor pricing", "reply
   to the customer", "fix the login issue". It is NOT a Tandem project
   session: a session is an engineering execution unit inside a project,
   and an agent may choose to run one while carrying out a Task. The two
   stay separate on purpose.
   ------------------------------------------------------------------ */

export type TaskStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "CANCELLED";
export type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

export const PRIORITIES: TaskPriority[] = ["CRITICAL", "HIGH", "NORMAL", "LOW"];
/** Queue order: urgency first, then whoever has waited longest. */
export const PRIORITY_RANK: Record<TaskPriority, number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

export type TaskRecord = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** the agent that created it (a manager delegating), when it was not the owner */
  createdByAgentId?: string | null;
  createdByOwner: boolean;
  assignedToAgentId: string | null;
  /** who is accountable for it — normally the assignee's manager at assignment time */
  managerAgentId?: string | null;
  /** what the agent achieved, in its own words */
  resultSummary?: string | null;
  /** optional structured detail the agent chose to record (tests passed, files, links) */
  result?: Record<string, unknown> | null;
  blockedReason?: string | null;
  /** the conversation the work is being carried out in */
  chatId?: string | null;
  /**
   * The work this was delegated out of. A root task is the objective some-
   * body was actually given; its children are the pieces handed to other
   * people. One level of this is enough to follow a company objective from
   * the owner's sentence to the person who did the work.
   */
  parentTaskId?: string | null;
  /**
   * The conversation this work came out of — where the owner asked for it.
   * The outcome is reported back HERE, so the person who asked never has to
   * go looking for it, or ask whether it finished.
   */
  originChatId?: string | null;
  /**
   * The folder the agent works in. Absolute, and it must exist. Without one
   * the agent uses its own private workspace; with one, its CLI runtime runs
   * there — which is how a task gets a real repository or project directory.
   */
  workingDirectory?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt: string;
};

/** Lightweight history: what happened to this task, and who did it. */
export type TaskEventKind =
  | "created" | "assigned" | "reassigned" | "started" | "note"
  | "blocked" | "unblocked" | "completed" | "cancelled" | "priority" | "updated" | "recovered";

export type TaskEvent = {
  id: string;
  taskId: string;
  kind: TaskEventKind;
  text: string;
  /** the agent this event is about, when it is about one */
  agentId?: string | null;
  by: "owner" | "agent" | "system";
  at: string;
};

/** What a piece of delegated work looks like from its parent. */
export type TaskLink = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedTo: { id: string; name: string; role: string } | null;
  resultSummary?: string | null;
  blockedReason?: string | null;
};

/** Task plus the names the UI and the agents need, never ids alone. */
export type TaskView = TaskRecord & {
  assignedTo: { id: string; name: string; role: string; dept: string } | null;
  manager: { id: string; name: string; role: string } | null;
  createdBy: { id: string; name: string } | null;
  parent: TaskLink | null;
  children: TaskLink[];
  /**
   * IN_PROGRESS but nothing of its own is running: the person holding it has
   * delegated and is waiting to hear back. Derived, never stored — a stored
   * copy is a copy that goes stale.
   */
  waitingForTeam: boolean;
};

/** One direct report, as a manager sees them. */
export type TeamMember = {
  agentId: string;
  name: string;
  role: string;
  dept: string;
  /** WORKING while a task is in progress or a turn is running, else IDLE */
  status: "WORKING" | "IDLE" | "BLOCKED" | "WAITING";
  activeTasks: number;
  pendingTasks: number;
  blockedTasks: number;
  currentTask?: string;
  /** what the agent is waiting on, when it is waiting (credential, capability…) */
  waitingFor?: string;
  /** what this person can actually do — the reason to pick them, or not */
  skills: string[];
  /** the access they already hold, in the owner's words ("Company Profile", "Browser") */
  tools: string[];
};
