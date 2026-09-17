/* ------------------------------------------------------------------
   Capability Manager — the engine around a normal Nexora agent.

     any agent → request_capability → request PENDING, agent WAITING
     manager loop (serialized) → Capability Manager turns until the
       request is RESOLVED / FAILED / WAITING_FOR_PAYMENT
     resolve or fail → requester is resumed automatically (system message
       in its own conversation, same runtime session)
     payment → Owner decides in the UI → manager wakes with the decision

   The LLM decides; everything here is bookkeeping and wake-ups.
   ------------------------------------------------------------------ */

import { randomUUID } from "node:crypto";
import { newId, now, readDb, updateDb } from "@/lib/store/db";
import { DEFAULT_RUNTIME } from "@/lib/runtime/catalog";
import type { AgentRecord, RuntimeConfig } from "@/lib/runtime/types";
import { listServers } from "@/lib/mcp/store";
import { listCapabilities, capabilitiesAsText } from "./registry";
import { grantsText } from "./grants";
import {
  addCapabilityActivity, createRequest, getRequest, listRequests, openRequests, patchRequest, requesterWaiting, setRequestStatus,
} from "./store";
import {
  render,
} from "./prompts";
import { getPrompt } from "@/lib/prompts";
import type { CapabilityManagerOverview, CapabilityRequest, PaymentApproval } from "./types";

export const CAPABILITY_MANAGER_ID = "capability-manager";
const MAX_TURNS_PER_REQUEST = 6;
const short = (id: string) => id.slice(0, 8);

/* ---------------------------------------------------------------- the agent */

export function ensureCapabilityManager(): AgentRecord {
  const existing = readDb().agents.find((a) => a.id === CAPABILITY_MANAGER_ID);
  if (existing) {
    // keep the system marker and make sure every server is usable for testing
    const need = ["payments", "payments_use", "payments_manage", "credentials", "credentials_manage", "company_profile"].filter((p) => !existing.toolPermissions.includes(p));
    if (existing.system !== "capability-manager" || need.length) {
      updateDb((d) => { const a = d.agents.find((x) => x.id === CAPABILITY_MANAGER_ID); if (a) { a.system = "capability-manager"; for (const p of need) a.toolPermissions.push(p); } });
    }
    grantAllServers();
    return readDb().agents.find((a) => a.id === CAPABILITY_MANAGER_ID)!;
  }
  const ts = now();
  const rc: RuntimeConfig = { id: `rc-${CAPABILITY_MANAGER_ID}`, runtimeType: DEFAULT_RUNTIME.runtimeType, providerConnectionId: "conn-anthropic", model: DEFAULT_RUNTIME.model, advancedSettings: {} };
  const agent: AgentRecord = {
    id: CAPABILITY_MANAGER_ID,
    name: "Capability Manager",
    role: "System Operations",
    dept: "operations",
    instructions: getPrompt("capability-manager-instructions"),
    skills: ["tool-research", "mcp-integration", "credential-hygiene"],
    toolPermissions: ["web_search", "web_fetch", "read_files", "write_files", "run_commands", "browser", "payments", "payments_use", "payments_manage", "credentials", "credentials_manage", "company_profile"],
    runtimeConfigId: rc.id,
    mcpGrants: listServers().map((s) => ({ serverId: s.id, enabled: true, tools: "all" as const })),
    status: "online",
    system: "capability-manager",
    createdAt: ts,
    updatedAt: ts,
  };
  updateDb((d) => {
    if (!d.providerConnections.some((c) => c.id === rc.providerConnectionId)) rc.providerConnectionId = d.providerConnections[0]?.id ?? rc.providerConnectionId;
    d.runtimeConfigs.push(rc);
    d.agents.push(agent);
  });
  addCapabilityActivity(null, "note", "Capability Manager agent created");
  return agent;
}

