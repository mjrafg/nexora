/* ------------------------------------------------------------------
   Payments — persistence (methods, settings, requests, authorizations,
   transactions) and the live "payments" activity channel.
   ------------------------------------------------------------------ */

import { emitActivity } from "@/lib/activity";
import { DEFAULT_PAYMENT_SETTINGS, newId, now, readDb, updateDb } from "@/lib/store/db";
import { createCredential, credentialValues, updateCredential } from "@/lib/mcp/store";
import type { BankAccountType, CardBrand, PaymentAuthorization, PaymentMethod, PaymentMethodView, PaymentRequest, PaymentSettings, PaymentTransaction } from "./types";

export const PAYMENTS_CHANNEL = "payments";

export function emitPaymentEvent(kind: string, text: string, detail?: Record<string, unknown>): void {
  emitActivity({ agentId: PAYMENTS_CHANNEL, turnId: "payments", kind: "status", title: `payment:${kind}`, detail: text, meta: detail ? JSON.stringify(detail).slice(0, 500) : undefined });
}

/* ---------------------------------------------------------------- settings */

export function getSettings(): PaymentSettings {
  return readDb().paymentSettings ?? { ...DEFAULT_PAYMENT_SETTINGS };
}

export function updateSettings(patch: Partial<Pick<PaymentSettings, "autoApproveLimit" | "defaultPaymentMethodId">>): PaymentSettings {
  return updateDb((d) => {
    d.paymentSettings ??= { ...DEFAULT_PAYMENT_SETTINGS };
    if (patch.autoApproveLimit !== undefined) {
      const v = Number(patch.autoApproveLimit);
      if (!Number.isFinite(v) || v < 0) throw new Error("Automatic spending limit must be a non-negative amount.");
      d.paymentSettings.autoApproveLimit = Math.round(v * 100) / 100;
    }
    if (patch.defaultPaymentMethodId !== undefined) {
      if (patch.defaultPaymentMethodId && !d.paymentMethods.some((m) => m.id === patch.defaultPaymentMethodId)) throw new Error("Payment method not found.");
      d.paymentSettings.defaultPaymentMethodId = patch.defaultPaymentMethodId;
    }
    d.paymentSettings.updatedAt = now();
    return d.paymentSettings;
  });
}

/* ---------------------------------------------------------------- methods */

export function cardBrand(number: string): CardBrand {
  const n = number.replace(/\D/g, "");
  if (/^4/.test(n)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(n)) return "Mastercard";
  if (/^3[47]/.test(n)) return "American Express";
  if (/^6(011|5)/.test(n)) return "Discover";
  return "Card";
}

export function listMethods(): PaymentMethod[] {
  return readDb().paymentMethods.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getMethod(id: string | null | undefined): PaymentMethod | null {
  if (!id) return null;
  return readDb().paymentMethods.find((m) => m.id === id) ?? null;
}

/** id, unique id prefix, or exact name (case-insensitive) */
export function findMethod(ref: string): PaymentMethod | null {
  const all = readDb().paymentMethods;
  const r = ref.trim();
  if (!r) return null;
  const byId = all.find((m) => m.id === r);
  if (byId) return byId;
  const byName = all.filter((m) => m.displayName.toLowerCase() === r.toLowerCase());
  if (byName.length === 1) return byName[0];
  const byPrefix = all.filter((m) => m.id.startsWith(r));
  return byPrefix.length === 1 ? byPrefix[0] : null;
}

export const MIN_DESCRIPTION = 20;

export function assertDescription(description: string): string {
  const d = description.trim();
  if (d.length < MIN_DESCRIPTION) throw new Error(`Usage description is required (at least ${MIN_DESCRIPTION} characters): say what this method is, when to use it and when not to.`);
  return d.slice(0, 1_000);
}

/** Safe view for agents and the UI — never a secret. */
export function methodView(m: PaymentMethod, defaultId: string | null = getSettings().defaultPaymentMethodId): PaymentMethodView {
  return {
    id: m.id,
    name: m.displayName,
    type: m.type,
    ...(m.type === "CARD" ? { brand: m.brand, expiration: `${String(m.expirationMonth).padStart(2, "0")}/${String(m.expirationYear).slice(-2)}`, cardholder_name: m.cardholderName, has_cvv: m.secretKeys.includes("CVV") } : { bank_name: m.bankName, account_type: m.accountType }),
    last4: m.last4,
    billing_country: m.billing?.country ?? m.country,
    description: m.description,
    is_default: defaultId === m.id,
    status: m.status,
  };
}

export type CardInput = {
  displayName: string; description: string; cardholderName: string; cardNumber: string; expirationMonth: number; expirationYear: number; cvv?: string;
  billing: { line1?: string; city?: string; region?: string; postalCode?: string; country?: string };
  createdBy?: string;
};
export type BankInput = {
  displayName: string; description: string; accountHolderName: string; bankName?: string; routingNumber: string; accountNumber: string; accountType: BankAccountType;
  billing?: { line1?: string; city?: string; region?: string; postalCode?: string; country?: string };
  createdBy?: string;
};

function validCardNumber(raw: string): string {
  const number = raw.replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(number)) throw new Error("Card number must be 12–19 digits.");
  if (!luhn(number)) throw new Error("Card number failed validation (check the digits).");
  return number;
}

