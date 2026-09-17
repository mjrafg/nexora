/* ------------------------------------------------------------------
   Payments tool server ("payments") — the only payment surface agents get.

     request (permission payments):         request_payment, get_payment_request,
                                            list_my_payment_requests, begin_payment, complete_payment
     use     (permission payments_use):     list_payment_methods, get_payment_method,
                                            insert_payment_method_fields, insert_payment_method_field
     manage  (permission payments_manage):  save_payment_method, update_payment_method

   No tool result ever contains a card number, CVV, routing or account
   number. The agent decides WHICH method (from names + usage descriptions)
   and WHERE (browser element refs); Nexora types the vault values into the
   agent's own browser session, gated by an approved payment request.
   Field insertion is deliberately NOT a guarded side effect: re-filling an
   empty checkout form after a failed attempt is legitimate; the FINANCIAL
   action is the checkout submission, protected by the request state.
   ------------------------------------------------------------------ */

import type { AgentRecord } from "@/lib/runtime/types";
import { registerToolServer, type InternalToolDef, type InternalToolResult, type InternalToolServer } from "@/lib/tools/internal";
import { BANK_FIELDS, CARD_FIELDS, availableMethods, beginPayment, completePayment, createPaymentRequest, insertPaymentMethodFields, money } from "./service";
import { createBankAccount, createCard, findMethod, findRequest, getMethod, getSettings, listMethods, methodView, updateMethod, MIN_DESCRIPTION } from "./store";
import type { PaymentRequest } from "./types";

const ok = (text: string): InternalToolResult => ({ ok: true, text });
const fail = (text: string): InternalToolResult => ({ ok: false, text });
const s = (v: unknown, max = 1_000) => (typeof v === "string" ? v.slice(0, max).trim() : "");

function view(r: PaymentRequest) {
  const m = getMethod(r.selectedPaymentMethodId);
  return {
    payment_request_id: r.id,
    merchant: r.merchant,
    amount: r.amount,
    currency: r.currency,
    billing: r.billingType === "RECURRING" ? `${r.interval}` : "ONE_TIME",
    status: r.status,
    approval: r.approvalType,
    payment_method: m ? `${m.displayName} (${m.type === "CARD" ? m.brand : m.accountType} •••• ${m.last4}, id ${m.id})` : r.methodSnapshot ? `${r.methodSnapshot.displayName} •••• ${r.methodSnapshot.last4}` : null,
    threshold_at_request: r.approvalThresholdAtCreation,
    exception: r.exception,
    created_at: r.createdAt,
  };
}

const CHOOSE = "call list_payment_methods, choose the method whose usage description best fits this checkout, then insert_payment_method_fields with the browser refs of the payment inputs";

function nextStep(r: PaymentRequest): string {
  switch (r.status) {
    case "AUTO_APPROVED": return availableMethods().length ? `Auto-approved (within the owner's automatic limit). At the checkout: ${CHOOSE}.` : "Auto-approved, but the company has no available payment method yet; tell the owner.";
    case "WAITING_FOR_APPROVAL": return "Above the automatic limit: the owner must approve. End your turn now — you will be resumed automatically with the decision.";
    case "APPROVED": return r.selectedPaymentMethodId ? "Approved by the owner with a specific payment method (see payment_method): use exactly that one with insert_payment_method_fields (authorization lasts 30 minutes)." : `Approved by the owner. At the checkout: ${CHOOSE} (authorization lasts 30 minutes).`;
    case "PROCESSING": return r.exception ? "An amount exception is open; the owner must review it. Do not pay again." : "Checkout in progress. Finish the form (re-insert fields if the site cleared them), submit once, verify the result, then call complete_payment.";
    case "REJECTED": return "Rejected by the owner. No payment details will be inserted.";
    case "SUCCEEDED": return "Already paid. Do not pay again.";
    default: return `Request is ${r.status}.`;
  }
}

