/* ------------------------------------------------------------------
   What an agent is blocked on — one model for every surface.

   An agent stops and waits in four different subsystems (a capability
   request, a credential request, a company-information request, a browser
   handed to the owner). Before this module each of them wrote its own
   free-form string into `agent.waitingFor`, the header labelled all of them
   "Waiting for capability", and nothing ever checked that the thing being
   waited for still existed. That produced ghost waits: a badge naming a
   surface that does not own the request, with no way to reach it.

   Now the record stores a typed reference (kind + the backing request's own
   id), and every read resolves it against that subsystem's store:

     - resolved to an OPEN request  → status text, the surface that owns it
                                      and a deep link the owner can click
     - resolved to anything else    → the waiting state is stale and is
       (missing//done/cancelled)      repaired instead of being displayed

   The backing request is the source of truth; the agent record only points
   at it.
   ------------------------------------------------------------------ */

import { now, readDb, updateDb } from "@/lib/store/db";
import { requestTarget } from "@/lib/company/store";
import type { AgentRecord } from "@/lib/runtime/types";

export type WaitingKind = "capability" | "credential" | "company" | "payment" | "browser" | "owner_action";

export type AgentWaiting = {
  kind: WaitingKind;
  /** the backing record's own id, in its own store (never prefixed) */
  requestId: string;
  /** what is being waited for, e.g. "Google Account (accounts.google.com)" */
  label: string;
  since: string;
};

export type AgentWaitingView = AgentWaiting & {
  /** short status for the agent header */
  headline: string;
  /** the owner-facing surface that owns the backing request */
  surface: string;
  /** deep link to that request */
  href: string;
  /** what the owner has to do */
  action: string;
};

const OPEN_CAPABILITY = ["PENDING", "RESEARCHING", "INSTALLING", "TESTING", "WAITING_FOR_PAYMENT"];

type Backing = { open: boolean; label?: string; href: string; surface: string; headline: string; action: string };

/** Look the backing request up in the store that owns it. */
function backing(w: AgentWaiting): Backing | null {
  const db = readDb();
  switch (w.kind) {
    case "capability": {
      const r = db.capabilityRequests.find((x) => x.id === w.requestId);
      if (!r) return null;
      return { open: OPEN_CAPABILITY.includes(r.status), label: r.capability, surface: "Capabilities", href: `/capabilities?request=${r.id}`, headline: "Waiting for a capability", action: "The Capability Manager is resolving this" };
    }
    case "credential": {
      const r = db.credentialRequests.find((x) => x.id === w.requestId);
      if (!r) return null;
      return { open: r.status === "WAITING", label: `${r.service} (${r.site})`, surface: "Credentials", href: `/credentials?request=${r.id}`, headline: "Waiting for a login", action: "Add the login on the Credentials page" };
    }
    case "company": {
      const r = db.companyInfoRequests.find((x) => x.id === w.requestId);
      if (!r) return null;
      const custom = requestTarget(r) === "custom_data";
      return {
        open: r.status === "WAITING", label: r.label,
        surface: custom ? "Company data" : "Company profile",
        href: `/company?request=${r.id}`,
        headline: "Waiting for company information",
        action: custom ? "Add it to Company data" : "Fill the field in the Company Profile",
      };
    }
    case "payment": {
      const r = db.paymentRequests.find((x) => x.id === w.requestId);
      if (!r) return null;
      return { open: r.status === "WAITING_FOR_APPROVAL", label: `${r.merchant} ($${r.amount.toFixed(2)})`, surface: "Payments", href: `/payments/requests?request=${r.id}`, headline: "Waiting for payment approval", action: "Approve or reject it in Payments" };
    }
    case "owner_action": {
      const r = db.ownerActions.find((x) => x.id === w.requestId);
      if (!r) return null;
      return {
        open: r.status === "OPEN", label: r.title,
        surface: "Needs You", href: `/action-center?action=${r.id}`,
        headline: r.kind === "turn_budget" ? "Waiting for more steps" : r.kind === "captcha" || r.kind === "browser" ? "Browser handed to you" : r.kind === "data" ? "Waiting for information" : "Waiting for you",
        action: "Answer it in Needs You",
      };
    }
    case "browser": {
      const r = db.browserHandoffs.find((x) => x.id === w.requestId);
      if (!r) return null;
      return { open: r.status === "OPEN", label: r.reason, surface: "Browser", href: `/agents/${r.agentId}?browser=1`, headline: "Browser handed to you", action: "Finish in the browser, then return control" };
    }
    default:
      return null;
  }
}

/**
 * The agent's waiting state, validated against the backing request.
 *
 * `repair` clears a stale reference (the request is gone, done or cancelled)
 * so the owner never sees a wait they cannot act on. Read paths that may run
 * inside another write should leave it off.
 */