function validExpiration(month: number, yearIn: number): { month: number; year: number } {
  if (!(month >= 1 && month <= 12)) throw new Error("Expiration month must be 1–12.");
  const year = yearIn < 100 ? 2000 + yearIn : yearIn;
  const nowD = new Date();
  if (!Number.isFinite(year) || year < nowD.getFullYear() || (year === nowD.getFullYear() && month < nowD.getMonth() + 1)) throw new Error("This card has expired (or the expiration date is invalid).");
  return { month, year };
}

function validRouting(raw: string): string {
  const routing = raw.replace(/\D/g, "");
  if (!/^\d{9}$/.test(routing)) throw new Error("US routing number must be 9 digits.");
  if (!abaValid(routing)) throw new Error("Routing number failed validation (check the digits).");
  return routing;
}

function validAccount(raw: string): string {
  const account = raw.replace(/\D/g, "");
  if (!/^\d{4,17}$/.test(account)) throw new Error("Account number must be 4–17 digits.");
  return account;
}

function uniqueName(name: string, exceptId?: string): string {
  const n = name.trim().slice(0, 80);
  if (!n) throw new Error("Name is required.");
  if (readDb().paymentMethods.some((m) => m.id !== exceptId && m.displayName.toLowerCase() === n.toLowerCase())) throw new Error(`A payment method named "${n}" already exists.`);
  return n;
}

export function createCard(input: CardInput): PaymentMethod {
  const number = validCardNumber(input.cardNumber);
  const { month, year } = validExpiration(input.expirationMonth, input.expirationYear);
  const displayName = uniqueName(input.displayName);
  const description = assertDescription(input.description);
  if (!input.cardholderName.trim()) throw new Error("Cardholder name is required.");
  const id = newId();
  const secrets: Record<string, string> = { CARD_NUMBER: number, EXP_MONTH: String(month).padStart(2, "0"), EXP_YEAR: String(year), CARDHOLDER_NAME: input.cardholderName.trim() };
  // CVV isolation: same vault, same encryption, its own key — easy to drop later
  if (input.cvv && /^\d{3,4}$/.test(input.cvv)) secrets.CVV = input.cvv;
  const cred = createCredential(`payment:${id}`, secrets, { hidden: true });
  const ts = now();
  const rec: PaymentMethod = {
    id, type: "CARD", displayName, description, status: "AVAILABLE", brand: cardBrand(number), cardholderName: input.cardholderName.trim(),
    expirationMonth: month, expirationYear: year, country: input.billing.country?.trim() || "US", last4: number.slice(-4),
    billing: cleanBilling(input.billing), credentialId: cred.id, secretKeys: Object.keys(secrets), createdBy: input.createdBy ?? "owner", useCount: 0, createdAt: ts, updatedAt: ts,
  };
  updateDb((d) => {
    d.paymentMethods.push(rec);
    if (!d.paymentSettings.defaultPaymentMethodId) d.paymentSettings.defaultPaymentMethodId = rec.id;
  });
  emitPaymentEvent("method_added", `${rec.displayName} added (${rec.brand} •••• ${rec.last4})${rec.createdBy !== "owner" ? " by an agent" : ""}`, { id: rec.id });
  return rec;
}

