/* ------------------------------------------------------------------
   Owner actions — creating them, resolving them, and getting the agent
   moving again afterwards.

   Creation always persists the action first and only then parks the
   agent, so there can be no waiting state without something the owner
   can act on. Resolution of a projected action goes to the store that
   owns the record (Payments approves the payment, Credentials resolves
   the credential request); those paths already resume their agent, so
   this layer does not resume twice.
   ------------------------------------------------------------------ */

import { newId, now, readDb, updateDb } from "@/lib/store/db";
import { clearAgentWaiting, setAgentWaiting } from "@/lib/agents/waiting";
import { getPrompt, renderPrompt } from "@/lib/prompts";
import { emitActivity } from "@/lib/activity";
import { getNativeAction, getOwnerAction, insertOwnerAction, listOpenOwnerActions, OWNER_ACTIONS_CHANNEL, patchMeta, patchOwnerAction } from "./store";
import { notifyOwnerAction } from "./notify";
import type { OwnerAction, OwnerActionKind, OwnerActionPayload } from "./types";

const short = (id: string) => id.slice(0, 8);

function emit(event: string, detail: Record<string, unknown> = {}) {
  emitActivity({ agentId: OWNER_ACTIONS_CHANNEL, turnId: "owner-actions", kind: "status", title: "owner_action", detail: JSON.stringify({ event, ...detail }) });
}

export type CreateOwnerActionInput = {
  agentId: string;
  kind: OwnerActionKind;
  title: string;
  reason: string;
  blocking?: boolean;
  payload?: OwnerActionPayload;
  taskId?: string;
  sessionId?: string;
  sourceRequestType?: OwnerAction["sourceRequestType"];
  sourceRequestId?: string;
  capabilityRequestId?: string;
  /** collapse repeats of the same ask instead of interrupting again */
  dedupeKey?: string;
};

/**
 * Ask the owner for something. The action exists before the agent is
 * parked, and an identical open ask is reused rather than duplicated.
 */
export async function createOwnerAction(input: CreateOwnerActionInput): Promise<OwnerAction> {
  const agent = readDb().agents.find((a) => a.id === input.agentId);
  if (!agent) throw new Error("Agent not found.");
  const title = input.title.trim().slice(0, 160);
  const reason = input.reason.trim().slice(0, 1_000);
  if (!title) throw new Error("title is required.");
  if (!reason) throw new Error("reason is required: say why you cannot continue without the owner.");
  const blocking = input.blocking !== false;

  const key = input.dedupeKey ?? `${input.kind}:${title}`;
  const existing = readDb().ownerActions.find((a) => a.status === "OPEN" && a.agentId === agent.id && (a.payload as { dedupeKey?: string })?.dedupeKey === key);
  if (existing) {
    if (blocking) setAgentWaiting(agent.id, { kind: "owner_action", requestId: existing.id, label: existing.title });
    return existing;
  }

  const ts = now();
  const rec: OwnerAction = {
    id: newId(), kind: input.kind, agentId: agent.id, agentName: agent.name,
    taskId: input.taskId, sessionId: input.sessionId,
    title, reason, status: "OPEN", blocking,
    createdAt: ts, updatedAt: ts,
    sourceRequestType: input.sourceRequestType ?? "native", sourceRequestId: input.sourceRequestId,
    browserSessionId: input.sessionId,
    notification: { state: "pending", count: 0 },
    payload: { ...(input.payload ?? {}), ...({ dedupeKey: key } as object) },
    capabilityRequestId: input.capabilityRequestId,
  };
  insertOwnerAction(rec);
  // only now may the agent be parked: the thing it waits for already exists
  if (blocking) setAgentWaiting(agent.id, { kind: "owner_action", requestId: rec.id, label: title });
  emit("created", { id: rec.id, kind: rec.kind, agent: agent.name, blocking });
  console.log(`[owner-action] #${short(rec.id)} ${rec.kind}${blocking ? " (blocking)" : ""} from ${agent.name}: ${title}`);
  await notifyOwnerAction(rec).catch((err) => console.error("[owner-action] notify failed:", err));
  return rec;
}

/** The owner opened it — recorded for the audit trail, and stops it re-notifying. */
export function markViewed(id: string): void {
  const a = getOwnerAction(id);
  if (!a || a.viewedAt) return;
  if (a.sourceRequestType === "native") patchOwnerAction(id, { viewedAt: now() });
  else patchMeta(id, { viewedAt: now() });
}

export type ResolveInput = {
  /** the choice the owner made, or the submitted values for a data action */
  choice?: string;
  values?: Record<string, string>;
  /** per-field: keep the answer for future tasks */
  save?: Record<string, boolean>;
  note?: string;
};

/**
 * Resolve an action. Projections delegate to the store that owns the
 * record; native actions resolve here and resume their agent.
 */
