/* ------------------------------------------------------------------
   Minimal file-backed store for Phase 1.

   data/nexora.json   agents, runtime configs, provider connections,
                      conversations, messages
   data/secrets.json  API keys (0600, gitignored) — referenced by id only
   ------------------------------------------------------------------ */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentRecord,
  ChatMessage,
  Conversation,
  ProviderConnection,
  RuntimeConfig,
} from "@/lib/runtime/types";
import type { McpServerRecord, McpToolRecord, ToolPolicy } from "@/lib/mcp/types";
import type { CredentialRow } from "@/lib/mcp/store";
import type { MilestoneRecord, ProjectActivity, ProjectMessage, ProjectRecord, SessionRecord } from "@/lib/projects/types";
import type { CapabilityActivity, CapabilityRecord, CapabilityRequest } from "@/lib/capabilities/types";
import type { PaymentAuthorization, PaymentMethod, PaymentRequest, PaymentSettings, PaymentTransaction } from "@/lib/payments/types";
import type { CredentialActivity, CredentialRequest, LoginCredential } from "@/lib/credentials/types";
import type { CompanyActivity, CompanyInfoRequest, CompanyProfile, CustomDatum } from "@/lib/company/types";
import type { BrowserHandoff } from "@/lib/browser/types";
import type { AgentWaiting, WaitingKind } from "@/lib/agents/waiting";
import type { AgentAssumption } from "@/lib/agents/types";
import type { OwnerAction, OwnerActionMeta, OwnerNotification } from "@/lib/owner-actions/types";
import type { ChatCompaction, ChatThread } from "@/lib/chats/types";
import type { PromptOverride, PromptRevision } from "@/lib/prompts/types";
import type { SkillSetting } from "@/lib/skills/types";
import type { SkillDeliveryRecord } from "@/lib/skills/deliveries";
import type { TaskEvent, TaskRecord } from "@/lib/tasks/types";
import { DEFAULT_RUNTIME, PROVIDERS } from "@/lib/runtime/catalog";
import { agents as mockAgents, departments } from "@/lib/mock-data";

export type Database = {
  version: 1;
  agents: AgentRecord[];
  runtimeConfigs: RuntimeConfig[];
  providerConnections: ProviderConnection[];
  conversations: Conversation[];
  /** conversation threads: an agent can hold several separate chats */
  chats: ChatThread[];
  messages: ChatMessage[];
  chatCompactions: ChatCompaction[];
  /** the owner's replacements for built-in prompts; absent means "use the built-in" */
  promptOverrides: PromptOverride[];
  promptRevisions: PromptRevision[];
  /** the owner's availability switch per imported skill; absent means the shipped default */
  skillSettings: SkillSetting[];
  /** what was actually delivered to a model, per execution scope */
  skillDeliveries: SkillDeliveryRecord[];
  /** context windows providers actually reported, keyed "<runtimeType>:<model>" */
  modelWindows: Record<string, number>;
  credentials: CredentialRow[];
  mcpServers: McpServerRecord[];
  mcpTools: McpToolRecord[];
  projects: ProjectRecord[];
  projectMilestones: MilestoneRecord[];
  projectSessions: SessionRecord[];
  projectActivity: ProjectActivity[];
  projectMessages: ProjectMessage[];
  capabilityRequests: CapabilityRequest[];
  capabilities: CapabilityRecord[];
  capabilityActivity: CapabilityActivity[];
  toolPolicies: ToolPolicy[];
  paymentMethods: PaymentMethod[];
  paymentRequests: PaymentRequest[];
  paymentAuthorizations: PaymentAuthorization[];
  paymentTransactions: PaymentTransaction[];
  paymentSettings: PaymentSettings;
  loginCredentials: LoginCredential[];
  credentialRequests: CredentialRequest[];
  credentialActivity: CredentialActivity[];
  /** ids of one-off data migrations already applied */
  migrations?: string[];
  browserHandoffs: BrowserHandoff[];
  companyCustomData: CustomDatum[];
  agentAssumptions: AgentAssumption[];
  /** company work: general tasks, never Tandem project sessions */
  tasks: TaskRecord[];
  taskEvents: TaskEvent[];
  ownerActions: OwnerAction[];
  ownerActionMeta: OwnerActionMeta[];
  ownerNotifications: OwnerNotification[];
  /** extra turns the owner granted to a specific task */
  turnGrants: { agentId: string; scopeId: string; extra: number; grantedAt: string }[];
  companyProfile: CompanyProfile;
  companyInfoRequests: CompanyInfoRequest[];
  companyActivity: CompanyActivity[];
};