function grantAllServers() {
  updateDb((d) => {
    const a = d.agents.find((x) => x.id === CAPABILITY_MANAGER_ID);
    if (!a) return;
    a.mcpGrants ??= [];
    for (const s of d.mcpServers) if (!a.mcpGrants.some((g) => g.serverId === s.id)) a.mcpGrants.push({ serverId: s.id, enabled: true, tools: "all" });
  });
}

/* ---------------------------------------------------------------- requests */

export function submitCapabilityRequest(requesterAgentId: string, input: { capability: string; reason: string; context: string }, executionScopeId?: string): CapabilityRequest | null {
  const requester = readDb().agents.find((a) => a.id === requesterAgentId);
  if (!requester) return null;
  ensureCapabilityManager();
  // the resume continues the requester's current scope, so side effects it already completed stay deduplicated
  const scope = executionScopeId ?? readDb().conversations.find((c) => c.agentId === requesterAgentId)?.executionScopeId ?? `request:${randomUUID().slice(0, 8)}`;
  const req = createRequest({ requesterAgentId, requesterName: requester.name, capability: input.capability, reason: input.reason, context: input.context, executionScopeId: scope });
  requesterWaiting(requesterAgentId, { requestId: req.id, capability: req.capability });
  addCapabilityActivity(req.id, "requested", `${requester.name} requested "${req.capability}"`, input.reason);
  setImmediate(() => void pumpManager());
  return req;
}

/* ---------------------------------------------------------------- manager loop */

let busy = false;
let pending = false;
let current: string | null = null;
const wakeMessages = new Map<string, string>();

export function currentRequestId(): string | null {
  return current;
}

export function managerBusy(): boolean {
  return busy;
}

function requesterAccessText(agentId: string): string {
  const a = readDb().agents.find((x) => x.id === agentId);
  if (!a) return "(agent missing)";
  return grantsText(a);
}

async function runManagerTurn(req: CapabilityRequest): Promise<void> {
  const { sendAgentMessage } = await import("@/lib/runtime");
  const first = req.turns === 0;
  const wake = wakeMessages.get(req.id);
  wakeMessages.delete(req.id);
  const message = wake
    ? wake
    : first
      ? render(getPrompt("capability-request-message"), { shortId: short(req.id), requesterName: req.requesterName, requesterId: req.requesterAgentId, capability: req.capability, reason: req.reason, context: req.context || "(none given)", requesterAccess: requesterAccessText(req.requesterAgentId), registry: capabilitiesAsText() })
      : render(getPrompt("capability-continue-message"), { shortId: short(req.id), capability: req.capability, status: req.status, note: req.note ? ` (last note: ${req.note})` : "" });
  patchRequest(req.id, { turns: req.turns + 1 });
  if (first && req.status === "PENDING") setRequestStatus(req.id, "RESEARCHING", "Capability Manager is reviewing the request");
  current = req.id;
  updateDb((d) => { const a = d.agents.find((x) => x.id === CAPABILITY_MANAGER_ID); if (a) a.status = "busy"; });
  try {
    const r = await sendAgentMessage(CAPABILITY_MANAGER_ID, message, { origin: "system", scopeId: `caprequest:${req.id}` });
    if (r.assistant.error) {
      const after = getRequest(req.id);
      if (after && !["RESOLVED", "FAILED", "WAITING_FOR_PAYMENT"].includes(after.status)) {
        failRequest(req.id, `Capability Manager runtime error: ${r.assistant.error}`);
      }
    }
  } finally {
    current = null;
    updateDb((d) => { const a = d.agents.find((x) => x.id === CAPABILITY_MANAGER_ID); if (a) a.status = "online"; });
  }
}

/** Serialized: one Capability Manager turn at a time; runs until no request is actionable. */
export async function pumpManager(): Promise<void> {
  if (busy) { pending = true; return; }
  busy = true;
  try {
    for (let guard = 0; guard < 100; guard++) {
      const next = openRequests()[0];
      if (!next) break;
      if (next.turns >= MAX_TURNS_PER_REQUEST) {
        failRequest(next.id, `The Capability Manager did not finish within ${MAX_TURNS_PER_REQUEST} turns.`);
        continue;
      }
      await runManagerTurn(next);
    }
  } catch (err) {
    console.error("[nexora] capability manager loop error:", err);
  } finally {
    busy = false;
    if (pending) { pending = false; setImmediate(() => void pumpManager()); }
  }
}

