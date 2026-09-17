/* ------------------------------------------------------------------
   Company Profile — persistence, validation, the canonical field
   registry and the live "company" activity channel.

   Validation is deterministic and deliberately permissive about
   international values: it catches obvious mistakes (a website that is
   not a URL, an email without a domain) and normalises, nothing more.
   ------------------------------------------------------------------ */

import { emitActivity } from "@/lib/activity";
import { DEFAULT_COMPANY_PROFILE, newId, now, readDb, updateDb } from "@/lib/store/db";
import type { Actor, Address, CompanyActivity, CompanyActivityKind, CompanyContact, CompanyContactType, CompanyInfoRequest, CompanyLegal, CompanyProfile, CompanyProfileView } from "./types";

export const OWNER: Actor = { kind: "owner" };
const actorId = (by: Actor) => (by.kind === "owner" ? "owner" : by.id);
const actorLabel = (by: Actor) => (by.kind === "owner" ? "you" : by.name);

export const COMPANY_CHANNEL = "company";

export const EMPTY_PROFILE = DEFAULT_COMPANY_PROFILE;

const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && !(v && typeof v === "object" && Object.keys(v).length === 0))) as T;

/* ---------------------------------------------------------------- validation */

export function normalizeWebsite(raw: string): string {
  const v = s(raw, 300);
  if (!v) return "";
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { throw new Error(`"${v}" is not a valid website address.`); }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/i.test(u.hostname)) throw new Error(`"${v}" is not a valid website address (expected something like https://example.com).`);
  return u.toString().replace(/\/$/, "");
}

export function normalizeEmail(raw: string): string {
  const v = s(raw, 200).toLowerCase();
  if (!v) return "";
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) throw new Error(`"${raw}" is not a valid email address.`);
  return v;
}

export function normalizePhone(raw: string): string {
  const v = s(raw, 40);
  if (!v) return "";
  if (!/^\+?[\d][\d\s().-]{5,}$/.test(v)) throw new Error(`"${raw}" is not a valid phone number (use the international form, e.g. +1 617 555 0142).`);
  const digits = v.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) throw new Error(`"${raw}" is not a valid phone number (7–15 digits).`);
  // keep the owner's formatting — it is what they want typed into forms
  return v.replace(/\s+/g, " ");
}

/** US EIN → ##-#######; other tax identifiers (VAT etc.) are accepted as written. */
export function normalizeTaxId(raw: string): string {
  const v = s(raw, 40);
  if (!v) return "";
  const digits = v.replace(/\D/g, "");
  if (/^[\d-]+$/.test(v)) {
    if (digits.length !== 9) throw new Error("A US EIN has 9 digits (##-#######). For a non-US tax identifier include its letters, e.g. GB123456789.");
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 .\-/]{3,}$/.test(v)) throw new Error(`"${raw}" is not a valid tax identifier.`);
  return v.toUpperCase();
}

export function normalizeTimezone(raw: string): string {
  const v = s(raw, 60);
  if (!v) return "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
  } catch {
    throw new Error(`"${raw}" is not a known IANA timezone (e.g. America/New_York).`);
  }
  return v;
}

export function normalizeDate(raw: string): string {
  const v = s(raw, 30);
  if (!v) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new Error("Use the date format YYYY-MM-DD.");
  return v;
}

export function normalizeAddress(a: unknown): Address {
  const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
  const postal = s(o.postalCode ?? o.postal_code, 20);
  if (postal && !/^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/.test(postal)) throw new Error(`"${postal}" is not a valid postal code.`);
  return clean({ line1: s(o.line1, 160), line2: s(o.line2, 160), city: s(o.city, 100), region: s(o.region ?? o.state, 100), postalCode: postal, country: s(o.country, 80) });
}

export const hasAddress = (a?: Address) => !!a && Object.values(a).some(Boolean);

export function formatAddress(a?: Address): string {
  if (!hasAddress(a)) return "";
  return [a!.line1, a!.line2, a!.city, [a!.region, a!.postalCode].filter(Boolean).join(" "), a!.country].filter(Boolean).join(", ");
}