export const DEFAULT_COMPANY_PROFILE: CompanyProfile = {
  id: "company", name: "", address: {}, billingSameAsCompany: true, billingAddress: {}, legal: {}, contacts: [],
  createdAt: "1970-01-01T00:00:00.000Z", updatedAt: "1970-01-01T00:00:00.000Z",
};

export const DEFAULT_PAYMENT_SETTINGS: PaymentSettings = { autoApproveLimit: 0, currency: "USD", defaultPaymentMethodId: null, updatedAt: "1970-01-01T00:00:00.000Z" };

const DATA_DIR = process.env.NEXORA_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "nexora.json");
const SECRETS_FILE = path.join(DATA_DIR, "secrets.json");

export const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");
export { DATA_DIR };

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function atomicWrite(file: string, content: string, mode?: number) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

/* ---------- seed ---------- */

const DEFAULT_CONNECTIONS: Array<Pick<ProviderConnection, "id" | "name" | "providerType">> = [
  { id: "conn-anthropic", name: "Main Anthropic", providerType: "anthropic" },
  { id: "conn-openai", name: "OpenAI Production", providerType: "openai" },
  { id: "conn-openrouter", name: "OpenRouter", providerType: "openrouter" },
];

const DEPT_SKILLS: Record<string, string[]> = {
  ceo: ["strategy", "okr-planning", "decision-memos"],
  operations: ["process-design", "vendor-management", "compliance"],
  engineering: ["typescript", "system-design", "code-review"],
  sales: ["discovery-calls", "proposal-writing", "negotiation"],
  support: ["ticket-triage", "customer-communication", "help-center"],
  finance: ["financial-modeling", "reconciliation", "pricing-analysis"],
  conference: [],
};

const DEPT_TOOLS: Record<string, string[]> = {
  ceo: ["web_search", "web_fetch", "read_files"],
  operations: ["web_search", "read_files", "write_files"],
  engineering: ["read_files", "write_files", "run_commands", "web_search"],
  sales: ["web_search", "web_fetch", "crm"],
  support: ["read_files", "crm"],
  finance: ["read_files", "write_files", "web_search"],
  conference: [],
};

export function defaultInstructions(name: string, role: string, deptName: string) {
  return `You are ${name}, the ${role} at Nexora, an AI-native company where every department is run by AI agents and the human founder approves what matters.

You work in the ${deptName} department. Be concise, practical, and specific. When you propose an action that needs the founder's approval (spending, contracts, deployments, hiring), say so explicitly.`;
}

function seed(): Database {
  const ts = now();
  const providerConnections: ProviderConnection[] = DEFAULT_CONNECTIONS.map((c) => ({
    ...c,
    auth: { kind: "env", variable: PROVIDERS[c.providerType].envVar! },
    baseUrl: PROVIDERS[c.providerType].defaultBaseUrl,
    status: "unknown",
    createdAt: ts,
    updatedAt: ts,
  }));

  const runtimeConfigs: RuntimeConfig[] = [];
  const agents: AgentRecord[] = mockAgents.map((a) => {
    const rc: RuntimeConfig = {
      id: `rc-${a.id}`,
      runtimeType: DEFAULT_RUNTIME.runtimeType,
      providerConnectionId: "conn-anthropic",
      model: DEFAULT_RUNTIME.model,
      advancedSettings: {},
    };
    runtimeConfigs.push(rc);
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      dept: a.dept,
      instructions: defaultInstructions(a.name, a.role, departments[a.dept].name),
      skills: DEPT_SKILLS[a.dept] ?? [],
      toolPermissions: DEPT_TOOLS[a.dept] ?? [],
      runtimeConfigId: rc.id,
      mcpGrants: [],
      status: a.status,
      createdAt: ts,
      updatedAt: ts,
    };
  });

  return { version: 1, agents, runtimeConfigs, providerConnections, conversations: [], chats: [], messages: [], chatCompactions: [], promptOverrides: [], promptRevisions: [], skillSettings: [], skillDeliveries: [], modelWindows: {}, credentials: [], mcpServers: [], mcpTools: [], projects: [], projectMilestones: [], projectSessions: [], projectActivity: [], projectMessages: [], capabilityRequests: [], capabilities: [], capabilityActivity: [], toolPolicies: [], paymentMethods: [], paymentRequests: [], paymentAuthorizations: [], paymentTransactions: [], paymentSettings: { ...DEFAULT_PAYMENT_SETTINGS }, loginCredentials: [], credentialRequests: [], credentialActivity: [], browserHandoffs: [], companyCustomData: [], agentAssumptions: [], tasks: [], taskEvents: [], ownerActions: [], ownerActionMeta: [], ownerNotifications: [], turnGrants: [], companyProfile: { ...DEFAULT_COMPANY_PROFILE }, companyInfoRequests: [], companyActivity: [] };
}