export function resolveAgentWaiting(agent: Pick<AgentRecord, "id" | "waitingFor">, opts: { repair?: boolean } = {}): AgentWaitingView | null {
  const w = agent.waitingFor;
  if (!w) return null;
  const b = backing(w);
  if (!b || !b.open) {
    if (opts.repair) {
      clearAgentWaiting(agent.id, w.requestId);
      console.log(`[agents] cleared stale waiting state on ${agent.id.slice(0, 8)}: ${w.kind}:${w.requestId.slice(0, 8)} ${b ? "is no longer open" : "does not exist"}`);
    }
    return null;
  }
  return { ...w, label: b.label || w.label, headline: b.headline, surface: b.surface, href: b.href, action: b.action };
}

/** Point the agent at a backing request. Always called AFTER that request is persisted. */
export function setAgentWaiting(agentId: string, waiting: Omit<AgentWaiting, "since"> & { since?: string }): void {
  updateDb((d) => {
    const a = d.agents.find((x) => x.id === agentId);
    if (!a) return;
    a.waitingFor = { kind: waiting.kind, requestId: waiting.requestId, label: waiting.label.slice(0, 160), since: waiting.since ?? now() };
    a.updatedAt = now();
  });
  poke(`waiting:${waiting.kind}`, agentId);
}

/** Clear the wait. With `requestId`, only when the agent is still waiting for that exact request. */
export function clearAgentWaiting(agentId: string, requestId?: string): void {
  updateDb((d) => {
    const a = d.agents.find((x) => x.id === agentId);
    if (!a || !a.waitingFor) return;
    if (requestId && a.waitingFor.requestId !== requestId) return;
    a.waitingFor = null;
    a.updatedAt = now();
  });
  poke("waiting:cleared", agentId);
}

/** Tell whatever is watching the company that an agent's wait changed. */
function poke(title: string, agentId: string): void {
  void import("@/lib/office/floor").then((m) => m.pokeOffice(title, agentId)).catch(() => undefined);
}

/** Is this agent already blocked on this exact request? */
export function isWaitingFor(agentId: string, kind: WaitingKind, requestId: string): boolean {
  const a = readDb().agents.find((x) => x.id === agentId);
  return a?.waitingFor?.kind === kind && a.waitingFor.requestId === requestId;
}

/**
 * An agent is being deleted: close everything it left open so the owner is
 * never asked to act on a request whose requester no longer exists.
 * Returns a short description of what was closed.
 */
export function releaseAgentRequests(agentId: string, reason = "the requesting agent was removed"): string[] {
  const closed: string[] = [];
  updateDb((d) => {
    for (const r of d.credentialRequests) if (r.requesterAgentId === agentId && r.status === "WAITING") { r.status = "CANCELLED"; r.updatedAt = now(); closed.push(`credential request for ${r.service}`); }
    for (const r of d.companyInfoRequests) if (r.requesterAgentId === agentId && r.status === "WAITING") { r.status = "CANCELLED"; r.updatedAt = now(); closed.push(`company information request for ${r.label}`); }
    for (const r of d.paymentRequests) if (r.requestedByAgentId === agentId && ["WAITING_FOR_APPROVAL", "AUTO_APPROVED", "APPROVED", "PROCESSING"].includes(r.status)) { r.status = "CANCELLED"; r.completionNote = reason; r.completedAt = now(); r.updatedAt = now(); closed.push(`payment request for ${r.merchant}`); }
    for (const r of d.capabilityRequests) if (r.requesterAgentId === agentId && !["RESOLVED", "FAILED"].includes(r.status)) { r.status = "FAILED"; r.error = reason; r.updatedAt = now(); closed.push(`capability request "${r.capability}"`); }
    for (const h of d.browserHandoffs) if (h.agentId === agentId && h.status === "OPEN") { h.status = "CANCELLED"; h.ownerNote = reason; h.updatedAt = now(); closed.push("browser handoff"); }
  });
  if (closed.length) console.log(`[agents] released ${closed.length} open request(s) of ${agentId.slice(0, 8)}: ${closed.join(", ")}`);
  return closed;
}

/**
 * Sweep every agent and drop waiting states whose backing request is gone,
 * finished or cancelled. Runs at boot and on the agent read paths, so a
 * request deleted or resolved out of band can never strand an agent.
 */
export function reconcileAgentWaiting(): { checked: number; repaired: string[] } {
  const agents = readDb().agents.filter((a) => a.waitingFor);
  const repaired: string[] = [];
  for (const a of agents) {
    const before = a.waitingFor;
    if (!resolveAgentWaiting(a, { repair: true }) && before) repaired.push(`${a.name}: ${before.kind}:${before.requestId.slice(0, 8)}`);
  }
  return { checked: agents.length, repaired };
}
