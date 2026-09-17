/* ------------------------------------------------------------------
   Credential Manager — persistence and the live "credentials" channel.
   Passwords live only in the vault (hidden credential, key PASSWORD).
   ------------------------------------------------------------------ */

import { emitActivity } from "@/lib/activity";
import { newId, now, readDb, updateDb } from "@/lib/store/db";
import { createCredential, credentialValues, updateCredential } from "@/lib/mcp/store";
import type { CredentialActivity, CredentialActivityKind, CredentialRequest, CredentialType, LoginCredential, LoginCredentialView } from "./types";

export const CREDENTIALS_CHANNEL = "credentials";

export function maskUsername(u: string): string {
  if (!u) return "";
  const at = u.indexOf("@");
  if (at > 0) return `${u.slice(0, 1)}••••${u.slice(at)}`;
  if (u.length <= 2) return "••••";
  return `${u.slice(0, 1)}••••${u.slice(-1)}`;
}

export function toView(c: LoginCredential): LoginCredentialView {
  const { vaultCredentialId, username, ...rest } = c;
  void vaultCredentialId;
  return { ...rest, usernameMasked: maskUsername(username), hasPassword: true };
}

export function listLoginCredentials(): LoginCredential[] {
  return readDb().loginCredentials.slice().sort((a, b) => a.name.localeCompare(b.name));
}

export function getLoginCredential(id: string): LoginCredential | null {
  return readDb().loginCredentials.find((c) => c.id === id) ?? null;
}

/** id, unambiguous id prefix, or exact name (case-insensitive) */
export function findLoginCredential(ref: string): LoginCredential | null {
  const all = readDb().loginCredentials;
  const r = ref.trim();
  return all.find((c) => c.id === r) ?? all.find((c) => c.name.toLowerCase() === r.toLowerCase()) ?? (all.filter((c) => c.id.startsWith(r)).length === 1 ? all.find((c) => c.id.startsWith(r))! : null);
}

export type LoginCredentialInput = {
  name: string; service: string; site: string; loginUrl?: string; description: string; username: string; password: string; type?: CredentialType; createdBy: string;
};