export function maskTaxId(v?: string): string | undefined {
  if (!v) return undefined;
  const tail = v.slice(-4);
  return `${"•".repeat(Math.max(v.length - 4, 2))}${tail}`;
}

/* ---------------------------------------------------------------- profile */

export function getProfile(): CompanyProfile {
  const p = readDb().companyProfile;
  return p ? { ...EMPTY_PROFILE, ...p, address: p.address ?? {}, billingAddress: p.billingAddress ?? {}, legal: p.legal ?? {}, contacts: p.contacts ?? [] } : { ...EMPTY_PROFILE };
}

export function resolvedBilling(p: CompanyProfile): Address {
  return p.billingSameAsCompany ? p.address : p.billingAddress;
}

export function toProfileView(p: CompanyProfile, reveal = false): CompanyProfileView {
  const { taxId, ...legalRest } = p.legal;
  return {
    ...p,
    legal: { ...legalRest, hasTaxId: !!taxId, taxIdMasked: maskTaxId(taxId), ...(reveal && taxId ? { taxId } : {}) },
    resolvedBillingAddress: resolvedBilling(p),
  };
}

export type ProfilePatch = {
  name?: string; legalName?: string; entityType?: string; industry?: string; website?: string; description?: string; timezone?: string;
  ownerFirstName?: string; ownerLastName?: string; ownerTitle?: string;
  address?: unknown; billingSameAsCompany?: boolean; billingAddress?: unknown;
  legal?: Partial<CompanyLegal> & { taxId?: string; registeredAddress?: unknown };
};

/**
 * Edit the profile. Only keys present in the patch are touched.
 *
 * The owner may clear a field with "" and replaces an address wholesale.
 * An authorized agent may only add or correct values: empty strings are
 * ignored and addresses are merged, so an agent can never silently erase
 * company data.
 */