export function createBankAccount(input: BankInput): PaymentMethod {
  const routing = validRouting(input.routingNumber);
  const account = validAccount(input.accountNumber);
  const displayName = uniqueName(input.displayName);
  const description = assertDescription(input.description);
  if (!input.accountHolderName.trim()) throw new Error("Account holder name is required.");
  const id = newId();
  const secrets: Record<string, string> = { ROUTING_NUMBER: routing, ACCOUNT_NUMBER: account, ACCOUNT_HOLDER_NAME: input.accountHolderName.trim(), ACCOUNT_TYPE: input.accountType };
  const cred = createCredential(`payment:${id}`, secrets, { hidden: true });
  const ts = now();
  const rec: PaymentMethod = {
    id, type: "BANK_ACCOUNT", displayName, description, status: "AVAILABLE", accountHolderName: input.accountHolderName.trim(), bankName: input.bankName?.trim() || undefined,
    accountType: input.accountType, country: "US", last4: account.slice(-4), billing: input.billing ? cleanBilling(input.billing) : undefined,
    credentialId: cred.id, secretKeys: Object.keys(secrets), createdBy: input.createdBy ?? "owner", useCount: 0, createdAt: ts, updatedAt: ts,
  };
  updateDb((d) => {
    d.paymentMethods.push(rec);
    if (!d.paymentSettings.defaultPaymentMethodId) d.paymentSettings.defaultPaymentMethodId = rec.id;
  });
  emitPaymentEvent("method_added", `${rec.displayName} added (${rec.accountType} •••• ${rec.last4})${rec.createdBy !== "owner" ? " by an agent" : ""}`, { id: rec.id });
  return rec;
}

export type MethodPatch = Partial<Pick<PaymentMethod, "displayName" | "description" | "status" | "cardholderName" | "accountHolderName" | "bankName" | "billing" | "expirationMonth" | "expirationYear" | "accountType">> & {
  /** secret rotation — written to the vault, never stored on the row */
  cardNumber?: string; cvv?: string; routingNumber?: string; accountNumber?: string;
};

/** Edit metadata and/or rotate secrets in the vault. Old secrets are never returned. */
export function updateMethod(id: string, patch: MethodPatch): PaymentMethod {
  const m = getMethod(id);
  if (!m) throw new Error("Payment method not found.");
  const values: Record<string, string> = {};
  const row: Partial<PaymentMethod> = {};
  if (patch.displayName !== undefined) row.displayName = uniqueName(patch.displayName, id);
  if (patch.description !== undefined) row.description = assertDescription(patch.description);
  if (patch.status === "AVAILABLE" || patch.status === "DISABLED") row.status = patch.status;
  if (patch.billing) row.billing = cleanBilling(patch.billing);
  if (patch.bankName !== undefined && m.type === "BANK_ACCOUNT") row.bankName = patch.bankName?.trim() || undefined;
  if (m.type === "CARD") {
    if (patch.cardholderName?.trim()) { row.cardholderName = patch.cardholderName.trim(); values.CARDHOLDER_NAME = row.cardholderName; }
    if (patch.cardNumber) { const n = validCardNumber(patch.cardNumber); values.CARD_NUMBER = n; row.last4 = n.slice(-4); row.brand = cardBrand(n); }
    if (patch.cvv !== undefined) { if (patch.cvv && !/^\d{3,4}$/.test(patch.cvv)) throw new Error("CVV must be 3–4 digits."); values.CVV = patch.cvv; }
    if (patch.expirationMonth || patch.expirationYear) {
      const { month, year } = validExpiration(Number(patch.expirationMonth ?? m.expirationMonth), Number(patch.expirationYear ?? m.expirationYear));
      row.expirationMonth = month; row.expirationYear = year; values.EXP_MONTH = String(month).padStart(2, "0"); values.EXP_YEAR = String(year);
    }
  } else {
    if (patch.accountHolderName?.trim()) { row.accountHolderName = patch.accountHolderName.trim(); values.ACCOUNT_HOLDER_NAME = row.accountHolderName; }
    if (patch.routingNumber) values.ROUTING_NUMBER = validRouting(patch.routingNumber);
    if (patch.accountNumber) { const a = validAccount(patch.accountNumber); values.ACCOUNT_NUMBER = a; row.last4 = a.slice(-4); }
    if (patch.accountType === "CHECKING" || patch.accountType === "SAVINGS") { row.accountType = patch.accountType; values.ACCOUNT_TYPE = patch.accountType; }
  }
  if (Object.keys(values).length) updateCredential(m.credentialId, { values });
  const updated = updateDb((d) => {
    const x = d.paymentMethods.find((y) => y.id === id)!;
    Object.assign(x, row, { updatedAt: now() });
    if (Object.keys(values).length) x.secretKeys = Object.keys(credentialValues(x.credentialId));
    if (x.status === "DISABLED") for (const a of d.paymentAuthorizations) if (a.paymentMethodId === id && a.status === "ACTIVE") a.status = "REVOKED";
    return x;
  });
  const rotated = Object.keys(values).filter((k) => !["CARDHOLDER_NAME", "ACCOUNT_HOLDER_NAME"].includes(k));
  emitPaymentEvent("method_updated", `${updated.displayName} updated${rotated.length ? ` (${rotated.length === 1 ? "1 secret" : `${rotated.length} secrets`} rotated)` : ""}`, { id });
  return updated;
}

