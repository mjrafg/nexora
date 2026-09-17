/* ------------------------------------------------------------------
   Payments — the deterministic rules.

     request  → amount <= autoApproveLimit ? AUTO_APPROVED : WAITING_FOR_APPROVAL
     approve  → APPROVED (+ 30-min execution authorization) → agent resumes
     reject   → REJECTED → agent resumes (no secrets ever issued)
     insert   → agent picks a method by its usage description, Nexora types
                the vault values into the agent's browser → PROCESSING
     complete → SUCCEEDED / FAILED (amount validated) → transaction row

   No LLM decides approval; the threshold rule lives here. The LLM never
   receives card or bank numbers: it decides WHERE (which method, which
   browser fields), Nexora supplies WHAT.
   ------------------------------------------------------------------ */

import { newId, now, readDb } from "@/lib/store/db";
import { clearAgentWaiting, setAgentWaiting } from "@/lib/agents/waiting";
import { renderPrompt } from "@/lib/prompts";
import { handleBrowserTool } from "@/lib/browser/host";
import { browserScopeFor } from "@/lib/browser";
import type { ToolCallContext } from "@/lib/tools/internal";
import {
  activeAuthorization, emitPaymentEvent, getMethod, getRequest, getSettings, insertAuthorization, insertRequest, insertTransaction, listRequests, listTransactions, methodLabel, methodSecrets, patchRequest, recordMethodUse, settleAuthorizations,
} from "./store";
import type { BillingInterval, BillingType, PaymentAuthorization, PaymentMethod, PaymentOverview, PaymentRequest, PaymentTransaction, PreferredMethod } from "./types";

export const AUTHORIZATION_TTL_MS = 30 * 60_000;
const short = (id: string) => id.slice(0, 8);

export function money(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

/* ---------------------------------------------------------------- request */

export type CreateRequestInput = {
  agentId: string;
  merchant: string;
  amount: number;
  currency?: string;
  reason: string;
  billingType?: BillingType;
  interval?: BillingInterval;
  preferredMethod?: PreferredMethod;
  recommendation?: string;
  executionScopeId?: string;
  capabilityRequestId?: string;
};

export function createPaymentRequest(input: CreateRequestInput): PaymentRequest {
  const agent = readDb().agents.find((a) => a.id === input.agentId);
  if (!agent) throw new Error("Agent not found.");
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount < 0) throw new Error("amount must be a non-negative number.");
  if ((input.currency ?? "USD").toUpperCase() !== "USD") throw new Error("Only USD is supported in this version.");
  if (!input.merchant.trim()) throw new Error("merchant is required.");
  const settings = getSettings();
  const billingType: BillingType = input.billingType === "RECURRING" || input.interval ? "RECURRING" : "ONE_TIME";
  const auto = amount <= settings.autoApproveLimit;
  const ts = now();
  const rec: PaymentRequest = {
    id: newId(),
    requestedByAgentId: agent.id,
    requestedByName: agent.name,
    merchant: input.merchant.trim().slice(0, 120),
    amount,
    currency: "USD",
    reason: input.reason.trim().slice(0, 1_000),
    billingType,
    interval: billingType === "RECURRING" ? input.interval ?? "MONTHLY" : undefined,
    preferredMethod: input.preferredMethod ?? "ANY",
    recommendation: input.recommendation?.trim().slice(0, 600) || undefined,
    status: auto ? "AUTO_APPROVED" : "WAITING_FOR_APPROVAL",
    approvalType: auto ? "AUTOMATIC" : "NONE",
    selectedPaymentMethodId: null,
    approvalThresholdAtCreation: settings.autoApproveLimit,
    approvedAt: auto ? ts : undefined,
    approvedBy: auto ? "nexora" : undefined,
    executionScopeId: input.executionScopeId,
    capabilityRequestId: input.capabilityRequestId,
    createdAt: ts,
    updatedAt: ts,
  };
  insertRequest(rec);
  if (auto) {
    // the agent chooses any AVAILABLE method by its usage description at checkout
    issueAuthorization(rec, null);
    console.log(`[payments] auto-approved ${money(amount)} for ${rec.merchant} (limit ${money(settings.autoApproveLimit)}) #${short(rec.id)}`);
    emitPaymentEvent("auto_approved", `${rec.requestedByName}: ${rec.merchant} ${money(amount)} auto-approved`, { id: rec.id });
  } else {
    // the owner has to decide before the agent can go on — make that visible on the agent
    setAgentWaiting(rec.requestedByAgentId, { kind: "payment", requestId: rec.id, label: `${rec.merchant} (${money(amount)})` });
    console.log(`[payments] approval needed ${money(amount)} for ${rec.merchant} (limit ${money(settings.autoApproveLimit)}) #${short(rec.id)}`);
    emitPaymentEvent("requested", `${rec.requestedByName}: ${rec.merchant} ${money(amount)} needs your approval`, { id: rec.id });
  }
  return rec;
}

