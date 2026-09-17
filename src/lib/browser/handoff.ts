/* ------------------------------------------------------------------
   Browser handoff — the agent shows the owner its browser, and can give
   the owner the controls.

   This is deliberately NOT a capability or credential request: nothing is
   missing from Nexora, the owner is simply needed inside a page the agent
   is already on (a human check, a login screen, a choice only they can
   make). It is its own waiting kind, resolved on the agent workspace.

   VIEW         the dock opens, the agent keeps working.
   INTERACTIVE  the agent stops touching the page and the owner drives the
                SAME session — same context, cookies, tabs and page. When
                control comes back the agent is resumed in the scope it was
                working in and re-reads the page.
   ------------------------------------------------------------------ */

import { newId, now, readDb, updateDb } from "@/lib/store/db";
import { agentBrowserKey } from "./index";
import { clearAgentWaiting, setAgentWaiting } from "@/lib/agents/waiting";
import { renderPrompt } from "@/lib/prompts";
import type { BrowserHandoff, BrowserHandoffMode } from "./types";

const short = (id: string) => id.slice(0, 8);

export function listHandoffs(agentId?: string): BrowserHandoff[] {
  const rows = readDb().browserHandoffs;
  return (agentId ? rows.filter((h) => h.agentId === agentId) : rows).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const getHandoff = (id: string) => readDb().browserHandoffs.find((h) => h.id === id) ?? null;

/** The handoff the owner is currently being asked to look at, if any. */
export const openHandoff = (agentId: string) => listHandoffs(agentId).find((h) => h.status === "OPEN") ?? null;

/** Does the owner currently hold the controls of this agent's browser? */
export function ownerHasControl(agentId: string): BrowserHandoff | null {
  const h = openHandoff(agentId);
  return h && h.mode === "INTERACTIVE" ? h : null;
}

export function createHandoff(input: { agentId: string; mode: BrowserHandoffMode; reason: string; executionScopeId?: string; capabilityRequestId?: string }): BrowserHandoff {
  const agent = readDb().agents.find((a) => a.id === input.agentId);
  if (!agent) throw new Error("Agent not found.");
  const reason = input.reason.trim().slice(0, 500);
  if (!reason) throw new Error("reason is required: tell the owner what to look at.");
  const existing = openHandoff(agent.id);
  if (existing) {
    // already presenting — upgrade VIEW to INTERACTIVE rather than stacking handoffs
    if (existing.mode === input.mode) return existing;
    const upgraded = patchHandoff(existing.id, { mode: input.mode, reason, updatedAt: now() });
    syncWaiting(upgraded);
    return upgraded;
  }
  const ts = now();
  const rec: BrowserHandoff = {
    id: newId(), agentId: agent.id, agentName: agent.name, sessionKey: agentBrowserKey(agent.id),
    mode: input.mode, reason, status: "OPEN", executionScopeId: input.executionScopeId, capabilityRequestId: input.capabilityRequestId,
    createdAt: ts, updatedAt: ts,
  };
  updateDb((d) => { d.browserHandoffs.push(rec); });
  syncWaiting(rec);
  console.log(`[browser] handoff #${short(rec.id)} ${rec.mode} from ${agent.name}: ${reason.slice(0, 80)}`);
  return rec;
}

/** INTERACTIVE pauses the agent (it is waiting for the owner); VIEW does not. */
function syncWaiting(h: BrowserHandoff): void {
  if (h.status === "OPEN" && h.mode === "INTERACTIVE") setAgentWaiting(h.agentId, { kind: "browser", requestId: h.id, label: h.reason });
  else clearAgentWaiting(h.agentId, h.id);
}

export function patchHandoff(id: string, patch: Partial<BrowserHandoff>): BrowserHandoff {
  return updateDb((d) => {
    const h = d.browserHandoffs.find((x) => x.id === id);
    if (!h) throw new Error("Browser handoff not found.");
    Object.assign(h, patch, { updatedAt: now() });
    if (d.browserHandoffs.length > 500) d.browserHandoffs.splice(0, d.browserHandoffs.length - 500);
    return h;
  });
}

/**
 * The owner is done (or is taking the presentation away). The agent is
 * resumed in its original scope and told to look at the page again — the
 * session, its cookies and the open page are untouched.
 */
export async function closeHandoff(id: string, outcome: "RETURNED" | "CANCELLED", note?: string): Promise<BrowserHandoff> {
  const cur = getHandoff(id);
  if (!cur) throw new Error("Browser handoff not found.");
  if (cur.status !== "OPEN") return cur;
  const h = patchHandoff(id, { status: outcome, returnedAt: now(), ownerNote: note?.slice(0, 500) });
  clearAgentWaiting(h.agentId, h.id);
  if (h.mode === "INTERACTIVE") await resumeAgent(h, outcome, note);
  return h;
}

async function resumeAgent(h: BrowserHandoff, outcome: "RETURNED" | "CANCELLED", note?: string): Promise<void> {
  const text = renderPrompt(outcome === "RETURNED" ? "browser-returned-resume" : "browser-cancelled-resume", {
    short_id: short(h.id), reason: h.reason, note: note ? ` — note: ${note}` : "",
  });
  patchHandoff(h.id, { resumedAt: now() });
  const { onCompanyInfoResolved } = await import("@/lib/capabilities/manager");
  if (h.capabilityRequestId && (await onCompanyInfoResolved(h.capabilityRequestId, text))) return;
  const { sendAgentMessage } = await import("@/lib/runtime");
  void sendAgentMessage(h.agentId, text, { origin: "system", scopeId: h.executionScopeId }).catch((err) => console.error("[browser] handoff resume failed:", err));
}