export function updateProfile(patch: ProfilePatch, by: Actor = OWNER): CompanyProfile {
  const agent = by.kind === "agent";
  const before = getProfile();
  const changed: string[] = [];
  const next: CompanyProfile = { ...before, address: { ...before.address }, billingAddress: { ...before.billingAddress }, legal: { ...before.legal }, contacts: [...before.contacts] };
  const keep = (v: string) => agent && !v; // agents cannot blank an existing value

  const setText = (key: "name" | "legalName" | "entityType" | "industry" | "description" | "ownerFirstName" | "ownerLastName" | "ownerTitle", label: string, max: number) => {
    if (patch[key] === undefined) return;
    const v = s(patch[key], max);
    if ((next[key] ?? "") === v || keep(v)) return;
    if (key === "name") next.name = v; else next[key] = v || undefined;
    changed.push(label);
  };
  setText("name", "name", 120);
  setText("legalName", "legal name", 160);
  setText("entityType", "entity type", 60);
  setText("industry", "industry", 120);
  setText("description", "description", 600);
  setText("ownerFirstName", "owner name", 80);
  setText("ownerLastName", "owner name", 80);
  setText("ownerTitle", "owner title", 80);
  if (patch.website !== undefined) { const v = normalizeWebsite(String(patch.website ?? "")); if ((next.website ?? "") !== v && !keep(v)) { next.website = v || undefined; changed.push("website"); } }
  if (patch.timezone !== undefined) { const v = normalizeTimezone(String(patch.timezone ?? "")); if ((next.timezone ?? "") !== v && !keep(v)) { next.timezone = v || undefined; changed.push("timezone"); } }
  if (patch.address !== undefined) { const v = mergeAddress(next.address, normalizeAddress(patch.address), agent); if (JSON.stringify(v) !== JSON.stringify(next.address)) { next.address = v; changed.push("company address"); } }
  if (patch.billingSameAsCompany !== undefined && !!patch.billingSameAsCompany !== next.billingSameAsCompany) { next.billingSameAsCompany = !!patch.billingSameAsCompany; changed.push("billing address"); }
  if (patch.billingAddress !== undefined) { const v = mergeAddress(next.billingAddress, normalizeAddress(patch.billingAddress), agent); if (JSON.stringify(v) !== JSON.stringify(next.billingAddress)) { next.billingAddress = v; changed.push("billing address"); } }
  if (patch.legal) {
    const l = patch.legal;
    const legal: CompanyLegal = { ...next.legal };
    const setLegal = (k: "entityType" | "registrationState" | "registrationCountry" | "registrationNumber", v: string) => { if (!keep(v)) legal[k] = v || undefined; };
    if (l.entityType !== undefined) setLegal("entityType", s(l.entityType, 60));
    if (l.registrationState !== undefined) setLegal("registrationState", s(l.registrationState, 100));
    if (l.registrationCountry !== undefined) setLegal("registrationCountry", s(l.registrationCountry, 80));
    if (l.registrationNumber !== undefined) setLegal("registrationNumber", s(l.registrationNumber, 60));
    if (l.formationDate !== undefined) { const v = normalizeDate(String(l.formationDate ?? "")); if (!keep(v)) legal.formationDate = v || undefined; }
    if (l.taxId !== undefined) { const v = normalizeTaxId(String(l.taxId ?? "")); if (!keep(v)) legal.taxId = v || undefined; }
    if (l.registeredAddress !== undefined) { const v = mergeAddress(next.legal.registeredAddress ?? {}, normalizeAddress(l.registeredAddress), agent); legal.registeredAddress = hasAddress(v) ? v : undefined; }
    if (JSON.stringify(legal) !== JSON.stringify(next.legal)) { next.legal = legal; changed.push("legal information"); }
  }
  if (!changed.length) return before;
  const ts = now();
  next.updatedAt = ts;
  next.updatedBy = actorId(by);
  if (next.createdAt === EMPTY_PROFILE.createdAt) next.createdAt = ts;
  updateDb((d) => { d.companyProfile = next; });
  const unique = [...new Set(changed)];
  const kind: CompanyActivityKind = unique.length === 1 && unique[0] === "legal information" ? "legal_updated" : unique.length === 1 && unique[0] === "billing address" ? "billing_updated" : "profile_updated";
  addCompanyActivity(kind, `Company profile updated by ${actorLabel(by)}: ${unique.join(", ")}`, by.kind === "agent" ? { agentId: by.id, reason: by.reason } : {});
  return next;
}

/** Owner replaces an address; an agent may only fill in or correct individual lines. */
function mergeAddress(current: Address, incoming: Address, agent: boolean): Address {
  if (!agent) return incoming;
  return clean({ ...current, ...incoming });
}

/* ---------------------------------------------------------------- contacts */

export type ContactInput = { type: CompanyContactType; name: string; value: string; description: string; isPrimary?: boolean; status?: CompanyContact["status"] };

function validateContact(type: CompanyContactType, value: string): string {
  return type === "EMAIL" ? normalizeEmail(value) : normalizePhone(value);
}

export function addContact(input: ContactInput, by: Actor = OWNER): CompanyContact {
  const type: CompanyContactType = input.type === "PHONE" ? "PHONE" : "EMAIL";
  const name = s(input.name, 80);
  const description = s(input.description, 600);
  const value = validateContact(type, String(input.value ?? ""));
  if (!name) throw new Error("A contact needs a short name, e.g. \"Primary Company Email\".");
  if (!value) throw new Error(type === "EMAIL" ? "An email address is required." : "A phone number is required.");
  if (description.length < 10) throw new Error("Describe what this contact is used for (at least 10 characters) so agents can choose the right one.");
  const profile = getProfile();
  if (profile.contacts.some((c) => c.type === type && c.value.toLowerCase() === value.toLowerCase())) throw new Error(`${value} is already saved as a company contact.`);
  const ts = now();
  const rec: CompanyContact = { id: newId(), type, name, value, description, isPrimary: input.isPrimary ?? !profile.contacts.some((c) => c.type === type && c.isPrimary), status: input.status ?? "ACTIVE", createdBy: actorId(by), createdAt: ts, updatedAt: ts };
  updateDb((d) => {
    const p = d.companyProfile ?? { ...EMPTY_PROFILE, createdAt: ts };
    p.contacts = [...(p.contacts ?? [])];
    if (rec.isPrimary) for (const c of p.contacts) if (c.type === type) c.isPrimary = false;
    p.contacts.push(rec);
    p.updatedAt = ts;
    d.companyProfile = p;
  });
  addCompanyActivity("contact_added", `Company contact added by ${actorLabel(by)}: ${rec.name} (${rec.type === "EMAIL" ? "email" : "phone"})`, by.kind === "agent" ? { agentId: by.id, reason: by.reason } : {});
  return rec;
}

