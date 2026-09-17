/* ------------------------------------------------------------------
   Company Custom Data — the flexible half of what Nexora knows about
   the company.

   The Company Profile is the canonical, structured record (legal name,
   addresses, EIN). Custom Data is everything else an agent needs to keep
   working without asking: operational defaults, vendor identifiers,
   signup preferences, gate codes. Keys are namespaced and uniquely
   addressable (`signup.default_country`), values are typed, and every
   entry says whether it is VERIFIED (the owner stands behind it) or
   PROVISIONAL (an agent chose it to keep going, and it may be wrong).

   It is NOT a vault: passwords, API keys, tokens and card numbers are
   rejected here and routed to the credential and payment systems.
   ------------------------------------------------------------------ */

import { emitActivity } from "@/lib/activity";
import { newId, now, readDb, updateDb } from "@/lib/store/db";
import { COMPANY_CHANNEL } from "./store";
import type { CustomDataStatus, CustomDatum, CustomValueType } from "./types";

export const VALUE_TYPES: CustomValueType[] = ["string", "number", "boolean", "date", "url", "email", "phone", "json"];

/** lowercase, dot-namespaced, no spaces: signup.default_country */
const KEY_RE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;

/** Keys that mean "this is a secret" — those belong in the vault, not here. */
const SECRET_KEY_RE = /(^|[._-])(password|passwd|pwd|secret|api[_-]?key|apikey|token|access[_-]?key|private[_-]?key|credential|cvv|cvc|pin|otp|card[_-]?number|account[_-]?number|routing[_-]?number|ssn)([._-]|$)/i;

/** Values that look like a live secret even when the key is innocent. */
const SECRET_VALUE_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/, what: "an API key" },
  { re: /\bsk-[A-Za-z0-9-_]{20,}\b/, what: "an API key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, what: "a GitHub token" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, what: "a Slack token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: "an AWS access key" },
  { re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, what: "a JSON web token" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "a private key" },
  { re: /^\s*\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{3,4}\s*$/, what: "a card number" },
];

export class SecretRejected extends Error {}

/**
 * Refuse anything that belongs in a secure store, and say where it goes.
 * Checked on every write, owner or agent.
 */
export function assertNotSecret(key: string, value: string): void {
  if (SECRET_KEY_RE.test(key)) {
    throw new SecretRejected(
      `"${key}" names a secret. Custom Data is not a vault and is readable by every agent with company access. Save a login with save_credential (Credentials), a card or bank account with save_payment_method (Payments), and an API key for a tool as an MCP credential.`,
    );
  }
  for (const { re, what } of SECRET_VALUE_PATTERNS) {
    if (re.test(value)) {
      throw new SecretRejected(
        `That value looks like ${what}. Custom Data is not a vault: store it with save_credential / save_payment_method / an MCP credential instead. Keep only non-secret operational data here.`,
      );
    }
  }
}

/* ---------------------------------------------------------------- validation */

function normalizeKey(raw: string): string {
  const key = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!key) throw new Error("key is required, e.g. signup.default_country");
  if (key.length > 120) throw new Error("key must be 120 characters or fewer.");
  if (!KEY_RE.test(key)) throw new Error(`"${raw}" is not a valid key. Use lowercase, dot-namespaced words: signup.default_country, operations.warehouse_code.`);
  return key;
}