export function availableMethods(): PaymentMethod[] {
  return readDb().paymentMethods.filter((m) => m.status === "AVAILABLE");
}

function snapshotOf(m: PaymentMethod | null): PaymentRequest["methodSnapshot"] {
  return m ? { type: m.type, displayName: m.displayName, last4: m.last4, brand: m.type === "CARD" ? m.brand : m.accountType } : undefined;
}

/** methodId null → the agent chooses any AVAILABLE method by its usage description. */
function issueAuthorization(req: PaymentRequest, methodId: string | null) {
  if (methodId) patchRequest(req.id, { methodSnapshot: snapshotOf(getMethod(methodId)) });
  settleAuthorizations(req.id, "REVOKED");
  insertAuthorization({ id: newId(), paymentRequestId: req.id, paymentMethodId: methodId, agentId: req.requestedByAgentId, maxAmount: req.amount, currency: "USD", createdAt: now(), expiresAt: new Date(Date.now() + AUTHORIZATION_TTL_MS).toISOString(), status: "ACTIVE" });
}

/* ---------------------------------------------------------------- owner decisions */

/** paymentMethodId null → the agent picks the method whose usage description fits the checkout. */
export async function approvePaymentRequest(id: string, paymentMethodId: string | null, note?: string): Promise<PaymentRequest> {
  const req = getRequest(id);
  if (!req) throw new Error("Payment request not found.");
  if (req.status !== "WAITING_FOR_APPROVAL") throw new Error(`This request is ${req.status}, not waiting for approval.`);
  const method = paymentMethodId ? getMethod(paymentMethodId) : null;
  if (paymentMethodId && !method) throw new Error("Payment method not found.");
  if (method && method.status !== "AVAILABLE") throw new Error(`${method.displayName} is disabled.`);
  if (!method && !availableMethods().length) throw new Error("Add a payment method first (none available).");
  const updated = patchRequest(id, { status: "APPROVED", approvalType: "OWNER", selectedPaymentMethodId: method?.id ?? null, approvedBy: "owner", approvedAt: now(), ownerNote: note?.slice(0, 500) });
  issueAuthorization(updated, method?.id ?? null);
  console.log(`[payments] owner approved #${short(id)} ${money(req.amount)} ${req.merchant} via ${method ? methodLabel(method) : "agent's choice"}`);
  emitPaymentEvent("approved", `You approved ${req.merchant} ${money(req.amount)} (${method ? methodLabel(method) : "agent chooses the method"})`, { id });
  await wakeRequester(updated, "approved", note);
  return updated;
}

export async function rejectPaymentRequest(id: string, note?: string): Promise<PaymentRequest> {
  const req = getRequest(id);
  if (!req) throw new Error("Payment request not found.");
  if (!["WAITING_FOR_APPROVAL", "AUTO_APPROVED", "APPROVED"].includes(req.status)) throw new Error(`This request is ${req.status} and cannot be rejected.`);
  settleAuthorizations(id, "REVOKED");
  const updated = patchRequest(id, { status: "REJECTED", approvalType: "REJECTED", rejectedAt: now(), ownerNote: note?.slice(0, 500) });
  recordTransaction(updated, "REJECTED");
  console.log(`[payments] owner rejected #${short(id)} ${money(req.amount)} ${req.merchant}`);
  emitPaymentEvent("rejected", `You rejected ${req.merchant} ${money(req.amount)}`, { id });
  await wakeRequester(updated, "rejected", note);
  return updated;
}