function clean(input: Partial<LoginCredentialInput>) {
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  return { name: s(input.name, 120), service: s(input.service, 80), site: s(input.site, 200).replace(/^https?:\/\//, "").replace(/\/.*$/, ""), loginUrl: s(input.loginUrl, 500), description: s(input.description, 1_000), username: s(input.username, 200), password: typeof input.password === "string" ? input.password : "" };
}

export function createLoginCredential(input: LoginCredentialInput): LoginCredential {
  const c = clean(input);
  if (!c.name) throw new Error("name is required.");
  if (!c.service) throw new Error("service is required.");
  if (!c.site) throw new Error("site (domain) is required.");
  if (c.description.length < 20) throw new Error("description must explain which site/account this is for and what it is used for (at least 20 characters).");
  if (!c.username) throw new Error("username is required.");
  if (!c.password) throw new Error("password is required.");
  if (c.loginUrl && !/^https?:\/\//.test(c.loginUrl)) throw new Error("login_url must start with http:// or https://");
  if (readDb().loginCredentials.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) throw new Error(`A credential named "${c.name}" already exists — update it instead.`);
  const id = newId();
  const vault = createCredential(`login:${id}`, { USERNAME: c.username, PASSWORD: c.password }, { hidden: true });
  const ts = now();
  const rec: LoginCredential = { id, name: c.name, service: c.service, site: c.site, loginUrl: c.loginUrl || undefined, description: c.description, username: c.username, type: input.type ?? "username_password", status: "AVAILABLE", vaultCredentialId: vault.id, createdBy: input.createdBy, createdAt: ts, updatedAt: ts, useCount: 0 };
  updateDb((d) => { d.loginCredentials.push(rec); });
  addCredentialActivity("created", `Credential created: ${rec.name}`, { credentialId: rec.id, agentId: input.createdBy });
  return rec;
}

export function updateLoginCredential(id: string, patch: Partial<LoginCredentialInput> & { status?: LoginCredential["status"] }, by: string): LoginCredential {
  const cur = getLoginCredential(id);
  if (!cur) throw new Error("Credential not found.");
  const c = clean(patch);
  const rec = updateDb((d) => {
    const x = d.loginCredentials.find((y) => y.id === id)!;
    if (patch.name !== undefined && c.name) x.name = c.name;
    if (patch.service !== undefined && c.service) x.service = c.service;
    if (patch.site !== undefined && c.site) x.site = c.site;
    if (patch.loginUrl !== undefined) x.loginUrl = c.loginUrl || undefined;
    if (patch.description !== undefined && c.description) x.description = c.description;
    if (patch.username !== undefined && c.username) x.username = c.username;
    if (patch.type) x.type = patch.type;
    if (patch.status) x.status = patch.status;
    x.updatedAt = now();
    return x;
  });
  const values: Record<string, string> = {};
  if (patch.username !== undefined && c.username) values.USERNAME = c.username;
  if (patch.password !== undefined && c.password) values.PASSWORD = c.password;
  if (Object.keys(values).length) updateCredential(cur.vaultCredentialId, { values });
  addCredentialActivity(patch.status ? (patch.status === "DISABLED" ? "disabled" : "enabled") : "updated", `Credential ${patch.status ? patch.status.toLowerCase() : "updated"}: ${rec.name}`, { credentialId: id, agentId: by });
  return rec;
}

export function deleteLoginCredential(id: string): void {
  const cur = getLoginCredential(id);
  if (!cur) throw new Error("Credential not found.");
  updateDb((d) => {
    d.loginCredentials = d.loginCredentials.filter((c) => c.id !== id);
    d.credentials = d.credentials.filter((c) => c.id !== cur.vaultCredentialId);
  });
  addCredentialActivity("deleted", `Credential deleted: ${cur.name}`, { credentialId: id });
}

/** server-internal only: secret values for an insertion */
export function loginSecrets(c: LoginCredential): { username: string; password: string } {
  const v = credentialValues(c.vaultCredentialId);
  return { username: v.USERNAME ?? c.username, password: v.PASSWORD ?? "" };
}

export function recordUse(id: string, agentId: string, fields: string[]): void {
  const rec = updateDb((d) => {
    const x = d.loginCredentials.find((y) => y.id === id);
    if (x) { x.lastUsedAt = now(); x.lastUsedBy = agentId; x.useCount += 1; }
    return x;
  });
  if (rec) addCredentialActivity("used", `Credential used: ${rec.name} (${fields.join(", ")})`, { credentialId: id, agentId });
}

/* ---------------------------------------------------------------- requests */

export function listCredentialRequests(): CredentialRequest[] {
  return readDb().credentialRequests.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getCredentialRequest(id: string): CredentialRequest | null {
  return readDb().credentialRequests.find((r) => r.id === id) ?? null;
}

export function insertCredentialRequest(r: CredentialRequest): CredentialRequest {
  updateDb((d) => { d.credentialRequests.push(r); });
  return r;
}

export function patchCredentialRequest(id: string, patch: Partial<CredentialRequest>): CredentialRequest {
  return updateDb((d) => {
    const r = d.credentialRequests.find((x) => x.id === id);
    if (!r) throw new Error("Credential request not found.");
    Object.assign(r, patch, { updatedAt: now() });
    return r;
  });
}

/* ---------------------------------------------------------------- activity */

export function addCredentialActivity(kind: CredentialActivityKind, text: string, extra: { credentialId?: string; agentId?: string; requestId?: string } = {}): CredentialActivity {
  const rec: CredentialActivity = { id: newId(), ts: Date.now(), kind, text: text.slice(0, 300), ...extra };
  updateDb((d) => {
    d.credentialActivity.push(rec);
    if (d.credentialActivity.length > 2000) d.credentialActivity.splice(0, d.credentialActivity.length - 2000);
  });
  emitActivity({ agentId: CREDENTIALS_CHANNEL, turnId: "credentials", kind: "status", title: `credential:${kind}`, detail: rec.text });
  return rec;
}

export function listCredentialActivity(limit = 100): CredentialActivity[] {
  return readDb().credentialActivity.slice().sort((a, b) => b.ts - a.ts).slice(0, limit);
}
