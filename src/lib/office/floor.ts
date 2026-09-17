/* ------------------------------------------------------------------
   The floor, as it actually is.

   The office picture is a view of Nexora, not a simulation of one. Every
   avatar on it is a real agent with a real id; every label under one is
   derived from execution state that something else already owns — the
   turn registry, the task queue, the waiting record — and never from a
   guess, a random seed or a model call.

   The distinction that matters most here: a task being IN_PROGRESS does
   NOT mean a model is running. An agent can hold a task and be parked on
   a login, waiting for the owner to approve money, waiting for its own
   team, or simply stopped. Each of those is a different thing to show.
   ------------------------------------------------------------------ */

import { readDb } from "@/lib/store/db";
import { emitActivity } from "@/lib/activity";
import { isAgentBusy } from "@/lib/runtime/stop";
import { resolveAgentWaiting } from "@/lib/agents/waiting";
import { departments, type DeptId } from "@/lib/mock-data";
import { OPEN_STATUSES, childTasks, listTasks } from "@/lib/tasks/store";
import type { TaskRecord } from "@/lib/tasks/types";

/** The activity channel the office listens on — the existing bus, one more subject. */
export const OFFICE_CHANNEL = "office";

export type FloorState =
  | "WORKING"
  | "WAITING_TEAM"
  | "WAITING_CAPABILITY"
  | "WAITING_LOGIN"
  | "WAITING_INFO"
  | "WAITING_APPROVAL"
  | "WAITING_OWNER"
  | "BROWSER"
  | "BLOCKED"
  | "STALLED"
  | "IDLE";

export type FloorAgent = {
  id: string;
  name: string;
  role: string;
  dept: DeptId;
  system?: string;
  managerId: string | null;
  managerName: string | null;
  reports: number;
  state: FloorState;
  /** what to say under the avatar, in the owner's words */
  label: string;
  /** where the owner can act on it, when there is somewhere */
  href?: string;
  currentTask?: { id: string; title: string; status: string };
  /** open work beyond the one being shown */
  otherOpen: number;
  updatedAt: string;
};

export type FloorDept = {
  id: DeptId;
  name: string;
  shortName: string;
  color: string;
  agents: FloorAgent[];
};

export type Floor = {
  departments: FloorDept[];
  /** agents whose department no longer exists — shown, not hidden */
  unassigned: FloorAgent[];
  totals: { agents: number; working: number; waiting: number; blocked: number; idle: number; openTasks: number };
  at: string;
};

const WAITING_STATE: Record<string, FloorState> = {
  capability: "WAITING_CAPABILITY",
  credential: "WAITING_LOGIN",
  company: "WAITING_INFO",
  payment: "WAITING_APPROVAL",
  owner_action: "WAITING_OWNER",
  browser: "BROWSER",
};

/** The one place that decides what an agent is doing. */
function stateOf(agentId: string, open: TaskRecord[]): Pick<FloorAgent, "state" | "label" | "href" | "currentTask"> {
  const db = readDb();
  const agent = db.agents.find((a) => a.id === agentId)!;
  const running = open.find((t) => t.status === "IN_PROGRESS");
  const blocked = open.find((t) => t.status === "BLOCKED");
  const current = running ?? blocked ?? open[0];
  const task = current ? { id: current.id, title: current.title, status: current.status } : undefined;

  // parked on something a person or another system owes it — read from the
  // backing request, so a resolved one can never leave a ghost here
  const waiting = resolveAgentWaiting(agent);
  if (waiting) {
    return { state: WAITING_STATE[waiting.kind] ?? "WAITING_OWNER", label: `${waiting.headline}: ${waiting.label}`, href: waiting.href, currentTask: task };
  }
  // a turn is genuinely running right now — this is the only thing that means
  // "working", and a configured provider does not
  if (isAgentBusy(agentId)) return { state: "WORKING", label: task ? task.title : "Working in a conversation", currentTask: task };
  if (running) {
    const kids = childTasks(running.id).filter((k) => OPEN_STATUSES.includes(k.status));
    if (kids.length) return { state: "WAITING_TEAM", label: `Waiting for ${kids.length} piece${kids.length === 1 ? "" : "s"} of “${running.title}”`, currentTask: task };
    // holding work with nothing running and nothing to wait for: its last turn
    // ended without a result. Saying "working" here would be a lie.
    return { state: "STALLED", label: `Stopped part-way through “${running.title}”`, currentTask: task };
  }
  if (blocked) return { state: "BLOCKED", label: blocked.blockedReason ? `Blocked: ${blocked.blockedReason}` : `Blocked on “${blocked.title}”`, currentTask: task };
  const queued = open.filter((t) => t.status === "TODO");
  if (queued.length) return { state: "IDLE", label: `${queued.length} task${queued.length === 1 ? "" : "s"} queued`, currentTask: task };
  return { state: "IDLE", label: "Nothing assigned", currentTask: undefined };
}

