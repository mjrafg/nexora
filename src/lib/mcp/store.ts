/* ------------------------------------------------------------------
   Persistence for the MCP engine. Adapted from Tandem's integrations store.

   Credential secret material is encrypted at rest (AES-256-GCM, key file owned
   by the service user) and is NEVER returned by any API — the execution layer
   decrypts it in-process at call time only.
   ------------------------------------------------------------------ */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newId, now, readDb, updateDb } from "@/lib/store/db";
import type {
  CredentialMeta,
  McpGrant,
  McpOAuthMeta,
  McpServerConfig,
  McpServerRecord,
  McpToolRecord,
} from "./types";

const DATA_DIR = process.env.NEXORA_DATA_DIR ?? path.join(process.cwd(), "data");
const KEY_FILE = path.join(DATA_DIR, "mcp-secret.key");

/* ---------------------------------------------------------------- encryption */

function secretKey(): Buffer {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
    fs.chmodSync(KEY_FILE, 0o600);
  }
  return Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");
}

export function encryptSecret(obj: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
}

export function decryptSecret(blob: string): Record<string, string> {
  const [iv, tag, ct] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"));
}

/* ---------------------------------------------------------------- credentials */

/** Internal storage shape (in nexora.json). `data` is the encrypted blob. */
export type CredentialRow = { id: string; name: string; data: string; createdAt: string; updatedAt: string; /** payment-method secrets: never listed with MCP credentials */ hidden?: boolean };

function serversUsingCredential(credentialId: string): string[] {
  return readDb()
    .mcpServers.filter((s) => s.credentialId === credentialId)
    .map((s) => s.name);
}

function rowToMeta(row: CredentialRow): CredentialMeta {
  let keys: string[] = [];
  try {
    keys = Object.keys(decryptSecret(row.data));
  } catch {
    keys = [];
  }
  return { id: row.id, name: row.name, keys, createdAt: row.createdAt, updatedAt: row.updatedAt, usedBy: serversUsingCredential(row.id) };
}

export function listCredentials(): CredentialMeta[] {
  return readDb()
    .credentials.filter((c) => !c.hidden)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(rowToMeta);
}

export function createCredential(name: string, values: Record<string, string>, opts: { hidden?: boolean } = {}): CredentialMeta {
  const clean = cleanValues(values);
  if (!name.trim()) throw new Error("Credential name is required.");
  if (Object.keys(clean).length === 0) throw new Error("Add at least one secret value.");
  if (!opts.hidden && readDb().credentials.some((c) => !c.hidden && c.name.toLowerCase() === name.trim().toLowerCase())) {
    throw new Error("A credential with that name already exists.");
  }
  const ts = now();
  const row: CredentialRow = { id: newId(), name: name.trim(), data: encryptSecret(clean), createdAt: ts, updatedAt: ts, ...(opts.hidden ? { hidden: true } : {}) };
  updateDb((d) => {
    d.credentials.push(row);
  });
  return rowToMeta(row);
}

/** Replace/rename. Provided values are merged; a value of "" deletes that key. */
export function updateCredential(id: string, patch: { name?: string; values?: Record<string, string> }): CredentialMeta {
  const result = updateDb((d) => {
    const row = d.credentials.find((c) => c.id === id);
    if (!row) throw new Error("Credential not found.");
    if (patch.name?.trim()) row.name = patch.name.trim();
    if (patch.values) {
      const data = safeDecrypt(row.data);
      for (const [k, v] of Object.entries(patch.values)) {
        const key = k.trim();
        if (!key) continue;
        if (v === "") delete data[key];
        else data[key] = v;
      }
      if (Object.keys(data).length === 0) throw new Error("A credential must keep at least one value.");
      row.data = encryptSecret(data);
    }
    row.updatedAt = now();
    return row;
  });
  return rowToMeta(result);
}