/* ---------------------------------------------------------------- outcomes */

export function resolveRequest(id: string, summary: string, granted: string[]): void {
  const req = getRequest(id);
  if (!req) throw new Error("Request not found.");
  if (req.status === "RESOLVED") return;
  patchRequest(id, { status: "RESOLVED", resolution: { summary, granted }, note: "Resolved", resolvedAt: now() });
  addCapabilityActivity(id, "resolved", `Request "${req.capability}" resolved`, summary);
  scheduleResume(id);
}

export function failRequest(id: string, reason: string): void {
  const req = getRequest(id);
  if (!req) throw new Error("Request not found.");
  if (req.status === "FAILED" || req.status === "RESOLVED") return;
  patchRequest(id, { status: "FAILED", error: reason.slice(0, 2_000), note: "Failed", resolvedAt: now() });
  addCapabilityActivity(id, "failed", `Request "${req.capability}" failed`, reason);
  scheduleResume(id);
}

export function requestPayment(id: string, p: Omit<PaymentApproval, "requestedAt">): void {
  const req = getRequest(id);
  if (!req) throw new Error("Request not found.");
  patchRequest(id, { status: "WAITING_FOR_PAYMENT", payment: { ...p, requestedAt: now() }, note: `Waiting for Owner approval: ${p.product} (${p.cost})` });
  addCapabilityActivity(id, "payment_requested", `Payment approval requested: ${p.product} — ${p.cost} ${p.billing}`, `${p.why}\n\nFree alternatives: ${p.alternatives}\n\nRecommendation: ${p.recommendation}`);
}

/**
 * Payments flow: the Capability Manager called request_payment above the limit while
 * working on a capability request → mirror it as WAITING_FOR_PAYMENT here.
 */
export async function onPaymentRequested(p: { id: string; capabilityRequestId?: string; merchant: string; amount: number; currency: string; billingType: string; interval?: string; reason: string; recommendation?: string }): Promise<void> {
  if (!p.capabilityRequestId) return;
  const req = getRequest(p.capabilityRequestId);
  if (!req) return;
  const cost = `$${p.amount.toFixed(2)}${p.billingType === "RECURRING" ? ` / ${p.interval === "YEARLY" ? "year" : "month"}` : ""}`;
  patchRequest(req.id, { status: "WAITING_FOR_PAYMENT", payment: { product: p.merchant, cost, billing: p.billingType === "RECURRING" ? (p.interval ?? "MONTHLY").toLowerCase() : "one-time", why: p.reason, alternatives: p.recommendation ?? "", recommendation: "Approve", requestedAt: now(), paymentRequestId: p.id }, note: `Waiting for Owner approval: ${p.merchant} (${cost})` });
  addCapabilityActivity(req.id, "payment_requested", `Payment approval requested: ${p.merchant} — ${cost}`, p.reason);
}

/** Payments flow: the owner decided on a linked payment request → wake the Capability Manager with the decision. Returns false when the capability request is unknown. */
export async function onPaymentDecision(capabilityRequestId: string, decision: "approved" | "rejected", text: string): Promise<boolean> {
  const req = getRequest(capabilityRequestId);
  if (!req) return false;
  const payment: PaymentApproval | undefined = req.payment ? { ...req.payment, decision, decidedAt: now() } : undefined;
  wakeMessages.set(req.id, text);
  if (req.status === "WAITING_FOR_PAYMENT" || OPEN_STATES.includes(req.status)) {
    patchRequest(req.id, { payment, status: decision === "approved" ? "INSTALLING" : "RESEARCHING", note: decision === "approved" ? "Payment approved — completing checkout" : "Payment rejected — looking for alternatives", turns: Math.min(req.turns, MAX_TURNS_PER_REQUEST - 2) });
    addCapabilityActivity(req.id, "payment_decided", `Owner ${decision} payment for ${req.payment?.product ?? "the paid option"}`);
    setImmediate(() => void pumpManager());
  }
  return true;
}