export function updateContact(id: string, patch: Partial<ContactInput>, by: Actor = OWNER): CompanyContact {
  const profile = getProfile();
  const cur = profile.contacts.find((c) => c.id === id);
  if (!cur) throw new Error("Company contact not found.");
  const type = patch.type ?? cur.type;
  const value = patch.value !== undefined ? validateContact(type, String(patch.value)) : cur.value;
  const description = patch.description !== undefined ? s(patch.description, 600) : cur.description;
  if (patch.description !== undefined && description.length < 10) throw new Error("Describe what this contact is used for (at least 10 characters).");
  const name = patch.name !== undefined ? s(patch.name, 80) || cur.name : cur.name;
  const ts = now();
  const rec = updateDb((d) => {
    const p = d.companyProfile!;
    const c = p.contacts.find((x) => x.id === id)!;
    Object.assign(c, { type, name, value, description, updatedAt: ts, updatedBy: actorId(by) });
    if (patch.status) c.status = patch.status;
    if (patch.isPrimary !== undefined) {
      c.isPrimary = !!patch.isPrimary;
      if (c.isPrimary) for (const other of p.contacts) if (other.id !== id && other.type === type) other.isPrimary = false;
    }
    p.updatedAt = ts;
    return c;
  });
  addCompanyActivity("contact_updated", `Company contact updated by ${actorLabel(by)}: ${rec.name}`, by.kind === "agent" ? { agentId: by.id, reason: by.reason } : {});
  return rec;
}

export function removeContact(id: string): void {
  const cur = getProfile().contacts.find((c) => c.id === id);
  if (!cur) throw new Error("Company contact not found.");
  updateDb((d) => {
    const p = d.companyProfile!;
    p.contacts = p.contacts.filter((c) => c.id !== id);
    const stillPrimary = p.contacts.some((c) => c.type === cur.type && c.isPrimary);
    const first = p.contacts.find((c) => c.type === cur.type);
    if (!stillPrimary && first) first.isPrimary = true;
    p.updatedAt = now();
  });
  addCompanyActivity("contact_removed", `Company contact removed: ${cur.name}`);
}

export function primaryContact(p: CompanyProfile, type: CompanyContactType): CompanyContact | null {
  const active = p.contacts.filter((c) => c.type === type && c.status === "ACTIVE");
  return active.find((c) => c.isPrimary) ?? active[0] ?? null;
}

/* ---------------------------------------------------------------- field registry */