/** Coerce and check the value against its declared type; returns the stored string form. */
function normalizeValue(value: unknown, type: CustomValueType): string {
  const raw = typeof value === "string" ? value.trim() : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "").trim();
  if (!raw) throw new Error("value is required.");
  if (raw.length > 4_000) throw new Error("value must be 4000 characters or fewer.");
  switch (type) {
    case "number":
      if (!Number.isFinite(Number(raw))) throw new Error(`"${raw}" is not a number.`);
      return String(Number(raw));
    case "boolean": {
      const v = raw.toLowerCase();
      if (!["true", "false", "yes", "no", "1", "0"].includes(v)) throw new Error(`"${raw}" is not a boolean (use true or false).`);
      return ["true", "yes", "1"].includes(v) ? "true" : "false";
    }
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) throw new Error("date values use the format YYYY-MM-DD.");
      return raw;
    case "url": {
      const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      try { return new URL(withScheme).toString().replace(/\/$/, ""); } catch { throw new Error(`"${raw}" is not a valid URL.`); }
    }
    case "email":
      if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(raw)) throw new Error(`"${raw}" is not a valid email address.`);
      return raw.toLowerCase();
    case "phone":
      if (!/^\+?[\d][\d\s().-]{5,}$/.test(raw) || raw.replace(/\D/g, "").length < 7) throw new Error(`"${raw}" is not a valid phone number.`);
      return raw.replace(/\s+/g, " ");
    case "json":
      try { JSON.parse(raw); } catch { throw new Error("json values must parse as JSON."); }
      return raw;
    default:
      return raw;
  }
}

/* ---------------------------------------------------------------- reads */

export function listCustomData(): CustomDatum[] {
  return readDb().companyCustomData.slice().sort((a, b) => a.key.localeCompare(b.key));
}

export const getCustomDatum = (key: string) => readDb().companyCustomData.find((d) => d.key === key.trim().toLowerCase()) ?? null;
export const getCustomDatumById = (id: string) => readDb().companyCustomData.find((d) => d.id === id) ?? null;

export function searchCustomData(opts: { keys?: string[]; namespace?: string; search?: string } = {}): CustomDatum[] {
  const all = listCustomData();
  if (opts.keys?.length) {
    const wanted = opts.keys.map((k) => k.trim().toLowerCase());
    return all.filter((d) => wanted.includes(d.key));
  }
  const ns = opts.namespace?.trim().toLowerCase().replace(/\.$/, "");
  const q = opts.search?.trim().toLowerCase();
  return all.filter((d) => (!ns || d.key === ns || d.key.startsWith(`${ns}.`)) && (!q || [d.key, d.value, d.label ?? "", d.description ?? ""].some((x) => x.toLowerCase().includes(q))));
}

/** Namespaces with a count, for the UI filter. */
export function customDataNamespaces(): { namespace: string; count: number }[] {
  const map = new Map<string, number>();
  for (const d of listCustomData()) {
    const ns = d.key.includes(".") ? d.key.slice(0, d.key.indexOf(".")) : "(no namespace)";
    map.set(ns, (map.get(ns) ?? 0) + 1);
  }
  return [...map.entries()].map(([namespace, count]) => ({ namespace, count })).sort((a, b) => a.namespace.localeCompare(b.namespace));
}

/* ---------------------------------------------------------------- writes */

export type CustomDataInput = {
  key: string;
  value: unknown;
  valueType?: CustomValueType;
  label?: string;
  description?: string;
  status?: CustomDataStatus;
  reason?: string;
};

/**
 * Create or update one entry.
 *
 * `by` is the actor: the owner may mark an entry verified, an agent may
 * not — an assumption never promotes itself to authoritative. An agent
 * overwriting a verified entry is refused; it can only add a new key or
 * refresh its own provisional value.
 */