export function deleteCredential(id: string): void {
  const used = serversUsingCredential(id);
  if (used.length) throw new Error(`In use by: ${used.join(", ")} — detach it there first.`);
  updateDb((d) => {
    d.credentials = d.credentials.filter((c) => c.id !== id);
  });
}

/** server-internal only: decrypted secret values for execution */
export function credentialValues(id: string | null): Record<string, string> {
  if (!id) return {};
  const row = readDb().credentials.find((c) => c.id === id);
  return row ? safeDecrypt(row.data) : {};
}

/** every secret string of a credential — used to scrub outputs/errors */
export function credentialSecretStrings(id: string | null): string[] {
  return Object.values(credentialValues(id)).filter((v) => v.length >= 4);
}

function safeDecrypt(blob: string): Record<string, string> {
  try {
    return decryptSecret(blob);
  } catch {
    return {};
  }
}

function cleanValues(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    const key = k.trim();
    if (key && typeof v === "string" && v.length) out[key] = v;
  }
  return out;
}

/* ---------------------------------------------------------------- servers */

export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  if (!s) throw new Error("Server name must contain letters or digits.");
  return s;
}

export function listServers(): McpServerRecord[] {
  return readDb().mcpServers.slice().sort((a, b) => a.name.localeCompare(b.name));
}

export function getServer(id: string): McpServerRecord | null {
  return readDb().mcpServers.find((s) => s.id === id) ?? null;
}