export function cancelPaymentRequest(id: string, by: string, note?: string): PaymentRequest {
  const req = getRequest(id);
  if (!req) throw new Error("Payment request not found.");
  if (["SUCCEEDED", "FAILED", "REJECTED", "CANCELLED"].includes(req.status)) throw new Error(`This request is already ${req.status}.`);
  settleAuthorizations(id, "REVOKED");
  const updated = patchRequest(id, { status: "CANCELLED", completionNote: note?.slice(0, 500), completedAt: now() });
  clearAgentWaiting(req.requestedByAgentId, id);
  recordTransaction(updated, "CANCELLED");
  emitPaymentEvent("cancelled", `${req.merchant} ${money(req.amount)} cancelled by ${by}`, { id });
  // whoever asked for the money is waiting on the answer — "cancelled" is an
  // answer, and it has to reach them
  void wakeCancelled(updated, by, note).catch((err) => console.error("[payments] cancellation resume failed:", err));
  return updated;
}

/** Owner resolves an amount exception: confirm success at the reported amount, or mark failed. */
export function resolveException(id: string, status: "SUCCEEDED" | "FAILED", note?: string): PaymentRequest {
  const req = getRequest(id);
  if (!req) throw new Error("Payment request not found.");
  if (!req.exception) throw new Error("This request has no open exception.");
  settleAuthorizations(id, "USED");
  const updated = patchRequest(id, { status, exception: undefined, completionNote: note?.slice(0, 500) ?? req.completionNote, completedAt: now() });
  recordTransaction(updated, status);
  emitPaymentEvent(status === "SUCCEEDED" ? "succeeded" : "failed", `${req.merchant} ${money(req.actualAmount ?? req.amount)} marked ${status.toLowerCase()} by owner`, { id });
  return updated;
}

/* ---------------------------------------------------------------- agent execution */

export class PaymentDenied extends Error {}

/** The request must be this agent's, approved, and carry a live authorization. */
function requireAuthorization(req: PaymentRequest, agentId: string): PaymentAuthorization {
  if (req.requestedByAgentId !== agentId) throw new PaymentDenied("DENIED: this payment request belongs to another agent.");
  if (req.status === "SUCCEEDED") throw new PaymentDenied("DENIED: this payment already succeeded; do not pay again.");
  if (req.status === "WAITING_FOR_APPROVAL") throw new PaymentDenied("DENIED: this payment is waiting for the owner's approval. End your turn; you will be resumed with the decision.");
  if (req.status === "REJECTED") throw new PaymentDenied("DENIED: the owner rejected this payment. No payment details will be inserted.");
  if (["FAILED", "CANCELLED"].includes(req.status)) throw new PaymentDenied(`DENIED: this request is ${req.status}. Create a new payment request if the purchase is still needed.`);
  if (req.exception) throw new PaymentDenied("DENIED: an amount exception is open on this request; the owner must review it first.");
  const auth = activeAuthorization(req.id, agentId);
  if (!auth) throw new PaymentDenied("DENIED: no active payment authorization (it expires 30 minutes after approval). Ask the owner to re-approve, or create a new request.");
  return auth;
}

/** Which method may this authorization use: the owner's explicit choice, or any AVAILABLE one. */
function resolveMethod(auth: PaymentAuthorization, method: PaymentMethod): void {
  if (method.status !== "AVAILABLE") throw new PaymentDenied(`DENIED: payment method "${method.displayName}" is disabled. Call list_payment_methods and choose another.`);
  if (auth.paymentMethodId && auth.paymentMethodId !== method.id) {
    const chosen = getMethod(auth.paymentMethodId);
    throw new PaymentDenied(`DENIED: the owner approved this payment specifically with ${chosen ? methodLabel(chosen) : "another method"}${chosen ? ` (id ${chosen.id})` : ""}; use that one.`);
  }
}