export function upsertCustomDatum(input: CustomDataInput, by: { kind: "owner" } | { kind: "agent"; id: string; name: string }): CustomDatum {
  const key = normalizeKey(input.key);
  const type: CustomValueType = VALUE_TYPES.includes(input.valueType as CustomValueType) ? (input.valueType as CustomValueType) : "string";
  const value = normalizeValue(input.value, type);
  assertNotSecret(key, value);
  const actor = by.kind === "owner" ? "owner" : by.id;
  const existing = getCustomDatum(key);
  const status: CustomDataStatus = by.kind === "agent" ? "provisional" : input.status === "provisional" ? "provisional" : "verified";
  if (existing && by.kind === "agent" && existing.status === "verified") {
    throw new Error(`"${key}" is verified by the owner (${existing.value}). Use that value; only the owner can change it.`);
  }
  const ts = now();
  if (existing) {
    const updated = updateDb((d) => {
      const row = d.companyCustomData.find((x) => x.key === key)!;
      Object.assign(row, {
        value, valueType: type, status,
        label: input.label !== undefined ? input.label.trim().slice(0, 120) || undefined : row.label,
        description: input.description !== undefined ? input.description.trim().slice(0, 600) || undefined : row.description,
        reason: input.reason?.trim().slice(0, 400) || row.reason,
        source: by.kind === "owner" ? "owner" : "agent",
        updatedBy: actor, updatedAt: ts,
      });
      return row;
    });
    addCustomDataActivity(`Company data updated: ${key} (${status})`, by, input.reason);
    return updated;
  }
  const rec: CustomDatum = {
    id: newId(), key, value, valueType: type,
    label: input.label?.trim().slice(0, 120) || undefined,
    description: input.description?.trim().slice(0, 600) || undefined,
    status, source: by.kind === "owner" ? "owner" : "agent",
    reason: input.reason?.trim().slice(0, 400) || undefined,
    createdBy: actor, updatedBy: actor, createdAt: ts, updatedAt: ts,
  };
  updateDb((d) => { d.companyCustomData.push(rec); });
  addCustomDataActivity(`Company data added: ${key} (${status})`, by, input.reason);
  return rec;
}

/** Owner-only: promote a provisional value, or correct any field. */
export function patchCustomDatum(id: string, patch: Partial<CustomDataInput>): CustomDatum {
  const cur = getCustomDatumById(id);
  if (!cur) throw new Error("Custom data entry not found.");
  const key = patch.key !== undefined ? normalizeKey(patch.key) : cur.key;
  const type: CustomValueType = patch.valueType && VALUE_TYPES.includes(patch.valueType) ? patch.valueType : cur.valueType;
  const value = patch.value !== undefined ? normalizeValue(patch.value, type) : normalizeValue(cur.value, type);
  assertNotSecret(key, value);
  if (key !== cur.key && getCustomDatum(key)) throw new Error(`"${key}" already exists.`);
  const updated = updateDb((d) => {
    const row = d.companyCustomData.find((x) => x.id === id)!;
    Object.assign(row, {
      key, value, valueType: type,
      label: patch.label !== undefined ? patch.label.trim().slice(0, 120) || undefined : row.label,
      description: patch.description !== undefined ? patch.description.trim().slice(0, 600) || undefined : row.description,
      status: patch.status ?? row.status,
      source: "owner", updatedBy: "owner", updatedAt: now(),
    });
    return row;
  });
  addCustomDataActivity(`Company data ${patch.status === "verified" && cur.status !== "verified" ? "verified" : "edited"}: ${key}`, { kind: "owner" });
  return updated;
}

export function deleteCustomDatum(id: string): void {
  const cur = getCustomDatumById(id);
  if (!cur) throw new Error("Custom data entry not found.");
  updateDb((d) => { d.companyCustomData = d.companyCustomData.filter((x) => x.id !== id); });
  addCustomDataActivity(`Company data removed: ${cur.key}`, { kind: "owner" });
}

/** What an agent sees. Values are plain: nothing secret is allowed in here. */
export function toCustomDataPayload(rows: CustomDatum[]) {
  return rows.map((d) => ({
    key: d.key,
    value: d.valueType === "number" ? Number(d.value) : d.valueType === "boolean" ? d.value === "true" : d.value,
    type: d.valueType,
    status: d.status,
    ...(d.label ? { label: d.label } : {}),
    ...(d.description ? { description: d.description } : {}),
    ...(d.status === "provisional" && d.reason ? { provisional_reason: d.reason } : {}),
    updated_at: d.updatedAt,
  }));
}

function addCustomDataActivity(text: string, by: { kind: "owner" } | { kind: "agent"; id: string; name: string }, reason?: string) {
  const who = by.kind === "owner" ? "you" : by.name;
  emitActivity({
    agentId: COMPANY_CHANNEL, turnId: "company", kind: "status",
    title: "company:custom_data",
    detail: `${text} by ${who}${reason ? ` — ${reason}` : ""}`.slice(0, 300),
  });
}