const REQUEST_TOOLS: InternalToolDef[] = [
  {
    name: "request_payment",
    sideEffect: "SIDE_EFFECT",
    description: "Ask Nexora to pay for something (subscription, credits, domain, setup fee…). The company's automatic spending limit decides deterministically: at or below it the request is AUTO_APPROVED and you may continue; above it the owner must approve and you must END YOUR TURN (you are resumed automatically with the decision). Request BEFORE any fee is incurred. Never ask the owner for card details directly.",
    inputSchema: { type: "object", properties: { merchant: { type: "string", description: "who is being paid, e.g. Canva" }, amount: { type: "number", description: "amount in USD (for recurring: per interval)" }, currency: { type: "string", description: "USD" }, reason: { type: "string" }, billing_type: { type: "string", enum: ["ONE_TIME", "MONTHLY", "YEARLY"] }, preferred_method: { type: "string", enum: ["CARD", "BANK_ACCOUNT", "ANY"] }, recommendation: { type: "string", description: "why this option, alternatives considered" } }, required: ["merchant", "amount", "reason"] },
  },
  { name: "get_payment_request", description: "Status of one of your payment requests and what to do next.", inputSchema: { type: "object", properties: { payment_request_id: { type: "string" } }, required: ["payment_request_id"] } },
  { name: "list_my_payment_requests", description: "Your payment requests (newest first).", inputSchema: { type: "object", properties: {} } },
  {
    name: "begin_payment",
    sideEffect: "FINANCIAL",
    description: "Optional: mark the checkout of an approved payment request as started and get its non-secret details (maximum amount, authorization expiry, the owner-chosen method if any, billing address). Card and bank numbers are NEVER returned — Nexora types them for you via insert_payment_method_fields.",
    inputSchema: { type: "object", properties: { payment_request_id: { type: "string" } }, required: ["payment_request_id"] },
  },
  {
    name: "complete_payment",
    sideEffect: "SIDE_EFFECT",
    description: "Record the outcome after you verified it (confirmation page, receipt, account status). status SUCCEEDED or FAILED; actual_amount must not exceed the approved amount; include the external reference (order/receipt/transaction id) when available. If you are not sure whether the charge went through, verify first — never pay again on a guess.",
    inputSchema: { type: "object", properties: { payment_request_id: { type: "string" }, status: { type: "string", enum: ["SUCCEEDED", "FAILED"] }, actual_amount: { type: "number" }, external_reference: { type: "string" }, note: { type: "string" } }, required: ["payment_request_id", "status"] },
  },
];

const FIELDS_DOC = `Logical fields → element ref (from browser_snapshot, e.g. e42) or CSS selector. CARD: ${CARD_FIELDS.join(", ")} (expiration = "MM/YY"; expiration_year = 4 digits, expiration_year_short = 2). BANK_ACCOUNT: ${BANK_FIELDS.join(", ")} (account_type selects the option when the target is a <select>).`;

const USE_TOOLS: InternalToolDef[] = [
  { name: "list_payment_methods", description: "The company's payment methods as safe metadata: id, name, type (CARD / BANK_ACCOUNT), brand, last4, expiration, usage description, default flag, status. Read the usage descriptions and choose the method that fits the checkout (one-time vs recurring, merchant, card vs ACH). Never returns card numbers, CVVs, routing or account numbers.", inputSchema: { type: "object", properties: {} } },
  { name: "get_payment_method", description: "Safe metadata of one payment method (never a secret).", inputSchema: { type: "object", properties: { payment_method_id: { type: "string" } }, required: ["payment_method_id"] } },
  {
    name: "insert_payment_method_fields",
    description: `Nexora types the chosen payment method's values straight into the checkout inputs of your own browser session. Requires your AUTO_APPROVED / APPROVED payment request (otherwise DENIED). ${FIELDS_DOC} Returns success and the list of fields filled — never the values. After inserting, NEVER read, inspect, copy or reveal those fields; assume they were entered correctly, submit the checkout once, verify, then complete_payment. Re-run it if the site cleared the form.`,
    inputSchema: { type: "object", properties: { payment_method_id: { type: "string" }, payment_request_id: { type: "string" }, fields: { type: "object", description: "{ cardholder_name: \"e41\", card_number: \"e42\", expiration: \"e43\", cvv: \"e44\" }" }, browser_session_id: { type: "string", description: "optional; defaults to your own browser session" } }, required: ["payment_method_id", "payment_request_id", "fields"] },
  },
  {
    name: "insert_payment_method_field",
    description: `Single-field variant of insert_payment_method_fields for multi-step checkouts (e.g. card number on one screen, CVV on the next). ${FIELDS_DOC}`,
    inputSchema: { type: "object", properties: { payment_method_id: { type: "string" }, payment_request_id: { type: "string" }, field: { type: "string" }, target: { type: "string", description: "element ref (e42) or CSS selector" }, browser_session_id: { type: "string" } }, required: ["payment_method_id", "payment_request_id", "field", "target"] },
  },
];

