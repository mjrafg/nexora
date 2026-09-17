/* ------------------------------------------------------------------
   Owner actions — persistence, and the projection of every other
   subsystem's open owner-facing request into one list.

   Native actions (a field an agent needs, a decision, a browser step,
   a turn-budget approval) are rows here. Everything else is projected
   live from the store that owns it, so there is exactly one record of a
   payment or a credential request and no synchronisation to get wrong.
   ------------------------------------------------------------------ */

import { now, readDb, updateDb } from "@/lib/store/db";
import type { OwnerAction, OwnerActionKind, OwnerActionMeta, OwnerActionSourceType } from "./types";

export const OWNER_ACTIONS_CHANNEL = "owner-actions";

const money = (n: number) => `$${n.toFixed(2)}`;

/* ---------------------------------------------------------------- native rows */

export function insertOwnerAction(a: OwnerAction): OwnerAction {
  updateDb((d) => {
    d.ownerActions.push(a);
    if (d.ownerActions.length > 2_000) d.ownerActions.splice(0, d.ownerActions.length - 2_000);
  });
  return a;
}

export function patchOwnerAction(id: string, patch: Partial<OwnerAction>): OwnerAction {
  return updateDb((d) => {
    const a = d.ownerActions.find((x) => x.id === id);
    if (!a) throw new Error("Owner action not found.");
    Object.assign(a, patch, { updatedAt: now() });
    return a;
  });
}

export const getNativeAction = (id: string) => readDb().ownerActions.find((a) => a.id === id) ?? null;

/* ---------------------------------------------------------------- projections */

const PREFIX: Record<Exclude<OwnerActionSourceType, "native">, string> = {
  credential: "credential",
  payment: "payment",
  capability: "capability",
  company: "company",
  browser_handoff: "browser",
};

export const projectionId = (type: Exclude<OwnerActionSourceType, "native">, id: string) => `${PREFIX[type]}:${id}`;

function meta(id: string): OwnerActionMeta {
  return readDb().ownerActionMeta.find((m) => m.id === id) ?? { id, notification: { state: "pending", count: 0 }, updatedAt: "1970-01-01T00:00:00.000Z" };
}

export function patchMeta(id: string, patch: Partial<OwnerActionMeta>): OwnerActionMeta {
  return updateDb((d) => {
    let m = d.ownerActionMeta.find((x) => x.id === id);
    if (!m) {
      m = { id, notification: { state: "pending", count: 0 }, updatedAt: now() };
      d.ownerActionMeta.push(m);
    }
    Object.assign(m, patch, { updatedAt: now() });
    if (d.ownerActionMeta.length > 2_000) d.ownerActionMeta.splice(0, d.ownerActionMeta.length - 2_000);
    return m;
  });
}

const agentName = (id: string) => readDb().agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);