export function recordMethodUse(id: string, agentId: string): void {
  updateDb((d) => { const m = d.paymentMethods.find((x) => x.id === id); if (m) { m.useCount = (m.useCount ?? 0) + 1; m.lastUsedAt = now(); m.lastUsedBy = agentId; } });
}

export function deleteMethod(id: string): void {
  updateDb((d) => {
    const m = d.paymentMethods.find((x) => x.id === id);
    if (!m) throw new Error("Payment method not found.");
    d.paymentMethods = d.paymentMethods.filter((x) => x.id !== id);
    d.credentials = d.credentials.filter((c) => c.id !== m.credentialId);
    if (d.paymentSettings.defaultPaymentMethodId === id) d.paymentSettings.defaultPaymentMethodId = d.paymentMethods[0]?.id ?? null;
    for (const a of d.paymentAuthorizations) if (a.paymentMethodId === id && a.status === "ACTIVE") a.status = "REVOKED";
  });
  emitPaymentEvent("method_removed", "Payment method removed");
}

/** server-internal only: decrypted secrets for an authorized execution */
export function methodSecrets(m: PaymentMethod): Record<string, string> {
  return credentialValues(m.credentialId);
}

export function methodLabel(m: Pick<PaymentMethod, "displayName" | "last4" | "brand" | "accountType" | "type">): string {
  return `${m.displayName} (${m.type === "CARD" ? m.brand ?? "Card" : m.accountType === "SAVINGS" ? "Savings" : "Checking"} •••• ${m.last4})`;
}

/* ---------------------------------------------------------------- requests */