const MANAGE_TOOLS: InternalToolDef[] = [
  {
    name: "save_payment_method",
    sideEffect: "SIDE_EFFECT",
    description: `Store a payment method you obtained legitimately (e.g. a virtual card issued during a signup) in the Nexora vault for future use. Saving costs nothing — but if creating it involved any fee, deposit or subscription, that spend needs request_payment BEFORE it is incurred. The description (≥ ${MIN_DESCRIPTION} chars) must tell future agents what the method is, when to use it and when NOT to (e.g. "Virtual card created for recurring marketing SaaS subscriptions. Do not use for one-time infrastructure purchases."). Returns id, name, type, brand and last4 only; secrets are never echoed.`,
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["CARD", "BANK_ACCOUNT"] }, name: { type: "string" }, description: { type: "string" },
        cardholder_name: { type: "string" }, card_number: { type: "string" }, expiration_month: { type: "string" }, expiration_year: { type: "string" }, cvv: { type: "string" },
        account_holder: { type: "string" }, bank_name: { type: "string" }, routing_number: { type: "string" }, account_number: { type: "string" }, account_type: { type: "string", enum: ["CHECKING", "SAVINGS"] },
        billing_address: { type: "object", description: "{ line1, city, region, postal_code, country }" },
      },
      required: ["type", "name", "description"],
    },
  },
  {
    name: "update_payment_method",
    sideEffect: "SIDE_EFFECT",
    description: "Update a saved payment method: name, usage description, status (AVAILABLE / DISABLED), holder name, bank name, billing address, expiration, or rotate its secret values (card_number, cvv, routing_number, account_number). Old secrets are never exposed. Deletion is owner-only.",
    inputSchema: {
      type: "object",
      properties: {
        payment_method_id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, status: { type: "string", enum: ["AVAILABLE", "DISABLED"] },
        cardholder_name: { type: "string" }, card_number: { type: "string" }, expiration_month: { type: "string" }, expiration_year: { type: "string" }, cvv: { type: "string" },
        account_holder: { type: "string" }, bank_name: { type: "string" }, routing_number: { type: "string" }, account_number: { type: "string" }, account_type: { type: "string", enum: ["CHECKING", "SAVINGS"] },
        billing_address: { type: "object" },
      },
      required: ["payment_method_id"],
    },
  },
];

export const PAYMENT_TOOL_NAMES = { request: REQUEST_TOOLS.map((t) => t.name), use: USE_TOOLS.map((t) => t.name), manage: MANAGE_TOOLS.map((t) => t.name) };

export function paymentToolsFor(agent: AgentRecord): InternalToolDef[] {
  const p = agent.toolPermissions;
  const out: InternalToolDef[] = [];
  if (p.includes("payments")) out.push(...REQUEST_TOOLS);
  if (p.includes("payments_use")) out.push(...USE_TOOLS);
  if (p.includes("payments_manage")) out.push(...MANAGE_TOOLS);
  return out;
}

function billingOf(v: unknown) {
  const b = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { line1: s(b.line1, 120), city: s(b.city, 120), region: s(b.region, 120), postalCode: s(b.postal_code ?? b.postalCode, 20), country: s(b.country, 2) };
}

function listing() {
  const defaultId = getSettings().defaultPaymentMethodId;
  return listMethods().map((m) => methodView(m, defaultId));
}