const OPEN_STATES = ["PENDING", "RESEARCHING", "INSTALLING", "TESTING"];

/** Credentials flow: the manager asked the owner for a login while working a capability request. */
export async function onCredentialRequested(capabilityRequestId: string, r: { id: string; service: string; site: string }): Promise<void> {
  const req = getRequest(capabilityRequestId);
  if (!req) return;
  patchRequest(req.id, { note: `Waiting for the owner to add a credential for ${r.service} (${r.site})` });
  addCapabilityActivity(req.id, "note", `Credential required from the owner: ${r.service} (${r.site})`);
}

/** Company Profile flow: the manager asked the owner for a company value. */
export async function onCompanyInfoRequested(capabilityRequestId: string, r: { label: string; neededBy: string }): Promise<void> {
  const req = getRequest(capabilityRequestId);
  if (!req) return;
  patchRequest(req.id, { note: `Waiting for the owner to add company information: ${r.label}` });
  addCapabilityActivity(req.id, "note", `Company information required from the owner: ${r.label} (for ${r.neededBy})`);
}

/** Company Profile flow: the owner filled the value in → wake the manager. */
export async function onCompanyInfoResolved(capabilityRequestId: string, text: string): Promise<boolean> {
  const req = getRequest(capabilityRequestId);
  if (!req) return false;
  wakeMessages.set(req.id, text);
  if (OPEN_STATES.includes(req.status) || req.status === "WAITING_FOR_PAYMENT") {
    patchRequest(req.id, { note: "Company information provided — continuing", turns: Math.min(req.turns, MAX_TURNS_PER_REQUEST - 2) });
    addCapabilityActivity(req.id, "note", "Owner provided the requested company information");
    setImmediate(() => void pumpManager());
  }
  return true;
}

/** Credentials flow: the owner added the credential → wake the manager with the resume text. */
export async function onCredentialResolved(capabilityRequestId: string, text: string): Promise<boolean> {
  const req = getRequest(capabilityRequestId);
  if (!req) return false;
  wakeMessages.set(req.id, text);
  if (OPEN_STATES.includes(req.status) || req.status === "WAITING_FOR_PAYMENT") {
    patchRequest(req.id, { note: "Credential added — continuing", turns: Math.min(req.turns, MAX_TURNS_PER_REQUEST - 2) });
    addCapabilityActivity(req.id, "credential_stored", "Owner added the requested credential");
    setImmediate(() => void pumpManager());
  }
  return true;
}

export function decidePayment(id: string, decision: "approved" | "rejected", ownerNote?: string): CapabilityRequest {
  const req = getRequest(id);
  if (!req || !req.payment) throw new Error("No payment approval is pending on this request.");
  if (req.payment.paymentRequestId) throw new Error("Decide this payment in Payments → Requests.");
  if (req.status !== "WAITING_FOR_PAYMENT") throw new Error("This request is not waiting for payment.");
  const payment: PaymentApproval = { ...req.payment, decision, decidedAt: now(), ownerNote };
  const note = ownerNote ? ` Owner note: ${ownerNote}` : "";
  const msg = decision === "approved"
    ? render(getPrompt("capability-payment-approved-message"), { shortId: short(id), capability: req.capability, product: payment.product, cost: payment.cost, billing: payment.billing, note })
    : render(getPrompt("capability-payment-rejected-message"), { shortId: short(id), capability: req.capability, product: payment.product, note });
  wakeMessages.set(id, msg);
  const updated = patchRequest(id, { payment, status: decision === "approved" ? "INSTALLING" : "RESEARCHING", note: decision === "approved" ? "Payment approved — configuring" : "Payment rejected — looking for alternatives", turns: Math.min(req.turns, MAX_TURNS_PER_REQUEST - 2) });
  addCapabilityActivity(id, "payment_decided", `Owner ${decision} payment for ${payment.product}`, ownerNote);
  setImmediate(() => void pumpManager());
  return updated;
}