/**
 * `waitingFor` used to be { requestId: "credential:<id>", capability: "<free text>" }:
 * the surface that owned the request was only implied by a string prefix, and
 * the UI called every one of them a "capability". Convert those rows to the
 * typed reference so they resolve (and can be repaired) like any other.
 */
function migrateWaitingFor(db: Database) {
  for (const a of db.agents) {
    const w = a.waitingFor as (AgentWaiting & { capability?: string }) | null | undefined;
    if (!w || w.kind) continue;
    const raw = String(w.requestId ?? "");
    const i = raw.indexOf(":");
    const prefix = i > 0 ? raw.slice(0, i) : "capability";
    const id = i > 0 ? raw.slice(i + 1) : raw;
    const kind = (["credential", "company", "payment", "browser"].includes(prefix) ? prefix : "capability") as WaitingKind;
    const label = String(w.capability ?? "")
      .replace(/^credential for /i, "")
      .replace(/^company information: /i, "")
      .trim();
    a.waitingFor = { kind, requestId: id, label: label || "(unspecified)", since: a.updatedAt ?? new Date().toISOString() };
  }
}

/** One-off data migrations, each applied at most once (recorded in db.migrations). */
function applyMigrations(db: Database) {
  db.migrations ??= [];
  const done = new Set(db.migrations);
  let dirty = false;
  // the CEO reads the canonical company profile (spec: Company Profile §24)
  if (!done.has("ceo-company-profile")) {
    for (const a of db.agents) if (a.dept === "ceo" && !a.toolPermissions.includes("company_profile")) { a.toolPermissions.push("company_profile"); dirty = true; }
    db.migrations.push("ceo-company-profile");
    dirty = true;
  }
  // conversations became threads: every agent that already had a transcript
  // keeps it, in one thread, with its provider session and execution scope.
  // Rows belonging to agents that no longer exist are dropped rather than
  // projected: deleting an agent already removes its messages, so these are
  // leftovers no surface can ever reach.
  if (!done.has("chat-threads-v1")) {
    const ts = now();
    const alive = new Set(db.agents.map((a) => a.id));
    const before = db.messages.length + db.conversations.length;
    db.messages = db.messages.filter((m) => alive.has(m.agentId));
    db.conversations = db.conversations.filter((c) => alive.has(c.agentId));
    if (db.messages.length + db.conversations.length !== before) dirty = true;
    const byAgent = new Map<string, string>();
    const ensure = (agentId: string): string => {
      let id = byAgent.get(agentId);
      if (id) return id;
      const existing = db.chats.find((c) => c.agentId === agentId);
      id = existing?.id ?? randomUUID();
      if (!existing) {
        const first = db.messages.find((m) => m.agentId === agentId)?.createdAt ?? ts;
        db.chats.push({ id, agentId, title: "Conversation", autoTitle: false, createdAt: first, updatedAt: ts, archivedAt: null });
      }
      byAgent.set(agentId, id);
      return id;
    };
    for (const m of db.messages) if (!m.chatId) { m.chatId = ensure(m.agentId); dirty = true; }
    for (const c of db.conversations) if (!c.chatId) { c.chatId = ensure(c.agentId); dirty = true; }
    db.migrations.push("chat-threads-v1");
    dirty = true;
  }
  // self-heal for stores migrated before the projection skipped deleted agents
  if (!done.has("chat-threads-orphans")) {
    const alive = new Set(db.agents.map((a) => a.id));
    const kept = db.chats.filter((c) => alive.has(c.agentId));
    if (kept.length !== db.chats.length) {
      const gone = new Set(db.chats.filter((c) => !alive.has(c.agentId)).map((c) => c.id));
      db.chats = kept;
      db.messages = db.messages.filter((m) => !gone.has(m.chatId));
      db.conversations = db.conversations.filter((c) => !gone.has(c.chatId));
      db.chatCompactions = db.chatCompactions.filter((c) => !gone.has(c.chatId));
    }
    db.migrations.push("chat-threads-orphans");
    dirty = true;
  }
  if (dirty) writeDb(db);
}