/** Everything the owner is being asked for, from the stores that own those records. */
function projections(): OwnerAction[] {
  const db = readDb();
  const out: OwnerAction[] = [];
  const base = (id: string, patch: Partial<OwnerAction>): OwnerAction => {
    const m = meta(id);
    return {
      id, kind: "other", agentId: "", agentName: "", title: "", reason: "", status: "OPEN", blocking: true,
      createdAt: now(), updatedAt: now(), sourceRequestType: "native", notification: m.notification, viewedAt: m.viewedAt, payload: {},
      ...patch,
    } as OwnerAction;
  };

  for (const r of db.credentialRequests) {
    if (r.status !== "WAITING") continue;
    const id = projectionId("credential", r.id);
    out.push(base(id, {
      kind: "credential", agentId: r.requesterAgentId, agentName: r.requesterName, taskId: r.executionScopeId,
      title: `Login needed: ${r.service}`, reason: r.reason, blocking: true,
      createdAt: r.createdAt, updatedAt: r.updatedAt, sourceRequestType: "credential", sourceRequestId: r.id,
      payload: { details: [{ label: "Site", value: r.site }, { label: "Required", value: r.required }], href: `/credentials?request=${r.id}` },
      capabilityRequestId: r.capabilityRequestId,
    }));
  }

  for (const r of db.companyInfoRequests) {
    if (r.status !== "WAITING") continue;
    const id = projectionId("company", r.id);
    out.push(base(id, {
      kind: "data", agentId: r.requesterAgentId, agentName: r.requesterName, taskId: r.executionScopeId,
      title: `${r.label} needed`, reason: r.reason || `Needed for ${r.neededBy}.`, blocking: true,
      createdAt: r.createdAt, updatedAt: r.updatedAt, sourceRequestType: "company", sourceRequestId: r.id,
      payload: {
        fields: [{ key: r.field, label: r.label, type: "text", required: true, saveForFuture: true, help: `Needed for ${r.neededBy}.` }],
        href: `/company?request=${r.id}`,
      },
      capabilityRequestId: r.capabilityRequestId,
    }));
  }

  for (const r of db.paymentRequests) {
    const waiting = r.status === "WAITING_FOR_APPROVAL";
    const exception = !!r.exception && r.status === "PROCESSING";
    if (!waiting && !exception) continue;
    const id = projectionId("payment", r.id);
    out.push(base(id, {
      kind: "payment", agentId: r.requestedByAgentId, agentName: r.requestedByName, taskId: r.executionScopeId,
      title: exception ? `Payment needs review: ${r.merchant}` : `Approve ${money(r.amount)} to ${r.merchant}`,
      reason: exception ? r.exception! : r.reason, blocking: true,
      createdAt: r.createdAt, updatedAt: r.updatedAt, sourceRequestType: "payment", sourceRequestId: r.id,
      payload: {
        details: [
          { label: "Amount", value: `${money(r.amount)}${r.billingType === "RECURRING" ? ` / ${r.interval === "YEARLY" ? "year" : "month"}` : ""}` },
          { label: "Merchant", value: r.merchant },
          { label: "Reason", value: r.reason },
          ...(r.recommendation ? [{ label: "Recommendation", value: r.recommendation }] : []),
        ],
        choices: exception
          ? [{ value: "confirm", label: "Confirm as paid", style: "primary" as const }, { value: "fail", label: "Mark failed", style: "danger" as const }]
          : [{ value: "approve", label: "Approve", style: "primary" as const }, { value: "reject", label: "Decline", style: "danger" as const }],
        href: `/payments/requests?request=${r.id}`,
      },
      capabilityRequestId: r.capabilityRequestId,
    }));
  }

  for (const r of db.capabilityRequests) {
    // the Capability Manager resolves these itself; only a payment gate needs the owner
    if (r.status !== "WAITING_FOR_PAYMENT" || !r.payment || r.payment.decision) continue;
    if (r.payment.paymentRequestId) continue; // already projected as the payment above
    const id = projectionId("capability", r.id);
    out.push(base(id, {
      kind: "capability", agentId: r.requesterAgentId, agentName: r.requesterName,
      title: `Approve ${r.payment.cost} for ${r.payment.product}`, reason: r.payment.why || r.reason, blocking: true,
      createdAt: r.createdAt, updatedAt: r.updatedAt, sourceRequestType: "capability", sourceRequestId: r.id,
      payload: {
        details: [
          { label: "Capability", value: r.capability },
          { label: "Cost", value: r.payment.cost },
          { label: "Billing", value: r.payment.billing },
          ...(r.payment.alternatives ? [{ label: "Alternatives", value: r.payment.alternatives }] : []),
        ],
        choices: [{ value: "approve", label: "Approve", style: "primary" as const }, { value: "reject", label: "Decline", style: "danger" as const }],
        href: `/capabilities?request=${r.id}`,
      },
    }));
  }

  for (const h of db.browserHandoffs) {
    if (h.status !== "OPEN") continue;
    const id = projectionId("browser_handoff", h.id);
    out.push(base(id, {
      kind: h.mode === "INTERACTIVE" ? "browser" : "other",
      agentId: h.agentId, agentName: h.agentName, taskId: h.executionScopeId, sessionId: h.sessionKey,
      title: h.mode === "INTERACTIVE" ? `${h.agentName} needs you in the browser` : `${h.agentName} wants you to see its browser`,
      reason: h.reason, blocking: h.mode === "INTERACTIVE",
      createdAt: h.createdAt, updatedAt: h.updatedAt, sourceRequestType: "browser_handoff", sourceRequestId: h.id,
      browserSessionId: h.sessionKey,
      payload: { href: `/agents/${h.agentId}?browser=1` },
      capabilityRequestId: h.capabilityRequestId,
    }));
  }

  return out;
}

/* ---------------------------------------------------------------- the list */

const RANK: Record<OwnerActionKind, number> = {
  browser: 0, captcha: 0, otp: 1, turn_budget: 1, payment: 2, approval: 2, capability: 2, signature: 2, credential: 3, data: 3, decision: 3, other: 4,
};

/** Everything unresolved, blocking work first, then by urgency and age. */
export function listOpenOwnerActions(): OwnerAction[] {
  const native = readDb().ownerActions.filter((a) => a.status === "OPEN").map((a) => ({ ...a, ...pickMeta(a) }));
  return [...native, ...projections()].sort((a, b) => {
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
    if (RANK[a.kind] !== RANK[b.kind]) return RANK[a.kind] - RANK[b.kind];
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function pickMeta(a: OwnerAction): Partial<OwnerAction> {
  const m = readDb().ownerActionMeta.find((x) => x.id === a.id);
  return m ? { viewedAt: a.viewedAt ?? m.viewedAt } : {};
}

export function listRecentResolved(limit = 20): OwnerAction[] {
  return readDb().ownerActions.filter((a) => a.status !== "OPEN").sort((a, b) => (b.resolvedAt ?? b.updatedAt).localeCompare(a.resolvedAt ?? a.updatedAt)).slice(0, limit);
}

/** One action by id — native row or live projection. */
export function getOwnerAction(id: string): OwnerAction | null {
  return getNativeAction(id) ?? projections().find((a) => a.id === id) ?? null;
}

export const openOwnerActionCount = () => {
  const open = listOpenOwnerActions();
  return { total: open.length, blocking: open.filter((a) => a.blocking).length };
};

/** Stable content hash: notifications are sent once per action state, never repeated. */
export function actionHash(a: OwnerAction): string {
  return `${a.id}:${a.kind}:${a.title}:${a.blocking}:${a.payload.turns?.used ?? ""}`;
}

export { agentName };