/** Owner talks to the Capability Manager about a request (any state). Returns the reply text. */
export async function discussRequest(id: string, text: string): Promise<string> {
  const req = getRequest(id);
  if (!req) throw new Error("Request not found.");
  ensureCapabilityManager();
  const { sendAgentMessage } = await import("@/lib/runtime");
  const r = await sendAgentMessage(CAPABILITY_MANAGER_ID, render(getPrompt("capability-owner-message"), { shortId: short(id), capability: req.capability, text }), { origin: "owner", requestId: id, scopeId: `caprequest:${req.id}` });
  return r.assistant.content;
}

/* ---------------------------------------------------------------- auto resume */

const resumeQueue = new Set<string>();

function scheduleResume(id: string) {
  if (resumeQueue.has(id)) return;
  resumeQueue.add(id);
  setImmediate(() => void resumeRequester(id).finally(() => resumeQueue.delete(id)));
}

async function resumeRequester(id: string): Promise<void> {
  const req = getRequest(id);
  if (!req || req.resumedAt) return;
  const requester = readDb().agents.find((a) => a.id === req.requesterAgentId);
  requesterWaiting(req.requesterAgentId, null);
  if (!requester) return;
  const text = req.status === "RESOLVED"
    ? render(getPrompt("capability-resume-resolved"), { shortId: short(id), capability: req.capability, summary: req.resolution?.summary ?? "", granted: req.resolution?.granted?.length ? `Granted: ${req.resolution.granted.join(", ")}` : "", context: req.context || "(none)" })
    : render(getPrompt("capability-resume-failed"), { shortId: short(id), capability: req.capability, reason: req.error ?? "unknown", context: req.context || "(none)" });
  patchRequest(id, { resumedAt: now() });
  addCapabilityActivity(id, "agent_resumed", `${requester.name} resumed automatically`);
  const { sendAgentMessage } = await import("@/lib/runtime");
  try {
    await sendAgentMessage(req.requesterAgentId, text, { origin: "system", scopeId: req.executionScopeId });
  } catch (err) {
    addCapabilityActivity(id, "note", `Resume of ${requester.name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ---------------------------------------------------------------- boot + overview */

export function recoverCapabilityRequests(): void {
  ensureCapabilityManager();
  const open = openRequests();
  if (open.length) {
    addCapabilityActivity(null, "note", `${open.length} open capability request${open.length === 1 ? "" : "s"} resumed after restart`);
    setImmediate(() => void pumpManager());
  }
  // requests that finished while the app was down still owe their requester a resume
  for (const r of listRequests()) if ((r.status === "RESOLVED" || r.status === "FAILED") && !r.resumedAt) scheduleResume(r.id);
}

export function managerOverview(): CapabilityManagerOverview {
  const agent = ensureCapabilityManager();
  const reqs = listRequests();
  const active = reqs.filter((r) => ["PENDING", "RESEARCHING", "INSTALLING", "TESTING"].includes(r.status));
  const cur = current ? getRequest(current) : null;
  const caps = listCapabilities();
  const servers = listServers();
  return {
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    working: busy,
    currentTask: cur ? `${cur.note ?? cur.status} — ${cur.capability}` : active[0] ? `Queued: ${active[0].capability}` : null,
    activeRequests: active.length,
    waitingForPayment: reqs.filter((r) => r.status === "WAITING_FOR_PAYMENT").length,
    capabilitiesAdded: reqs.filter((r) => r.status === "RESOLVED").length,
    capabilitiesAvailable: caps.filter((c) => c.status === "available").length,
    mcpServersConnected: servers.filter((s) => s.enabled && s.lastTestOk !== false).length,
    mcpServersTotal: servers.length,
  };
}

export { newId };