/* ---------- read / write ---------- */

export function readDb(): Database {
  if (!fs.existsSync(DB_FILE)) {
    const db = seed();
    writeDb(db);
    return db;
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")) as Database;
  // forward-compat: fill collections/fields added after the file was first written
  db.credentials ??= [];
  db.chats ??= [];
  db.chatCompactions ??= [];
  db.promptOverrides ??= [];
  db.promptRevisions ??= [];
  db.skillSettings ??= [];
  db.skillDeliveries ??= [];
  db.modelWindows ??= {};
  db.mcpServers ??= [];
  db.mcpTools ??= [];
  db.projects ??= [];
  db.projectMilestones ??= [];
  db.projectSessions ??= [];
  db.projectActivity ??= [];
  db.projectMessages ??= [];
  db.capabilityRequests ??= [];
  db.capabilities ??= [];
  db.capabilityActivity ??= [];
  db.toolPolicies ??= [];
  db.paymentMethods ??= [];
  for (const m of db.paymentMethods) { m.description ??= ""; m.status ??= "AVAILABLE"; m.createdBy ??= "owner"; m.useCount ??= 0; }
  db.paymentRequests ??= [];
  db.paymentAuthorizations ??= [];
  db.paymentTransactions ??= [];
  db.paymentSettings ??= { ...DEFAULT_PAYMENT_SETTINGS };
  db.loginCredentials ??= [];
  db.credentialRequests ??= [];
  db.credentialActivity ??= [];
  db.browserHandoffs ??= [];
  migrateWaitingFor(db);
  db.companyCustomData ??= [];
  db.agentAssumptions ??= [];
  db.tasks ??= [];
  db.taskEvents ??= [];
  db.ownerActions ??= [];
  db.ownerActionMeta ??= [];
  db.ownerNotifications ??= [];
  db.turnGrants ??= [];
  db.companyProfile ??= { ...DEFAULT_COMPANY_PROFILE };
  for (const c of db.companyProfile.contacts ?? []) c.createdBy ??= "owner";
  db.companyInfoRequests ??= [];
  // `target` is derived on read for older rows (see company/store.requestTarget)
  db.companyActivity ??= [];
  for (const a of db.agents) a.mcpGrants ??= [];
  applyMigrations(db);
  return db;
}

export function writeDb(db: Database) {
  atomicWrite(DB_FILE, JSON.stringify(db, null, 2));
}

/** Read-modify-write helper. */
export function updateDb<T>(fn: (db: Database) => T): T {
  const db = readDb();
  const out = fn(db);
  writeDb(db);
  return out;
}

/* ---------- secrets ---------- */

type Secrets = Record<string, string>;

function readSecrets(): Secrets {
  if (!fs.existsSync(SECRETS_FILE)) return {};
  return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8")) as Secrets;
}

export function getSecret(id: string): string | null {
  return readSecrets()[id] ?? null;
}

export function putSecret(value: string, id: string = newId()): string {
  const s = readSecrets();
  s[id] = value;
  atomicWrite(SECRETS_FILE, JSON.stringify(s, null, 2), 0o600);
  return id;
}

export function deleteSecret(id: string) {
  const s = readSecrets();
  if (id in s) {
    delete s[id];
    atomicWrite(SECRETS_FILE, JSON.stringify(s, null, 2), 0o600);
  }
}