export type CheckoutDetails = { maxAmount: number; currency: "USD"; expiresAt: string; method: PaymentMethod | null; billing?: PaymentMethod["billing"] };

/** Mark the checkout as started. Returns non-secret details only (secrets are inserted by insertPaymentMethodFields). */
export function beginPayment(id: string, agentId: string): { request: PaymentRequest; details: CheckoutDetails } {
  const req = getRequest(id);
  if (!req) throw new Error("Payment request not found.");
  const auth = requireAuthorization(req, agentId);
  const method = getMethod(auth.paymentMethodId ?? req.selectedPaymentMethodId);
  if (auth.paymentMethodId && !method) throw new Error("The approved payment method no longer exists.");
  if (req.status !== "PROCESSING") {
    patchRequest(id, { status: "PROCESSING" });
    console.log(`[payments] checkout began #${short(id)} ${money(req.amount)} ${req.merchant}${method ? ` via ${methodLabel(method)}` : ""} by ${agentId}`);
    emitPaymentEvent("processing", `${req.requestedByName} is paying ${req.merchant} ${money(req.amount)}${method ? ` with ${method.displayName} •••• ${method.last4}` : ""}`, { id });
  }
  return { request: getRequest(id)!, details: { maxAmount: auth.maxAmount, currency: "USD", expiresAt: auth.expiresAt, method, billing: method?.billing } };
}

/* ---------------------------------------------------------------- browser insertion */

export const CARD_FIELDS = ["cardholder_name", "card_number", "expiration", "expiration_month", "expiration_year", "expiration_year_short", "cvv", "billing_line1", "billing_city", "billing_region", "billing_postal_code", "billing_country"] as const;
export const BANK_FIELDS = ["account_holder", "routing_number", "account_number", "account_type", "bank_name", "billing_line1", "billing_city", "billing_region", "billing_postal_code", "billing_country"] as const;
export type PaymentField = (typeof CARD_FIELDS)[number] | (typeof BANK_FIELDS)[number];

const FIELD_LABEL: Record<string, string> = {
  cardholder_name: "Cardholder", card_number: "Card number", expiration: "Expiration", expiration_month: "Expiration month", expiration_year: "Expiration year", expiration_year_short: "Expiration year", cvv: "Security code",
  account_holder: "Account holder", routing_number: "Routing number", account_number: "Account number", account_type: "Account type", bank_name: "Bank name",
  billing_line1: "Billing address", billing_city: "Billing city", billing_region: "Billing state", billing_postal_code: "Billing ZIP", billing_country: "Billing country",
};

function fieldValue(m: PaymentMethod, field: PaymentField): string | null {
  const s = methodSecrets(m);
  const b = m.billing ?? {};
  switch (field) {
    case "cardholder_name": return s.CARDHOLDER_NAME ?? m.cardholderName ?? null;
    case "card_number": return s.CARD_NUMBER ?? null;
    case "expiration": return s.EXP_MONTH && s.EXP_YEAR ? `${s.EXP_MONTH}/${s.EXP_YEAR.slice(-2)}` : null;
    case "expiration_month": return s.EXP_MONTH ?? null;
    case "expiration_year": return s.EXP_YEAR ?? null;
    case "expiration_year_short": return s.EXP_YEAR ? s.EXP_YEAR.slice(-2) : null;
    case "cvv": return s.CVV ?? null;
    case "account_holder": return s.ACCOUNT_HOLDER_NAME ?? m.accountHolderName ?? null;
    case "routing_number": return s.ROUTING_NUMBER ?? null;
    case "account_number": return s.ACCOUNT_NUMBER ?? null;
    case "account_type": return s.ACCOUNT_TYPE ?? m.accountType ?? null;
    case "bank_name": return m.bankName ?? null;
    case "billing_line1": return b.line1 ?? null;
    case "billing_city": return b.city ?? null;
    case "billing_region": return b.region ?? null;
    case "billing_postal_code": return b.postalCode ?? null;
    case "billing_country": return b.country ?? m.country ?? null;
    default: return null;
  }
}