/** Canonical field keys: what an agent may ask for and how we know it is filled. */
export const FIELDS: { key: string; label: string; section: "general" | "contact" | "address" | "billing" | "legal"; get: (p: CompanyProfile) => string }[] = [
  { key: "name", label: "Company name", section: "general", get: (p) => p.name },
  { key: "legal_name", label: "Legal name", section: "general", get: (p) => p.legalName ?? "" },
  { key: "entity_type", label: "Business / entity type", section: "general", get: (p) => p.entityType ?? p.legal.entityType ?? "" },
  { key: "industry", label: "Industry", section: "general", get: (p) => p.industry ?? "" },
  { key: "website", label: "Website", section: "general", get: (p) => p.website ?? "" },
  { key: "description", label: "Company description", section: "general", get: (p) => p.description ?? "" },
  { key: "timezone", label: "Timezone", section: "general", get: (p) => p.timezone ?? "" },
  { key: "owner_name", label: "Owner / primary contact name", section: "general", get: (p) => ownerName(p) },
  { key: "primary_email", label: "Primary company email", section: "contact", get: (p) => primaryContact(p, "EMAIL")?.value ?? "" },
  { key: "primary_phone", label: "Primary company phone", section: "contact", get: (p) => primaryContact(p, "PHONE")?.value ?? "" },
  { key: "address", label: "Company address", section: "address", get: (p) => formatAddress(p.address) },
  { key: "billing_address", label: "Billing address", section: "billing", get: (p) => formatAddress(resolvedBilling(p)) },
  { key: "legal.entity_type", label: "Legal entity type", section: "legal", get: (p) => p.legal.entityType ?? p.entityType ?? "" },
  { key: "legal.registration_state", label: "State / region of registration", section: "legal", get: (p) => p.legal.registrationState ?? "" },
  { key: "legal.registration_country", label: "Country of registration", section: "legal", get: (p) => p.legal.registrationCountry ?? "" },
  { key: "legal.formation_date", label: "Date established", section: "legal", get: (p) => p.legal.formationDate ?? "" },
  { key: "legal.tax_id", label: "EIN / tax identifier", section: "legal", get: (p) => p.legal.taxId ?? "" },
  { key: "legal.registration_number", label: "Registration number", section: "legal", get: (p) => p.legal.registrationNumber ?? "" },
  { key: "legal.registered_address", label: "Registered legal address", section: "legal", get: (p) => formatAddress(p.legal.registeredAddress) },
];

export const ownerName = (p: CompanyProfile) => [p.ownerFirstName, p.ownerLastName].filter(Boolean).join(" ");

export const findField = (key: string) => FIELDS.find((f) => f.key === key.trim().toLowerCase().replace(/\s+/g, "_"));

/* ---------------------------------------------------------------- info requests */

/**
 * Where the value belongs, derived from the key itself: a canonical profile
 * field, or a Custom Data entry. Derived rather than trusted from the row, so
 * requests written before the distinction existed resolve correctly too.
 */
export const requestTarget = (r: Pick<CompanyInfoRequest, "field">): "profile" | "custom_data" => (findField(r.field) ? "profile" : "custom_data");

export function listCompanyRequests(): CompanyInfoRequest[] {
  return readDb().companyInfoRequests.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const getCompanyRequest = (id: string) => readDb().companyInfoRequests.find((r) => r.id === id) ?? null;

export function insertCompanyRequest(r: CompanyInfoRequest): CompanyInfoRequest {
  updateDb((d) => { d.companyInfoRequests.push(r); });
  return r;
}

export function patchCompanyRequest(id: string, patch: Partial<CompanyInfoRequest>): CompanyInfoRequest {
  return updateDb((d) => {
    const r = d.companyInfoRequests.find((x) => x.id === id);
    if (!r) throw new Error("Company information request not found.");
    Object.assign(r, patch, { updatedAt: now() });
    return r;
  });
}

/* ---------------------------------------------------------------- activity */

export function addCompanyActivity(kind: CompanyActivityKind, text: string, extra: { agentId?: string; requestId?: string; reason?: string } = {}): CompanyActivity {
  const rec: CompanyActivity = { id: newId(), ts: Date.now(), kind, text: text.slice(0, 300), ...extra, reason: extra.reason?.slice(0, 300) };
  updateDb((d) => {
    d.companyActivity.push(rec);
    if (d.companyActivity.length > 1000) d.companyActivity.splice(0, d.companyActivity.length - 1000);
  });
  emitActivity({ agentId: COMPANY_CHANNEL, turnId: "company", kind: "status", title: `company:${kind}`, detail: rec.text });
  return rec;
}

export function listCompanyActivity(limit = 60): CompanyActivity[] {
  return readDb().companyActivity.slice().sort((a, b) => b.ts - a.ts).slice(0, limit);
}