export async function resolveOwnerAction(id: string, input: ResolveInput = {}): Promise<OwnerAction> {
  const action = getOwnerAction(id);
  if (!action) throw new Error("Owner action not found.");
  if (action.status !== "OPEN") return action;

  if (action.sourceRequestType !== "native") {
    await resolveProjection(action, input);
    emit("resolved", { id, kind: action.kind, source: action.sourceRequestType });
    return { ...action, status: "RESOLVED", resolvedAt: now(), resolution: { by: "owner", choice: input.choice, note: input.note, at: now() } };
  }

  const resolved = patchOwnerAction(id, { status: "RESOLVED", resolvedAt: now(), resolution: { by: "owner", choice: input.choice ?? "submitted", note: input.note?.slice(0, 500), at: now() } });
  clearAgentWaiting(action.agentId, id);
  const summary = await applyNative(action, input);
  emit("resolved", { id, kind: action.kind });
  await resumeAgent(action, summary);
  return resolved;
}

export async function cancelOwnerAction(id: string, note?: string): Promise<OwnerAction> {
  const action = getOwnerAction(id);
  if (!action) throw new Error("Owner action not found.");
  if (action.status !== "OPEN") return action;
  if (action.sourceRequestType !== "native") {
    await cancelProjection(action, note);
    emit("cancelled", { id, source: action.sourceRequestType });
    return { ...action, status: "CANCELLED" };
  }
  const cancelled = patchOwnerAction(id, { status: "CANCELLED", resolvedAt: now(), resolution: { by: "owner", choice: "dismissed", note: note?.slice(0, 500), at: now() } });
  clearAgentWaiting(action.agentId, id);
  emit("cancelled", { id });
  await resumeAgent(action, renderPrompt("owner-action-dismissed", { note: note ? ` — note: ${note}` : "" }));
  return cancelled;
}

/* ---------------------------------------------------------------- native kinds */

/** Store submitted data where it belongs and return what to tell the agent. */
async function applyNative(action: OwnerAction, input: ResolveInput): Promise<string> {
  switch (action.kind) {
    case "data": {
      const fields = action.payload.fields ?? [];
      const values = input.values ?? {};
      const lines: string[] = [];
      for (const f of fields) {
        const raw = (values[f.key] ?? "").trim();
        if (!raw) continue;
        const keep = input.save?.[f.key] ?? false;
        if (keep) await storeValue(f.key, raw, f.type);
        lines.push(`${f.label}: ${raw}${keep ? " (saved for future use)" : " (for this task only)"}`);
      }
      return lines.length
        ? renderPrompt("owner-action-data-provided", { values: lines.join("\n") })
        : getPrompt("owner-action-data-empty");
    }
    case "turn_budget": {
      const grant = Number(input.values?.grant ?? action.payload.turns?.grant ?? 100);
      const unlimited = input.choice === "until_done";
      if (input.choice === "stop") return getPrompt("owner-action-turns-stopped");
      grantTurns(action.agentId, action.taskId, unlimited ? 100_000 : grant);
      return renderPrompt("owner-action-turns-granted", { grant: unlimited ? "as many steps as the task needs" : `${grant} more steps` });
    }
    case "captcha":
    case "browser": {
      return getPrompt("owner-action-browser-finished");
    }
    default: {
      return renderPrompt("owner-action-decision", {
        choice: input.choice ? `The owner chose: ${input.choice}.` : "The owner responded.",
        note: input.note ? ` Note: ${input.note}` : "",
      });
    }
  }
}

/** Canonical profile field when the key is one, Custom Data otherwise. Never a secret. */
async function storeValue(key: string, value: string, type: string): Promise<void> {
  const { findField } = await import("@/lib/company/store");
  const canonical = findField(key);
  if (canonical) {
    const { updateProfile } = await import("@/lib/company/store");
    const patch: Record<string, unknown> = {};
    const map: Record<string, string> = { name: "name", legal_name: "legalName", entity_type: "entityType", industry: "industry", website: "website", description: "description", timezone: "timezone" };
    if (map[canonical.key]) patch[map[canonical.key]] = value;
    else if (canonical.key.startsWith("legal.")) patch.legal = { [canonical.key.slice(6).replace(/_(.)/g, (_, c) => c.toUpperCase())]: value };
    if (Object.keys(patch).length) { updateProfile(patch as never); return; }
  }
  const { upsertCustomDatum } = await import("@/lib/company/custom-data");
  const valueType = ["date", "number", "boolean", "email", "phone", "url", "json"].includes(type) ? type : "string";
  upsertCustomDatum({ key, value, valueType: valueType as never, status: "verified", reason: "Provided by the owner when an agent asked for it." }, { kind: "owner" });
}

/* ---------------------------------------------------------------- projections */