export function listRequests(): PaymentRequest[] {
  return readDb().paymentRequests.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getRequest(id: string): PaymentRequest | null {
  return readDb().paymentRequests.find((r) => r.id === id) ?? null;
}

export function findRequest(ref: string): PaymentRequest | null {
  const all = readDb().paymentRequests;
  return all.find((r) => r.id === ref) ?? (all.filter((r) => r.id.startsWith(ref)).length === 1 ? all.find((r) => r.id.startsWith(ref))! : null);
}

export function insertRequest(rec: PaymentRequest): PaymentRequest {
  updateDb((d) => { d.paymentRequests.push(rec); });
  return rec;
}

export function patchRequest(id: string, patch: Partial<PaymentRequest>): PaymentRequest {
  return updateDb((d) => {
    const r = d.paymentRequests.find((x) => x.id === id);
    if (!r) throw new Error("Payment request not found.");
    Object.assign(r, patch, { updatedAt: now() });
    return r;
  });
}

/* ---------------------------------------------------------------- authorizations */

export function insertAuthorization(a: PaymentAuthorization): PaymentAuthorization {
  updateDb((d) => { d.paymentAuthorizations.push(a); });
  return a;
}

export function activeAuthorization(requestId: string, agentId?: string): PaymentAuthorization | null {
  const nowTs = Date.now();
  const rows = readDb().paymentAuthorizations.filter((a) => a.paymentRequestId === requestId && a.status === "ACTIVE" && (!agentId || a.agentId === agentId));
  const live = rows.find((a) => Date.parse(a.expiresAt) > nowTs);
  if (!live && rows.length) updateDb((d) => { for (const a of d.paymentAuthorizations) if (a.status === "ACTIVE" && Date.parse(a.expiresAt) <= nowTs) a.status = "EXPIRED"; });
  return live ?? null;
}

export function settleAuthorizations(requestId: string, status: "USED" | "REVOKED"): void {
  updateDb((d) => { for (const a of d.paymentAuthorizations) if (a.paymentRequestId === requestId && a.status === "ACTIVE") a.status = status; });
}

/** Does this agent hold an active authorization that covers the given vault credential? (gates browser_type credential lookups) */
export function authorizationAllowsCredential(agentId: string, credentialId: string): boolean {
  const m = readDb().paymentMethods.find((x) => x.credentialId === credentialId);
  if (!m || m.status !== "AVAILABLE") return false;
  const nowTs = Date.now();
  return readDb().paymentAuthorizations.some((a) => a.agentId === agentId && (a.paymentMethodId === null || a.paymentMethodId === m.id) && a.status === "ACTIVE" && Date.parse(a.expiresAt) > nowTs);
}

/** every payment secret string currently authorized for any agent — for redaction of browser/tool previews */
export function activePaymentSecretStrings(): string[] {
  const db = readDb();
  const nowTs = Date.now();
  const out = new Set<string>();
  const live = db.paymentAuthorizations.filter((a) => a.status === "ACTIVE" && Date.parse(a.expiresAt) > nowTs);
  if (!live.length) return [];
  const any = live.some((a) => a.paymentMethodId === null);
  for (const m of db.paymentMethods) {
    if (!any && !live.some((a) => a.paymentMethodId === m.id)) continue;
    for (const v of Object.values(credentialValues(m.credentialId))) if (v && v.length >= 3 && /\d/.test(v)) out.add(v);
  }
  return [...out];
}

/** Replace every active payment secret (and common URL-encoded forms) in free text with •••. */
export function redactPaymentSecrets(text: string): string {
  let out = text;
  for (const v of activePaymentSecretStrings()) {
    if (v.length < 3) continue;
    for (const form of [v, encodeURIComponent(v), v.replace(/(\d{4})(?=\d)/g, "$1 "), v.replace(/(\d{4})(?=\d)/g, "$1-")]) {
      if (form && out.includes(form)) out = out.split(form).join("•••");
    }
  }
  return out;
}

/* ---------------------------------------------------------------- transactions */

export function listTransactions(limit = 500): PaymentTransaction[] {
  return readDb().paymentTransactions.slice().sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, limit);
}

export function insertTransaction(t: PaymentTransaction): PaymentTransaction {
  updateDb((d) => { d.paymentTransactions.push(t); });
  return t;
}

/* ---------------------------------------------------------------- helpers */

function cleanBilling(b: PaymentMethod["billing"]): PaymentMethod["billing"] {
  if (!b) return undefined;
  const s = (v?: string) => (v && v.trim() ? v.trim().slice(0, 120) : undefined);
  const out = { line1: s(b.line1), city: s(b.city), region: s(b.region), postalCode: s(b.postalCode), country: s(b.country) };
  return Object.values(out).some(Boolean) ? out : undefined;
}

function luhn(n: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = n.length - 1; i >= 0; i--) {
    let d = Number(n[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function abaValid(r: string): boolean {
  const d = r.split("").map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}