export function toolsForServer(serverId: string): McpToolRecord[] {
  return readDb()
    .mcpTools.filter((t) => t.serverId === serverId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function credentialName(id: string | null): string | null {
  if (!id) return null;
  return readDb().credentials.find((c) => c.id === id)?.name ?? null;
}

export function createServer(input: { name: string; config: McpServerConfig; credentialId?: string | null }): McpServerRecord {
  const db = readDb();
  if (!input.name.trim()) throw new Error("Server name is required.");
  if (input.credentialId && !db.credentials.some((c) => c.id === input.credentialId)) {
    throw new Error("Referenced credential does not exist.");
  }
  let slug = slugify(input.name);
  if (db.mcpServers.some((s) => s.slug === slug)) slug = `${slug.slice(0, 27)}_${newId().slice(0, 4)}`;
  const ts = now();
  const record: McpServerRecord = {
    id: newId(),
    slug,
    name: input.name.trim(),
    enabled: true,
    config: input.config,
    credentialId: input.credentialId ?? null,
    createdAt: ts,
    updatedAt: ts,
    lastTestAt: null,
    lastTestOk: null,
    lastTestError: null,
  };
  updateDb((d) => {
    d.mcpServers.push(record);
  });
  return record;
}

export function updateServer(id: string, patch: { name?: string; config?: McpServerConfig; credentialId?: string | null; enabled?: boolean }): McpServerRecord {
  return updateDb((d) => {
    const s = d.mcpServers.find((x) => x.id === id);
    if (!s) throw new Error("Server not found.");
    if (patch.credentialId && !d.credentials.some((c) => c.id === patch.credentialId)) throw new Error("Referenced credential does not exist.");
    if (patch.name?.trim()) s.name = patch.name.trim();
    if (patch.config) s.config = patch.config;
    if (patch.credentialId !== undefined) s.credentialId = patch.credentialId;
    if (patch.enabled !== undefined) s.enabled = patch.enabled;
    s.updatedAt = now();
    return s;
  });
}

export function recordServerTest(id: string, ok: boolean, error?: string): void {
  updateDb((d) => {
    const s = d.mcpServers.find((x) => x.id === id);
    if (s) {
      s.lastTestAt = now();
      s.lastTestOk = ok;
      s.lastTestError = ok ? null : error ?? null;
    }
  });
}

export function deleteServer(id: string): void {
  updateDb((d) => {
    d.mcpServers = d.mcpServers.filter((s) => s.id !== id);
    d.mcpTools = d.mcpTools.filter((t) => t.serverId !== id);
    // drop grants that reference this server
    for (const a of d.agents) {
      if (a.mcpGrants?.length) a.mcpGrants = a.mcpGrants.filter((g) => g.serverId !== id);
    }
  });
}

/* ---------------------------------------------------------------- tools */

export function toolFullName(slug: string, name: string): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  if (!clean) throw new Error(`Tool name "${name}" contains no usable characters.`);
  return `${slug}__${clean}`;
}

/** Upsert a discovered tool, preserving nothing editable (Agent24 tools carry no per-tool settings). */
export function upsertTool(server: McpServerRecord, input: { name: string; description: string; inputSchema: McpToolRecord["inputSchema"]; annotations?: McpToolRecord["annotations"] }): McpToolRecord {
  const fullName = toolFullName(server.slug, input.name);
  return updateDb((d) => {
    const existing = d.mcpTools.find((t) => t.fullName === fullName);
    if (existing) {
      existing.description = input.description;
      existing.inputSchema = input.inputSchema;
      existing.annotations = input.annotations ?? existing.annotations ?? null;
      existing.missing = false;
      return existing;
    }
    const rec: McpToolRecord = {
      id: newId(),
      serverId: server.id,
      name: input.name,
      fullName,
      description: input.description,
      inputSchema: input.inputSchema,
      annotations: input.annotations ?? null,
      createdAt: now(),
    };
    d.mcpTools.push(rec);
    return rec;
  });
}

export function markMissingExcept(serverId: string, keepFullNames: string[]): void {
  updateDb((d) => {
    for (const t of d.mcpTools) {
      if (t.serverId === serverId) t.missing = !keepFullNames.includes(t.fullName);
    }
  });
}

export function getToolByFullName(fullName: string): { tool: McpToolRecord; server: McpServerRecord } | null {
  const db = readDb();
  const tool = db.mcpTools.find((t) => t.fullName === fullName);
  if (!tool) return null;
  const server = db.mcpServers.find((s) => s.id === tool.serverId);
  return server ? { tool, server } : null;
}

/* ---------------------------------------------------------------- grants */

export function normalizeGrants(grants: unknown): McpGrant[] {
  if (!Array.isArray(grants)) return [];
  const servers = new Set(readDb().mcpServers.map((s) => s.id));
  const out: McpGrant[] = [];
  for (const g of grants) {
    const grant = g as Partial<McpGrant>;
    if (typeof grant?.serverId !== "string" || !servers.has(grant.serverId)) continue;
    out.push({
      serverId: grant.serverId,
      enabled: grant.enabled !== false,
      tools: grant.tools === "all" || !Array.isArray(grant.tools) ? "all" : grant.tools.filter((t): t is string => typeof t === "string"),
    });
  }
  return out;
}

/* ---------------------------------------------------------------- oauth */

export type OAuthSecret = { clientSecret?: string; accessToken: string; refreshToken?: string };

export function updateServerOAuth(id: string, oauth: McpOAuthMeta): void {
  updateDb((d) => {
    const s = d.mcpServers.find((x) => x.id === id);
    if (s) {
      s.oauth = oauth;
      s.updatedAt = now();
    }
  });
}

export function readOAuthSecret(id: string): OAuthSecret | null {
  const s = readDb().mcpServers.find((x) => x.id === id);
  if (!s?.oauthSecretEnc) return null;
  try {
    return decryptSecret(s.oauthSecretEnc) as unknown as OAuthSecret;
  } catch {
    return null;
  }
}

export function writeOAuthSecret(id: string, secret: OAuthSecret | null): void {
  updateDb((d) => {
    const s = d.mcpServers.find((x) => x.id === id);
    if (!s) return;
    if (secret === null) delete s.oauthSecretEnc;
    else s.oauthSecretEnc = encryptSecret(secret as unknown as Record<string, string>);
    s.updatedAt = now();
  });
}