async function resolveProjection(action: OwnerAction, input: ResolveInput): Promise<void> {
  const id = action.sourceRequestId!;
  switch (action.sourceRequestType) {
    case "payment": {
      const { approvePaymentRequest, rejectPaymentRequest, resolveException } = await import("@/lib/payments/service");
      if (input.choice === "confirm" || input.choice === "fail") { resolveException(id, input.choice === "confirm" ? "SUCCEEDED" : "FAILED", input.note); return; }
      if (input.choice === "reject") { await rejectPaymentRequest(id, input.note); return; }
      await approvePaymentRequest(id, input.values?.paymentMethodId ?? null, input.note);
      return;
    }
    case "capability": {
      const { decidePayment } = await import("@/lib/capabilities/manager");
      decidePayment(id, input.choice === "reject" ? "rejected" : "approved", input.note);
      return;
    }
    case "company": {
      // the owner answered inline: store the value, which resolves the request and resumes the agent
      const field = action.payload.fields?.[0];
      const value = (input.values?.[field?.key ?? ""] ?? "").trim();
      if (!value) {
        const { resolveCompanyInfoRequest } = await import("@/lib/company/service");
        await resolveCompanyInfoRequest(id, "owner");
        return;
      }
      await storeValue(field!.key, value, field!.type);
      const { resolveFilledRequests } = await import("@/lib/company/service");
      const done = await resolveFilledRequests();
      if (!done.some((r) => r.id === id)) {
        const { resolveCompanyInfoRequest } = await import("@/lib/company/service");
        await resolveCompanyInfoRequest(id, "owner");
      }
      return;
    }
    case "browser_handoff": {
      const { closeHandoff } = await import("@/lib/browser/handoff");
      await closeHandoff(id, "RETURNED", input.note);
      return;
    }
    case "credential":
    default:
      throw new Error("Add the login on the Credentials page — Nexora never takes a password through this form.");
  }
}

async function cancelProjection(action: OwnerAction, note?: string): Promise<void> {
  const id = action.sourceRequestId!;
  switch (action.sourceRequestType) {
    case "payment": {
      const { rejectPaymentRequest, cancelPaymentRequest } = await import("@/lib/payments/service");
      const req = readDb().paymentRequests.find((r) => r.id === id);
      if (req?.status === "WAITING_FOR_APPROVAL") await rejectPaymentRequest(id, note);
      else cancelPaymentRequest(id, "owner", note);
      return;
    }
    case "capability": {
      const { decidePayment } = await import("@/lib/capabilities/manager");
      decidePayment(id, "rejected", note);
      return;
    }
    case "company": {
      const { cancelCompanyInfoRequest } = await import("@/lib/company/service");
      cancelCompanyInfoRequest(id);
      return;
    }
    case "credential": {
      const { cancelCredentialRequest } = await import("@/lib/credentials/service");
      cancelCredentialRequest(id);
      return;
    }
    case "browser_handoff": {
      const { closeHandoff } = await import("@/lib/browser/handoff");
      await closeHandoff(id, "CANCELLED", note);
      return;
    }
    default:
      return;
  }
}

/* ---------------------------------------------------------------- resume */

async function resumeAgent(action: OwnerAction, summary: string): Promise<void> {
  const text = renderPrompt("owner-action-resume", {
    title: action.title,
    summary,
    scope_note: action.taskId ? `scope ${short(action.taskId)}` : "your current work",
  });
  const { onCompanyInfoResolved } = await import("@/lib/capabilities/manager");
  if (action.capabilityRequestId && (await onCompanyInfoResolved(action.capabilityRequestId, text))) return;
  const { sendAgentMessage } = await import("@/lib/runtime");
  void sendAgentMessage(action.agentId, text, { origin: "system", scopeId: action.taskId }).catch((err) => console.error("[owner-action] resume failed:", err));
}

/* ---------------------------------------------------------------- turn budget */

/** Extra steps the owner granted to one task, consumed by the runtime on the next turn. */
export function grantTurns(agentId: string, scopeId: string | undefined, extra: number): void {
  updateDb((d) => {
    d.turnGrants = d.turnGrants.filter((g) => g.agentId !== agentId || g.scopeId !== (scopeId ?? ""));
    d.turnGrants.push({ agentId, scopeId: scopeId ?? "", extra, grantedAt: now() });
    if (d.turnGrants.length > 200) d.turnGrants.splice(0, d.turnGrants.length - 200);
  });
}

export function takeTurnGrant(agentId: string, scopeId?: string): number {
  const g = readDb().turnGrants.find((x) => x.agentId === agentId && x.scopeId === (scopeId ?? ""));
  return g?.extra ?? 0;
}

export function clearTurnGrant(agentId: string, scopeId?: string): void {
  updateDb((d) => { d.turnGrants = d.turnGrants.filter((x) => x.agentId !== agentId || x.scopeId !== (scopeId ?? "")); });
}

/** Reconcile: drop open actions whose agent is gone, and unpark agents whose action is gone. */
export function reconcileOwnerActions(): { closed: number } {
  let closed = 0;
  const db = readDb();
  for (const a of listOpenOwnerActions()) {
    if (a.sourceRequestType !== "native") continue;
    if (!db.agents.some((x) => x.id === a.agentId)) {
      patchOwnerAction(a.id, { status: "CANCELLED", resolvedAt: now(), resolution: { by: "system", choice: "agent removed", at: now() } });
      closed += 1;
    }
  }
  return { closed };
}

export { getOwnerAction, listOpenOwnerActions, getNativeAction };
