/* ------------------------------------------------------------------
   Company Profile — information requests and automatic resume.

   An agent that needs a company value Nexora does not have calls
   request_company_info and ends its turn. The owner fills the field in
   the Company Profile UI; the moment the value exists the request is
   resolved and the requester is resumed in the scope it was working in
   (the Capability Manager continues its own request loop instead).
   ------------------------------------------------------------------ */

import { newId, now, readDb } from "@/lib/store/db";
import { clearAgentWaiting, setAgentWaiting } from "@/lib/agents/waiting";
import { renderPrompt } from "@/lib/prompts";
import { addCompanyActivity, findField, getCompanyRequest, getProfile, insertCompanyRequest, listCompanyRequests, patchCompanyRequest } from "./store";
import type { CompanyInfoRequest } from "./types";

const short = (id: string) => id.slice(0, 8);

export function createCompanyInfoRequest(input: { agentId: string; field: string; neededBy: string; reason: string; executionScopeId?: string; capabilityRequestId?: string }): CompanyInfoRequest {
  const agent = readDb().agents.find((a) => a.id === input.agentId);
  if (!agent) throw new Error("Agent not found.");
  const raw = input.field.trim();
  if (!raw) throw new Error("field is required.");
  if (!input.neededBy.trim()) throw new Error("needed_by is required (what needs this value).");
  const known = findField(raw);
  const key = known?.key ?? raw.toLowerCase().replace(/\s+/g, "_").slice(0, 60);
  const open = listCompanyRequests().find((r) => r.status === "WAITING" && r.field === key);
  if (open) return open;
  const ts = now();
  const rec: CompanyInfoRequest = {
    id: newId(), requesterAgentId: agent.id, requesterName: agent.name, field: key, target: known ? "profile" : "custom_data", label: known?.label ?? raw.slice(0, 80),
    neededBy: input.neededBy.trim().slice(0, 160), reason: input.reason.trim().slice(0, 1_000), status: "WAITING",
    executionScopeId: input.executionScopeId, capabilityRequestId: input.capabilityRequestId, createdAt: ts, updatedAt: ts,
  };
  // persisted first, then the agent points at it
  insertCompanyRequest(rec);
  setAgentWaiting(agent.id, { kind: "company", requestId: rec.id, label: rec.label });
  addCompanyActivity("info_requested", `Company information required: ${rec.label} — for ${rec.neededBy} (${agent.name})`, { agentId: agent.id, requestId: rec.id });
  console.log(`[company] info request #${short(rec.id)} ${rec.field} for ${rec.neededBy} by ${agent.name}`);
  return rec;
}

/** Resolve one request and resume its requester. */
export async function resolveCompanyInfoRequest(id: string, by: "owner" | "auto" = "owner"): Promise<CompanyInfoRequest> {
  const req = getCompanyRequest(id);
  if (!req) throw new Error("Company information request not found.");
  if (req.status !== "WAITING") throw new Error(`This request is ${req.status}.`);
  const updated = patchCompanyRequest(id, { status: "RESOLVED", resolvedAt: now() });
  addCompanyActivity("info_provided", `Company information provided: ${req.label} — ${req.requesterName} resumes${by === "auto" ? "" : " (marked provided by you)"}`, { agentId: req.requesterAgentId, requestId: id });
  await wakeRequester(updated);
  return updated;
}

/**
 * Called after the owner saved anything company-related: resolve every waiting
 * request whose value now exists — a canonical profile field, or the Custom
 * Data key the agent asked for (agents ask for reusable answers by key).
 */
export async function resolveFilledRequests(): Promise<CompanyInfoRequest[]> {
  const profile = getProfile();
  const { getCustomDatum } = await import("./custom-data");
  const done: CompanyInfoRequest[] = [];
  for (const req of listCompanyRequests().filter((r) => r.status === "WAITING")) {
    const field = findField(req.field);
    const filled = field ? !!field.get(profile) : !!getCustomDatum(req.field);
    if (!filled) continue;
    done.push(await resolveCompanyInfoRequest(req.id, "auto"));
  }
  return done;
}

export function cancelCompanyInfoRequest(id: string): CompanyInfoRequest {
  const req = getCompanyRequest(id);
  if (!req) throw new Error("Company information request not found.");
  if (req.status !== "WAITING") throw new Error(`This request is ${req.status}.`);
  const updated = patchCompanyRequest(id, { status: "CANCELLED" });
  clearAgentWaiting(req.requesterAgentId, id);
  // the agent asked and is parked on the answer: dismissing the question
  // without telling it leaves it waiting for something that will never come
  void wakeDismissed(updated).catch((err) => console.error("[company] dismissal resume failed:", err));
  return updated;
}

/** The owner is not going to supply it. Say so, so the work can go on or stop honestly. */
async function wakeDismissed(req: CompanyInfoRequest): Promise<void> {
  const text = renderPrompt("company-info-dismissed-resume", { short_id: short(req.id), label: req.label });
  patchCompanyRequest(req.id, { resumedAt: now() });
  const { onCompanyInfoResolved } = await import("@/lib/capabilities/manager");
  if (req.capabilityRequestId && (await onCompanyInfoResolved(req.capabilityRequestId, text))) return;
  const { sendAgentMessage } = await import("@/lib/runtime");
  await sendAgentMessage(req.requesterAgentId, text, { origin: "system", scopeId: req.executionScopeId });
}

async function wakeRequester(req: CompanyInfoRequest): Promise<void> {
  const text = renderPrompt("company-info-resolved-resume", { short_id: short(req.id), label: req.label, needed_by: req.neededBy });
  clearAgentWaiting(req.requesterAgentId, req.id);
  patchCompanyRequest(req.id, { resumedAt: now() });
  const { onCompanyInfoResolved } = await import("@/lib/capabilities/manager");
  if (req.capabilityRequestId && (await onCompanyInfoResolved(req.capabilityRequestId, text))) return;
  const { sendAgentMessage } = await import("@/lib/runtime");
  void sendAgentMessage(req.requesterAgentId, text, { origin: "system", scopeId: req.executionScopeId }).catch((err) => console.error("[company] resume failed:", err));
}

export const waitingCompanyRequests = () => listCompanyRequests().filter((r) => r.status === "WAITING");
