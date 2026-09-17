/* ------------------------------------------------------------------
   Capability requests + activity — persistence (file-backed store) and the
   live activity channel the UI subscribes to.
   ------------------------------------------------------------------ */

import { emitActivity } from "@/lib/activity";
import { clearAgentWaiting, setAgentWaiting } from "@/lib/agents/waiting";
import { newId, now, readDb, updateDb } from "@/lib/store/db";
import type { CapabilityActivity, CapabilityActivityKind, CapabilityRecord, CapabilityRequest, CapabilityRequestStatus } from "./types";
import { OPEN_REQUEST_STATES } from "./types";

/** activity-bus channel for everything the Capability Manager does */
export const CAPABILITY_CHANNEL = "capability-manager";

export function listRequests(): CapabilityRequest[] {
  return readDb().capabilityRequests.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getRequest(id: string): CapabilityRequest | null {
  return readDb().capabilityRequests.find((r) => r.id === id) ?? null;
}

/** id, or an unambiguous id prefix (agents refer to requests by their 8-char short id) */
export function findRequest(ref: string): CapabilityRequest | null {
  const all = readDb().capabilityRequests;
  const exact = all.find((r) => r.id === ref);
  if (exact) return exact;
  const hits = all.filter((r) => r.id.startsWith(ref));
  return hits.length === 1 ? hits[0] : null;
}

export function openRequests(): CapabilityRequest[] {
  return listRequests().filter((r) => OPEN_REQUEST_STATES.includes(r.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function createRequest(input: { requesterAgentId: string; requesterName: string; capability: string; reason: string; context: string; executionScopeId?: string }): CapabilityRequest {
  const ts = now();
  const rec: CapabilityRequest = {
    id: newId(),
    requesterAgentId: input.requesterAgentId,
    requesterName: input.requesterName,
    capability: input.capability.slice(0, 200),
    reason: input.reason.slice(0, 2_000),
    context: input.context.slice(0, 6_000),
    status: "PENDING",
    executionScopeId: input.executionScopeId,
    turns: 0,
    createdAt: ts,
    updatedAt: ts,
  };
  updateDb((d) => {
    d.capabilityRequests.push(rec);
  });
  return rec;
}

export function patchRequest(id: string, patch: Partial<CapabilityRequest>): CapabilityRequest {
  return updateDb((d) => {
    const r = d.capabilityRequests.find((x) => x.id === id);
    if (!r) throw new Error("Capability request not found.");
    Object.assign(r, patch, { updatedAt: now() });
    return r;
  });
}

export function setRequestStatus(id: string, status: CapabilityRequestStatus, note?: string): CapabilityRequest {
  const patch: Partial<CapabilityRequest> = { status };
  if (note !== undefined) patch.note = note.slice(0, 300);
  if (status === "RESOLVED" || status === "FAILED") patch.resolvedAt = now();
  return patchRequest(id, patch);
}

/* ---------------------------------------------------------------- activity */

export function addCapabilityActivity(requestId: string | null, kind: CapabilityActivityKind, text: string, detail?: string): CapabilityActivity {
  const rec: CapabilityActivity = { id: newId(), requestId, ts: Date.now(), kind, text: text.slice(0, 500), detail: detail?.slice(0, 4_000) ?? null };
  updateDb((d) => {
    d.capabilityActivity.push(rec);
    if (d.capabilityActivity.length > 5000) d.capabilityActivity.splice(0, d.capabilityActivity.length - 5000);
  });
  emitActivity({ agentId: CAPABILITY_CHANNEL, turnId: requestId ?? "capability", kind: "status", title: `activity:${kind}`, detail: rec.text, meta: rec.detail ?? undefined });
  return rec;
}

export function listCapabilityActivity(limit = 300, requestId?: string): CapabilityActivity[] {
  return readDb()
    .capabilityActivity.filter((a) => !requestId || a.requestId === requestId)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

/* ---------------------------------------------------------------- explicit capabilities */

export function upsertCapability(input: Omit<CapabilityRecord, "createdAt" | "updatedAt" | "id"> & { id?: string }): CapabilityRecord {
  return updateDb((d) => {
    const id = input.id ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    const ts = now();
    let rec = d.capabilities.find((c) => c.id === id);
    if (rec) Object.assign(rec, { ...input, id, updatedAt: ts });
    else {
      rec = { ...input, id, createdAt: ts, updatedAt: ts };
      d.capabilities.push(rec);
    }
    return rec;
  });
}

/** Point the requester at its capability request (or clear it). The request must already be persisted. */
export function requesterWaiting(agentId: string, waiting: { requestId: string; capability: string } | null): void {
  if (waiting) setAgentWaiting(agentId, { kind: "capability", requestId: waiting.requestId, label: waiting.capability });
  else clearAgentWaiting(agentId);
}
