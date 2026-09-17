/* ------------------------------------------------------------------
   Credential Manager — insertion, requests, auto-resume, passwords.
   ------------------------------------------------------------------ */

import { randomBytes, randomInt } from "node:crypto";
import { newId, now, readDb } from "@/lib/store/db";
import { clearAgentWaiting, setAgentWaiting } from "@/lib/agents/waiting";
import { renderPrompt } from "@/lib/prompts";
import { handleBrowserTool } from "@/lib/browser/host";
import { browserScopeFor } from "@/lib/browser";
import type { ToolCallContext } from "@/lib/tools/internal";
import { addCredentialActivity, getCredentialRequest, getLoginCredential, insertCredentialRequest, listCredentialRequests, loginSecrets, patchCredentialRequest } from "./store";
import type { CredentialRequest, LoginCredential } from "./types";

const short = (id: string) => id.slice(0, 8);

/* ---------------------------------------------------------------- password generation */

/** Deterministic strong password: mixed classes, no ambiguous glyphs, CSPRNG. */
export function generatePassword(length = 20): string {
  const L = Math.min(Math.max(Math.floor(length) || 20, 12), 64);
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digit = "23456789";
  const symbol = "!@#$%^&*-_=+?";
  const all = upper + lower + digit + symbol;
  const pick = (set: string) => set[randomInt(set.length)];
  const chars = [pick(upper), pick(lower), pick(digit), pick(symbol)];
  while (chars.length < L) chars.push(pick(all));
  // Fisher–Yates with CSPRNG
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE(0) % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/* ---------------------------------------------------------------- insertion */

export type InsertField = "username" | "password";

function targetArgs(target: string): { ref?: string; selector?: string } {
  const t = target.trim();
  if (/^((f\d+)?e\d+|t\d+)$/i.test(t)) return { ref: t };
  return { selector: t };
}

/** Type one credential field into a browser element. Never returns the value. */
export async function insertCredentialField(cred: LoginCredential, field: InsertField, target: string, ctx: ToolCallContext, browserKey?: string): Promise<{ ok: boolean; message: string }> {
  if (cred.status !== "AVAILABLE") return { ok: false, message: `Credential "${cred.name}" is disabled.` };
  const secrets = loginSecrets(cred);
  const value = field === "username" ? secrets.username : secrets.password;
  if (!value) return { ok: false, message: `Credential "${cred.name}" has no ${field}.` };
  // the agent may only drive its own browser sessions
  const key = browserKey && browserKey.startsWith(`agent:${ctx.agentId}`) ? browserKey : undefined;
  const scope = browserScopeFor(ctx.agentId, key);
  const r = await handleBrowserTool(scope, "browser_type", { ...targetArgs(target), text: value, sensitive: true, element: `${field} field (${cred.name})` });
  const text = r.content ? r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n") : r.text ?? "";
  if (r.isError) return { ok: false, message: text.replace(value, "•••") };
  ctx.emit.event({ kind: "browser", title: `Credential inserted: ${cred.name} · ${field}`, meta: "Credentials", status: "done", browser: { action: "type", value: "•••", url: r.report?.url, title: r.report?.title, ref: target } });
  return { ok: true, message: `Inserted ${field} of "${cred.name}" into ${target}. Do not read it back; continue the login.` };
}

/* ---------------------------------------------------------------- requests */

export function createCredentialRequest(input: { agentId: string; service: string; site: string; loginUrl?: string; reason: string; required?: string; executionScopeId?: string; capabilityRequestId?: string }): CredentialRequest {
  const agent = readDb().agents.find((a) => a.id === input.agentId);
  if (!agent) throw new Error("Agent not found.");
  if (!input.service.trim() || !input.site.trim()) throw new Error("service and site are required.");
  const ts = now();
  const rec: CredentialRequest = {
    id: newId(), requesterAgentId: agent.id, requesterName: agent.name, service: input.service.trim().slice(0, 80), site: input.site.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").slice(0, 200),
    loginUrl: input.loginUrl?.trim().slice(0, 500) || undefined, reason: input.reason.trim().slice(0, 1_000), required: input.required?.trim().slice(0, 120) || "Username / Password",
    status: "WAITING", executionScopeId: input.executionScopeId, capabilityRequestId: input.capabilityRequestId, createdAt: ts, updatedAt: ts,
  };
  // the request is persisted first: the agent can only ever wait for something that exists
  insertCredentialRequest(rec);
  setAgentWaiting(agent.id, { kind: "credential", requestId: rec.id, label: `${rec.service} (${rec.site})` });
  addCredentialActivity("required", `Credential required: ${rec.service} (${rec.site}) — requested by ${agent.name}`, { requestId: rec.id, agentId: agent.id });
  console.log(`[credentials] request #${short(rec.id)} ${rec.service} ${rec.site} by ${agent.name}`);
  return rec;
}

/** Owner saved a credential for a request → RESOLVED → requester resumes automatically. */
export async function resolveCredentialRequest(id: string, credentialId: string): Promise<CredentialRequest> {
  const req = getCredentialRequest(id);
  if (!req) throw new Error("Credential request not found.");
  if (req.status !== "WAITING") throw new Error(`This request is ${req.status}.`);
  const cred = getLoginCredential(credentialId);
  if (!cred) throw new Error("Credential not found.");
  const updated = patchCredentialRequest(id, { status: "RESOLVED", resolvedCredentialId: credentialId, resolvedAt: now() });
  addCredentialActivity("resolved", `Credential request resolved with "${cred.name}" — ${req.requesterName} resumes`, { requestId: id, credentialId, agentId: req.requesterAgentId });
  await wakeRequester(updated, cred);
  return updated;
}

export function cancelCredentialRequest(id: string): CredentialRequest {
  const req = getCredentialRequest(id);
  if (!req) throw new Error("Credential request not found.");
  if (req.status !== "WAITING") throw new Error(`This request is ${req.status}.`);
  const updated = patchCredentialRequest(id, { status: "CANCELLED" });
  clearAgentWaiting(req.requesterAgentId, id);
  void wakeDismissed(updated).catch((err) => console.error("[credentials] dismissal resume failed:", err));
  return updated;
}

/** No login is coming. The agent has to hear that, not sit on it. */
async function wakeDismissed(req: CredentialRequest): Promise<void> {
  const text = renderPrompt("credential-dismissed-resume", { short_id: short(req.id), service: req.service, site: req.site });
  patchCredentialRequest(req.id, { resumedAt: now() });
  const { onCredentialResolved } = await import("@/lib/capabilities/manager");
  if (req.capabilityRequestId && (await onCredentialResolved(req.capabilityRequestId, text))) return;
  const { sendAgentMessage } = await import("@/lib/runtime");
  await sendAgentMessage(req.requesterAgentId, text, { origin: "system", scopeId: req.executionScopeId });
}

async function wakeRequester(req: CredentialRequest, cred: LoginCredential): Promise<void> {
  const text = renderPrompt("credential-resolved-resume", { short_id: short(req.id), service: req.service, site: req.site, credential_name: cred.name, credential_service: cred.service, credential_site: cred.site });
  clearAgentWaiting(req.requesterAgentId, req.id);
  patchCredentialRequest(req.id, { resumedAt: now() });
  const { onCredentialResolved } = await import("@/lib/capabilities/manager");
  if (req.capabilityRequestId && (await onCredentialResolved(req.capabilityRequestId, text))) return;
  const { sendAgentMessage } = await import("@/lib/runtime");
  void sendAgentMessage(req.requesterAgentId, text, { origin: "system", scopeId: req.executionScopeId }).catch((err) => console.error("[credentials] resume failed:", err));
}

export function waitingRequests(): CredentialRequest[] {
  return listCredentialRequests().filter((r) => r.status === "WAITING");
}