export const paymentsToolServer: InternalToolServer = registerToolServer({
  slug: "payments",
  name: "Payments",
  tools: [...REQUEST_TOOLS, ...USE_TOOLS, ...MANAGE_TOOLS],
  toolsFor: (agent) => paymentToolsFor(agent as AgentRecord),
  call: async (name, args, ctx) => {
    try {
      const { readDb } = await import("@/lib/store/db");
      const agent = readDb().agents.find((a) => a.id === ctx.agentId);
      if (!agent) return fail("Agent not found.");
      const p = agent.toolPermissions;
      if (REQUEST_TOOLS.some((t) => t.name === name) && !p.includes("payments")) return fail("This agent is not permitted to request payments (permission Payments: request).");
      if (USE_TOOLS.some((t) => t.name === name) && !p.includes("payments_use")) return fail("This agent is not permitted to use payment methods (permission Payments: use).");
      if (MANAGE_TOOLS.some((t) => t.name === name) && !p.includes("payments_manage")) return fail("This agent may use payment methods but not create or update them (permission Payments: create & update).");
      switch (name) {
        case "request_payment": {
          const merchant = s(args.merchant, 120);
          const amount = Number(args.amount);
          if (!merchant) return fail("merchant is required.");
          if (!Number.isFinite(amount)) return fail("amount must be a number.");
          const bt = s(args.billing_type, 20).toUpperCase();
          const { currentRequestId } = await import("@/lib/capabilities/manager");
          const capId = ctx.agentId === "capability-manager" ? currentRequestId() ?? undefined : undefined;
          const r = createPaymentRequest({
            agentId: ctx.agentId, merchant, amount, currency: s(args.currency, 3) || "USD", reason: s(args.reason, 1_000) || "(no reason given)",
            billingType: bt === "MONTHLY" || bt === "YEARLY" ? "RECURRING" : "ONE_TIME", interval: bt === "MONTHLY" ? "MONTHLY" : bt === "YEARLY" ? "YEARLY" : undefined,
            preferredMethod: (["CARD", "BANK_ACCOUNT"].includes(s(args.preferred_method, 20).toUpperCase()) ? s(args.preferred_method, 20).toUpperCase() : "ANY") as "CARD" | "BANK_ACCOUNT" | "ANY",
            recommendation: s(args.recommendation, 600) || undefined, executionScopeId: ctx.scopeId, capabilityRequestId: capId,
          });
          if (r.status === "WAITING_FOR_APPROVAL") {
            const { onPaymentRequested } = await import("@/lib/capabilities/manager");
            await onPaymentRequested(r);
          }
          return ok(JSON.stringify({ ...view(r), next: nextStep(r) }, null, 1));
        }
        case "get_payment_request": {
          const r = findRequest(s(args.payment_request_id, 80));
          if (!r || r.requestedByAgentId !== ctx.agentId) return fail("Payment request not found (or not yours).");
          return ok(JSON.stringify({ ...view(r), next: nextStep(r) }, null, 1));
        }
        case "list_my_payment_requests": {
          const { listRequests } = await import("./store");
          const rows = listRequests().filter((r) => r.requestedByAgentId === ctx.agentId).slice(0, 30);
          return ok(rows.length ? JSON.stringify(rows.map(view), null, 1) : "You have no payment requests.");
        }
        case "begin_payment": {
          const r = findRequest(s(args.payment_request_id, 80));
          if (!r) return fail("Payment request not found.");
          const { request, details } = beginPayment(r.id, ctx.agentId);
          const m = details.method;
          const lines = [
            `CHECKOUT — ${request.merchant} — maximum ${money(details.maxAmount)}${request.billingType === "RECURRING" ? ` per ${request.interval === "YEARLY" ? "year" : "month"}` : ""} — authorization expires ${details.expiresAt}`,
            m ? `Payment method: ${m.displayName} (${m.type === "CARD" ? m.brand : m.accountType} •••• ${m.last4}, id ${m.id})` : `Payment method: your choice — ${CHOOSE}.`,
            ...(m?.type === "CARD" ? [`Cardholder: ${m.cardholderName ?? ""} · expires ${String(m.expirationMonth).padStart(2, "0")}/${String(m.expirationYear).slice(-2)}`] : []),
            ...(details.billing ? [`Billing address: ${[details.billing.line1, details.billing.city, details.billing.region, details.billing.postalCode, details.billing.country].filter(Boolean).join(", ")}`] : []),
            "",
            "Card/bank numbers are never shown to you: call insert_payment_method_fields with the payment inputs' element refs and Nexora types them. Submit the checkout ONCE, verify the confirmation, then call complete_payment with the actual amount and the receipt/order reference. Never submit again on a guess.",
          ];
          return ok(lines.join("\n"));
        }
        case "complete_payment": {
          const r = findRequest(s(args.payment_request_id, 80));
          if (!r) return fail("Payment request not found.");
          const status = s(args.status, 20).toUpperCase();
          if (status !== "SUCCEEDED" && status !== "FAILED") return fail("status must be SUCCEEDED or FAILED.");
          const updated = completePayment(r.id, ctx.agentId, { status, actualAmount: args.actual_amount === undefined ? undefined : Number(args.actual_amount), externalReference: s(args.external_reference, 200) || undefined, note: s(args.note, 1_000) || undefined });
          return ok(`Recorded: ${updated.merchant} ${money(updated.actualAmount ?? updated.amount)} → ${updated.status}. It now appears in Payments → History.`);
        }
        case "list_payment_methods": {
          const rows = listing();
          return ok(rows.length ? JSON.stringify(rows, null, 1) : "The company has no payment methods yet. Tell the owner to add one in Payments → Payment Methods.");
        }
        case "get_payment_method": {
          const m = findMethod(s(args.payment_method_id, 200));
          if (!m) return fail("Payment method not found — call list_payment_methods.");
          return ok(JSON.stringify(methodView(m), null, 1));
        }
        case "insert_payment_method_fields":
        case "insert_payment_method_field": {
          const m = findMethod(s(args.payment_method_id, 200));
          if (!m) return fail("Payment method not found — call list_payment_methods.");
          const r = findRequest(s(args.payment_request_id, 80));
          if (!r) return fail("DENIED: payment request not found. Call request_payment first and wait for approval.");
          const fields = name === "insert_payment_method_field"
            ? { [s(args.field, 40)]: s(args.target, 300) }
            : ((args.fields && typeof args.fields === "object" ? args.fields : {}) as Record<string, string>);
          const out = await insertPaymentMethodFields({ requestId: r.id, method: m, fields, ctx, browserKey: s(args.browser_session_id, 200) || undefined });
          return ok(JSON.stringify({ success: true, payment_method: out.method.displayName, type: out.method.type, last4: out.method.last4, fields_filled: out.filled, next: "Submit the checkout once, verify the result, then call complete_payment. Do not read the inserted values back." }));
        }
        case "save_payment_method": {
          const type = s(args.type, 20).toUpperCase();
          const billing = billingOf(args.billing_address);
          const common = { displayName: s(args.name, 80), description: s(args.description, 1_000), createdBy: ctx.agentId };
          const m = type === "CARD"
            ? createCard({ ...common, cardholderName: s(args.cardholder_name, 120), cardNumber: s(args.card_number, 32), expirationMonth: Number(args.expiration_month), expirationYear: Number(args.expiration_year), cvv: s(args.cvv, 4) || undefined, billing })
            : type === "BANK_ACCOUNT"
              ? createBankAccount({ ...common, accountHolderName: s(args.account_holder, 120), bankName: s(args.bank_name, 120) || undefined, routingNumber: s(args.routing_number, 20), accountNumber: s(args.account_number, 32), accountType: s(args.account_type, 10).toUpperCase() === "SAVINGS" ? "SAVINGS" : "CHECKING", billing: Object.values(billing).some(Boolean) ? billing : undefined })
              : null;
          if (!m) return fail("type must be CARD or BANK_ACCOUNT.");
          return ok(JSON.stringify({ success: true, payment_method_id: m.id, name: m.displayName, type: m.type, ...(m.type === "CARD" ? { brand: m.brand } : { account_type: m.accountType }), last4: m.last4 }));
        }
        case "update_payment_method": {
          const m = findMethod(s(args.payment_method_id, 200));
          if (!m) return fail("Payment method not found.");
          const patch: Record<string, unknown> = {};
          if (s(args.name, 80)) patch.displayName = s(args.name, 80);
          if (s(args.description, 1_000)) patch.description = s(args.description, 1_000);
          if (args.status === "AVAILABLE" || args.status === "DISABLED") patch.status = args.status;
          if (s(args.cardholder_name, 120)) patch.cardholderName = s(args.cardholder_name, 120);
          if (s(args.account_holder, 120)) patch.accountHolderName = s(args.account_holder, 120);
          if (typeof args.bank_name === "string") patch.bankName = s(args.bank_name, 120);
          if (s(args.card_number, 32)) patch.cardNumber = s(args.card_number, 32);
          if (typeof args.cvv === "string") patch.cvv = s(args.cvv, 4);
          if (args.expiration_month) patch.expirationMonth = Number(args.expiration_month);
          if (args.expiration_year) patch.expirationYear = Number(args.expiration_year);
          if (s(args.routing_number, 20)) patch.routingNumber = s(args.routing_number, 20);
          if (s(args.account_number, 32)) patch.accountNumber = s(args.account_number, 32);
          if (args.account_type === "CHECKING" || args.account_type === "SAVINGS") patch.accountType = args.account_type;
          if (args.billing_address && typeof args.billing_address === "object") patch.billing = billingOf(args.billing_address);
          if (!Object.keys(patch).length) return fail("Nothing to update.");
          const u = updateMethod(m.id, patch);
          return ok(JSON.stringify({ success: true, payment_method_id: u.id, name: u.displayName, last4: u.last4, updated: Object.keys(patch) }));
        }
        default:
          return fail(`Unknown tool ${name}`);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});