export function officeFloor(): Floor {
  const db = readDb();
  const openAll = listTasks({ status: [...OPEN_STATUSES] });
  const byAgent = new Map<string, TaskRecord[]>();
  for (const t of openAll) if (t.assignedToAgentId) byAgent.set(t.assignedToAgentId, [...(byAgent.get(t.assignedToAgentId) ?? []), t]);

  const people: FloorAgent[] = db.agents.map((a) => {
    const open = byAgent.get(a.id) ?? [];
    const manager = a.managerAgentId ? db.agents.find((x) => x.id === a.managerAgentId) : undefined;
    const s = stateOf(a.id, open);
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      dept: a.dept as DeptId,
      ...(a.system ? { system: a.system } : {}),
      managerId: manager?.id ?? null,
      managerName: manager?.name ?? null,
      reports: db.agents.filter((x) => x.managerAgentId === a.id).length,
      ...s,
      otherOpen: Math.max(0, open.length - (s.currentTask ? 1 : 0)),
      updatedAt: a.updatedAt,
    };
  });

  // every department that can hold people, whether or not anyone is in it —
  // an empty department is a fact about the company, not something to hide
  const rooms: DeptId[] = (Object.keys(departments) as DeptId[]).filter((d) => d !== "conference");
  const floorDepts: FloorDept[] = rooms.map((id) => ({
    id,
    name: departments[id].name,
    shortName: departments[id].shortName,
    color: departments[id].color,
    agents: people.filter((p) => p.dept === id).sort(byRank),
  }));

  const waitingStates: FloorState[] = ["WAITING_TEAM", "WAITING_CAPABILITY", "WAITING_LOGIN", "WAITING_INFO", "WAITING_APPROVAL", "WAITING_OWNER", "BROWSER"];
  return {
    departments: floorDepts,
    unassigned: people.filter((p) => !rooms.includes(p.dept)).sort(byRank),
    totals: {
      agents: people.length,
      working: people.filter((p) => p.state === "WORKING").length,
      waiting: people.filter((p) => waitingStates.includes(p.state)).length,
      blocked: people.filter((p) => p.state === "BLOCKED" || p.state === "STALLED").length,
      idle: people.filter((p) => p.state === "IDLE").length,
      openTasks: openAll.length,
    },
    at: new Date().toISOString(),
  };
}

/**
 * Whoever most needs looking at comes first — so when a room holds more
 * people than it has desks, the ones hidden behind "+N more" are the ones
 * with nothing wrong, never the one that is stuck.
 */
const ATTENTION: Record<FloorState, number> = {
  BLOCKED: 0, STALLED: 1,
  WAITING_OWNER: 2, WAITING_APPROVAL: 2, WAITING_LOGIN: 2, WAITING_INFO: 2, BROWSER: 2,
  WAITING_CAPABILITY: 3, WAITING_TEAM: 3,
  WORKING: 4,
  IDLE: 5,
};

function byRank(a: FloorAgent, b: FloorAgent): number {
  return ATTENTION[a.state] - ATTENTION[b.state] || b.reports - a.reports || a.name.localeCompare(b.name);
}

/**
 * Tell the office something changed. It refetches the authoritative floor
 * rather than trying to patch itself, so a missed event costs nothing.
 */
export function pokeOffice(title: string, agentId?: string): void {
  try {
    emitActivity({ agentId: OFFICE_CHANNEL, kind: "status", title, detail: agentId, turnId: "office" });
  } catch {
    /* the office is a view; never let it break the work */
  }
}