function targetArgs(target: string): { ref?: string; selector?: string } {
  const t = target.trim();
  if (/^((f\d+)?e\d+|t\d+)$/i.test(t)) return { ref: t };
  return { selector: t };
}

const resultText = (r: { content?: { type: string; text?: string }[]; text?: string }) => (r.content ? r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n") : r.text ?? "");

export type InsertOutcome = { request: PaymentRequest; method: PaymentMethod; filled: PaymentField[] };

/**
 * Type the chosen method's values into the agent's own browser session.
 * `fields` maps logical payment field → snapshot ref / CSS selector. Never
 * returns a value; the caller reports only which fields were filled.
 */
export async function insertPaymentMethodFields(input: { requestId: string; method: PaymentMethod; fields: Record<string, string>; ctx: ToolCallContext; browserKey?: string }): Promise<InsertOutcome> {
  const { method, ctx } = input;
  const req = getRequest(input.requestId);
  if (!req) throw new PaymentDenied("DENIED: payment request not found. Call request_payment first.");
  const auth = requireAuthorization(req, ctx.agentId);
  resolveMethod(auth, method);
  const allowed: readonly string[] = method.type === "CARD" ? CARD_FIELDS : BANK_FIELDS;
  const entries = Object.entries(input.fields).map(([k, v]) => [k.trim().toLowerCase().replace(/[\s-]+/g, "_"), String(v ?? "").trim()] as [string, string]).filter(([, v]) => v);
  if (!entries.length) throw new Error(`fields must map at least one of ${allowed.join(", ")} to an element ref.`);
  for (const [k] of entries) if (!allowed.includes(k)) throw new Error(`Unknown field "${k}" for a ${method.type === "CARD" ? "card" : "bank account"}. Allowed: ${allowed.join(", ")}.`);
  // the agent may only drive its own browser sessions
  const key = input.browserKey && input.browserKey.startsWith(`agent:${ctx.agentId}`) ? input.browserKey : undefined;
  const scope = browserScopeFor(ctx.agentId, key);
  const filled: PaymentField[] = [];
  for (const [field, target] of entries) {
    const value = fieldValue(method, field as PaymentField);
    if (value === null || value === "") throw new Error(`"${method.displayName}" has no ${FIELD_LABEL[field] ?? field}${field === "cvv" ? " (the owner did not store a CVV for this card)" : ""}${filled.length ? ` — already filled: ${filled.join(", ")}` : ""}.`);
    const element = `${FIELD_LABEL[field] ?? field} (${method.displayName})`;
    let r = field === "account_type" ? await handleBrowserTool(scope, "browser_select", { ...targetArgs(target), values: [value, value.charAt(0) + value.slice(1).toLowerCase(), value.toLowerCase()], element }) : null;
    if (!r || r.isError) r = await handleBrowserTool(scope, "browser_type", { ...targetArgs(target), text: value, sensitive: true, element });
    if (r.isError) throw new Error(`${FIELD_LABEL[field] ?? field} → ${target}: ${resultText(r).split(value).join("•••")}${filled.length ? ` (already filled: ${filled.join(", ")})` : ""}`);
    ctx.emit.event({ kind: "browser", title: `Payment method inserted: ${method.displayName} · ${FIELD_LABEL[field] ?? field}`, meta: "Payments", status: "done", browser: { action: "type", value: "•••", url: r.report?.url, title: r.report?.title, ref: target } });
    filled.push(field as PaymentField);
  }
  const first = req.status !== "PROCESSING" || req.selectedPaymentMethodId !== method.id;
  const updated = patchRequest(req.id, { status: "PROCESSING", selectedPaymentMethodId: method.id, methodSnapshot: snapshotOf(method) });
  recordMethodUse(method.id, ctx.agentId);
  const label = `${method.displayName} (${method.type === "CARD" ? method.brand : method.accountType} •••• ${method.last4})`;
  console.log(`[payments] inserted ${filled.join(",")} of ${label} for #${short(req.id)} ${req.merchant} by ${ctx.agentId}`);
  emitPaymentEvent("method_inserted", `${req.requestedByName} inserted ${label} at ${req.merchant}: ${filled.map((f) => FIELD_LABEL[f] ?? f).join(", ")}`, { id: req.id, methodId: method.id });
  if (first) emitPaymentEvent("processing", `${req.requestedByName} is paying ${req.merchant} ${money(req.amount)} with ${method.displayName} •••• ${method.last4}`, { id: req.id });
  return { request: updated, method, filled };
}

export function completePayment(id: string, agentId: string, input: { status: "SUCCEEDED" | "FAILED"; actualAmount?: number; externalReference?: string; note?: string }): PaymentRequest {
  const req = getRequest(id);
  if (!req) throw new Error("Payment request not found.");
  if (req.requestedByAgentId !== agentId) throw new Error("This payment request belongs to another agent.");
  if (req.status === "SUCCEEDED") throw new Error("This payment is already recorded as succeeded.");
  if (!["PROCESSING", "AUTO_APPROVED", "APPROVED"].includes(req.status)) throw new Error(`This request is ${req.status} and cannot be completed.`);
  const actual = input.actualAmount === undefined ? req.amount : Math.round(Number(input.actualAmount) * 100) / 100;
  if (!Number.isFinite(actual) || actual < 0) throw new Error("actual_amount must be a non-negative number.");
  const auth = activeAuthorization(id, agentId);
  const max = auth?.maxAmount ?? req.amount;
  const base: Partial<PaymentRequest> = { actualAmount: actual, externalReference: input.externalReference?.slice(0, 200), completionNote: input.note?.slice(0, 1_000) };
  if (input.status === "SUCCEEDED" && actual > max + 0.005) {
    const exception = `Reported amount ${money(actual)} exceeds the authorized maximum ${money(max)}. Owner review required before this is recorded as paid.`;
    patchRequest(id, { ...base, status: "PROCESSING", exception });
    console.warn(`[payments] amount exception #${short(id)}: ${exception}`);
    emitPaymentEvent("exception", `${req.merchant}: ${exception}`, { id });
    throw new Error(`${exception} The owner has been notified; do not attempt another payment.`);
  }
  settleAuthorizations(id, input.status === "SUCCEEDED" ? "USED" : "REVOKED");
  const updated = patchRequest(id, { ...base, status: input.status, exception: undefined, completedAt: now() });
  recordTransaction(updated, input.status);
  console.log(`[payments] ${input.status.toLowerCase()} #${short(id)} ${money(actual)} ${req.merchant}${input.externalReference ? ` ref=${input.externalReference}` : ""}`);
  emitPaymentEvent(input.status === "SUCCEEDED" ? "succeeded" : "failed", `${req.merchant} ${money(actual)} ${input.status === "SUCCEEDED" ? "paid" : "failed"} (${req.requestedByName})`, { id });
  return updated;
}

/* ---------------------------------------------------------------- history */

function recordTransaction(req: PaymentRequest, status: PaymentTransaction["status"]): PaymentTransaction {
  const live = getMethod(req.selectedPaymentMethodId);
  // the safe snapshot survives deletion of the method
  const method = live ? { type: live.type, displayName: live.displayName, last4: live.last4, brand: live.type === "CARD" ? live.brand : live.accountType } : req.methodSnapshot;
  const t: PaymentTransaction = {
    id: newId(),
    paymentRequestId: req.id,
    agentId: req.requestedByAgentId,
    agentName: req.requestedByName,
    merchant: req.merchant,
    amount: req.actualAmount ?? req.amount,
    currency: "USD",
    status,
    billingType: req.billingType,
    interval: req.interval,
    reason: req.reason,
    paymentMethodType: method?.type,
    paymentMethodDisplayName: method?.displayName,
    paymentMethodLast4: method?.last4,
    paymentMethodBrand: method?.brand,
    approvalType: req.approvalType,
    approvalThreshold: req.approvalThresholdAtCreation,
    approvedBy: req.approvedBy,
    approvedAt: req.approvedAt,
    requestedAt: req.createdAt,
    externalReference: req.externalReference,
    note: req.completionNote ?? req.ownerNote,
    createdAt: now(),
    completedAt: req.completedAt ?? req.rejectedAt ?? now(),
  };
  insertTransaction(t);
  return t;
}

export function overview(): PaymentOverview {
  const settings = getSettings();
  const month = new Date().toISOString().slice(0, 7);
  const tx = listTransactions(2000).filter((t) => t.status === "SUCCEEDED" && t.completedAt.startsWith(month));
  const reqs = listRequests();
  return {
    currency: "USD",
    monthTotal: round(tx.reduce((s, t) => s + t.amount, 0)),
    monthAuto: round(tx.filter((t) => t.approvalType === "AUTOMATIC").reduce((s, t) => s + t.amount, 0)),
    monthOwner: round(tx.filter((t) => t.approvalType === "OWNER").reduce((s, t) => s + t.amount, 0)),
    pendingApprovals: reqs.filter((r) => r.status === "WAITING_FOR_APPROVAL").length,
    processing: reqs.filter((r) => r.status === "PROCESSING" || !!r.exception).length,
    methods: readDb().paymentMethods.length,
    autoApproveLimit: settings.autoApproveLimit,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

/* ---------------------------------------------------------------- resume the requester */

/** The request is off. Nothing is authorized, and the agent must be told. */
async function wakeCancelled(req: PaymentRequest, by: string, note?: string): Promise<void> {
  const text = renderPrompt("payment-cancelled-resume", { short_id: short(req.id), merchant: req.merchant, amount: money(req.amount), by, note: note ? ` — note: ${note}` : "" });
  const { onPaymentDecision } = await import("@/lib/capabilities/manager");
  if (req.capabilityRequestId && (await onPaymentDecision(req.capabilityRequestId, "rejected", text))) return;
  const { sendAgentMessage } = await import("@/lib/runtime");
  await sendAgentMessage(req.requestedByAgentId, text, { origin: "system", scopeId: req.executionScopeId });
}

/**
 * The owner decided. Capability Manager requests continue through the
 * capability-request loop (same wake-up path as before); any other agent
 * is resumed with a system message in the scope that made the request.
 */
async function wakeRequester(req: PaymentRequest, decision: "approved" | "rejected", note?: string): Promise<void> {
  const method = getMethod(req.selectedPaymentMethodId);
  const via = method ? `the owner chose ${method.displayName} •••• ${method.last4} (${method.type === "CARD" ? method.brand : method.accountType}, id ${method.id}) — use exactly that one` : "call list_payment_methods and choose the method whose usage description best fits this checkout";
  const text = decision === "approved"
    ? renderPrompt("payment-approved-resume", {
        short_id: short(req.id), merchant: req.merchant, amount: money(req.amount),
        billing: req.billingType === "RECURRING" ? ` / ${req.interval === "YEARLY" ? "year" : "month"}` : "",
        note: note ? ` — note: ${note}` : "", via, request_id: req.id,
      })
    : renderPrompt("payment-rejected-resume", { short_id: short(req.id), merchant: req.merchant, amount: money(req.amount), note: note ? ` — note: ${note}` : "" });
  const { onPaymentDecision } = await import("@/lib/capabilities/manager");
  if (req.capabilityRequestId && (await onPaymentDecision(req.capabilityRequestId, decision, text))) return;
  const { sendAgentMessage } = await import("@/lib/runtime");
  clearAgentWaiting(req.requestedByAgentId, req.id);
  void sendAgentMessage(req.requestedByAgentId, text, { origin: "system", scopeId: req.executionScopeId }).catch((err) => console.error("[payments] resume failed:", err));
}
