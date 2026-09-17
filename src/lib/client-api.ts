"use client";

/* Thin fetch helpers shared by client components. */

import type { ProviderMeta, RuntimeMeta } from "@/lib/runtime/catalog";
import type { AgentView, ChatMessage, ProviderType, RuntimeTestResult, RuntimeType, AdvancedSettings } from "@/lib/runtime/types";
import type { ProviderConnectionView } from "@/lib/providers-view";
import type { DeptId } from "@/lib/mock-data";
import type { ActivityEvent } from "@/lib/activity";
export type { ActivityEvent };
import type { ProjectView, ProjectActivity, ProjectMessage } from "@/lib/projects/types";
import type { CredentialMeta, McpServerConfig, McpServerView, McpTestResult, McpGrant } from "@/lib/mcp/types";
import type { CapabilityActivity, CapabilityManagerOverview, CapabilityRequest, CapabilityView } from "@/lib/capabilities/types";
import type { BrowserSessionInfo } from "@/lib/browser/host";
import type { BrowserActionMeta } from "@/lib/activity";
import type { PaymentMethod, PaymentOverview, PaymentRequest, PaymentSettings, PaymentTransaction } from "@/lib/payments/types";
import type { CompanyActivity, CompanyContact, CompanyInfoRequest, CompanyProfileView } from "@/lib/company/types";
import type { BrowserHandoff } from "@/lib/browser/types";
import type { AgentAssumption } from "@/lib/agents/types";
import type { CustomDatum } from "@/lib/company/types";
import type { OwnerAction, OwnerActionKind, OwnerField, OwnerNotification } from "@/lib/owner-actions/types";
import type { CredentialActivity, CredentialRequest, LoginCredentialView } from "@/lib/credentials/types";
import type { ChatCompaction, ChatContextUsage, ChatThread, CompactOutcome } from "@/lib/chats/types";
import type { ChatSummary } from "@/lib/chats/summary";
import type { ChatLogEntry } from "@/lib/chats/logs";
import type { TaskEvent, TaskLink, TaskPriority, TaskStatus, TaskView, TeamMember } from "@/lib/tasks/types";
import type { ImportPreview, PromptCategory, PromptRevision, PromptView } from "@/lib/prompts/types";
import type { DirEntry, DirListing } from "@/lib/fs-browse";
import type { SkillView } from "@/lib/skills/types";
import type { SkillDeliveryRecord } from "@/lib/skills/deliveries";
export type { TaskEvent, TaskLink, TaskPriority, TaskStatus, TaskView, TeamMember, DirEntry, DirListing, ImportPreview, PromptCategory, PromptRevision, PromptView, SkillView, SkillDeliveryRecord };

/** A delivery with the ids resolved into names the owner can read. */
export type SkillDeliveryShown = SkillDeliveryRecord & { where: string; agentName: string; skillName: string };
export type SkillCounts = { all: number; available: number; adapted: number; tokens: number };
export type SkillSourceMeta = { repo: string; url: string; revision: string; importedAt: string; license: string };

export type PromptCounts = { all: number; customized: number; updateAvailable: number; categories: number };
export type { ChatCompaction, ChatContextUsage, ChatThread, CompactOutcome, ChatSummary, ChatLogEntry };
export type { CredentialActivity, CredentialRequest, LoginCredentialView };
export type { PaymentMethod, PaymentOverview, PaymentRequest, PaymentSettings, PaymentTransaction };
export type { CompanyActivity, CompanyContact, CompanyInfoRequest, CompanyProfileView };
export type { BrowserHandoff, AgentAssumption, CustomDatum, OwnerAction, OwnerActionKind, OwnerField, OwnerNotification };
export type { CapabilityActivity, CapabilityManagerOverview, CapabilityRequest, CapabilityView, BrowserSessionInfo, BrowserActionMeta };

export type BrowserLabResult = { ok: boolean; text: string; report?: BrowserActionMeta; durationMs: number; session: string };

export type Catalog = {
  runtimes: RuntimeMeta[];
  providers: Record<ProviderType, ProviderMeta>;
  connections: ProviderConnectionView[];
  tools: { id: string; label: string; description: string }[];
  departments: { id: DeptId; name: string; color: string }[];
  defaults: { runtimeType: RuntimeType; providerType: ProviderType; model: string; codexModel?: string };
};

export type RuntimeDraft = {
  runtimeType: RuntimeType;
  providerConnectionId: string;
  model: string;
  advancedSettings: AdvancedSettings;
};

export class ApiError extends Error {
  constructor(message: string, public detail?: string, public status?: number) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string } & T;
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, body.detail, res.status);
  return body;
}

export const api = {
  catalog: () => call<Catalog>("/api/catalog"),
  prompts: () => call<{ prompts: PromptView[]; counts: PromptCounts; categories: { id: PromptCategory; label: string; count: number }[] }>("/api/prompts"),
  prompt: (id: string) => call<{ prompt: PromptView; revisions: PromptRevision[] }>(`/api/prompts/${id}`),
  savePrompt: (id: string, body: { content?: string; reset?: boolean; revisionId?: string }) =>
    call<{ prompt: PromptView; revisions: PromptRevision[] }>(`/api/prompts/${id}`, { method: "POST", body: JSON.stringify(body) }),
  previewPromptImport: (file: unknown) =>
    call<{ preview: ImportPreview; suggested: string[] }>("/api/prompts/import", { method: "POST", body: JSON.stringify({ file }) }),
  applyPromptImport: (file: unknown, apply: string[]) =>
    call<{ preview: ImportPreview; result: { applied: string[]; skipped: { id: string; reason: string }[] } }>("/api/prompts/import", { method: "POST", body: JSON.stringify({ file, apply }) }),
  stopProjectSession: (projectId: string, key: string) =>
    call<{ ok: true }>(`/api/projects/${projectId}/sessions/${encodeURIComponent(key)}/stop`, { method: "POST" }),
  skills: () => call<{ skills: SkillView[]; source: SkillSourceMeta; counts: SkillCounts; deliveries: SkillDeliveryShown[] }>("/api/skills"),
  skill: (id: string) => call<{ skill: SkillView; delivered: string; license: string }>(`/api/skills/${id}`),
  setSkillEnabled: (id: string, enabled: boolean) => call<{ skill: SkillView }>(`/api/skills/${id}`, { method: "POST", body: JSON.stringify({ enabled }) }),
  agents: () => call<{ agents: AgentView[] }>("/api/agents"),
  agent: (id: string) => call<{ agent: AgentView }>(`/api/agents/${id}`),
  hire: (body: unknown) => call<{ agent: AgentView }>("/api/agents", { method: "POST", body: JSON.stringify(body) }),
  updateAgent: (id: string, body: unknown) => call<{ agent: AgentView }>(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteAgent: (id: string) => call<{ ok: true }>(`/api/agents/${id}`, { method: "DELETE" }),
  messages: (id: string, chatId?: string) =>
    call<{ chat: ChatThread; messages: ChatMessage[]; usage: ChatContextUsage | null }>(`/api/agents/${id}/messages${chatId ? `?chat=${chatId}` : ""}`),
  send: (id: string, message: string, chatId?: string) =>
    call<{ user: ChatMessage; assistant: ChatMessage; usage: ChatContextUsage | null }>(`/api/agents/${id}/messages`, { method: "POST", body: JSON.stringify({ message, chatId }) }),

  /* ---- conversation threads ---- */
  chats: (id: string, includeArchived = false) =>
    call<{ chats: ChatSummary[] }>(`/api/agents/${id}/chats${includeArchived ? "?archived=1" : ""}`),
  newChat: (id: string, title?: string) =>
    call<{ chat: ChatThread }>(`/api/agents/${id}/chats`, { method: "POST", body: JSON.stringify({ title }) }),
  chat: (id: string, chatId: string) =>
    call<{ chat: ChatThread; messages: ChatMessage[]; usage: ChatContextUsage | null; compactions: ChatCompaction[] }>(`/api/agents/${id}/chats/${chatId}`),
  updateChat: (id: string, chatId: string, body: { title?: string; archived?: boolean }) =>
    call<{ chat: ChatThread }>(`/api/agents/${id}/chats/${chatId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteChat: (id: string, chatId: string) => call<{ ok: boolean }>(`/api/agents/${id}/chats/${chatId}`, { method: "DELETE" }),
  compactChat: (id: string, chatId: string) =>
    call<{ outcome: CompactOutcome; usage: ChatContextUsage | null }>(`/api/agents/${id}/chats/${chatId}/compact`, { method: "POST" }),
  chatLogs: (id: string, chatId: string) => call<{ chat: ChatThread; entries: ChatLogEntry[] }>(`/api/agents/${id}/chats/${chatId}/logs`),
  exportUrl: (id: string, chatId: string, format: "markdown" | "json" | "html") =>
    `/api/agents/${id}/chats/${chatId}/export?format=${format}`,

  /* ---- company work ---- */
  tasks: (q: { status?: string; agent?: string; manager?: string } = {}) => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    return call<{ tasks: TaskView[]; workload: TeamMember[] }>(`/api/tasks${p.toString() ? `?${p}` : ""}`);
  },
  task: (id: string) => call<{ task: TaskView; history: TaskEvent[] }>(`/api/tasks/${id}`),
  browseFolder: (path?: string) => call<{ listing?: DirListing; quickLinks?: DirEntry[] }>(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  createFolder: (parent: string, name: string) => call<{ created: DirEntry }>("/api/fs", { method: "POST", body: JSON.stringify({ parent, name }) }),
  createTask: (body: { title: string; description: string; priority?: TaskPriority; assignedToAgentId?: string | null; workingDirectory?: string | null }) =>
    call<{ task: TaskView }>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  updateTask: (id: string, body: Record<string, unknown>) =>
    call<{ task: TaskView; history: TaskEvent[] }>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  /* ---- stopping a running turn ---- */
  stopAgent: (id: string) => call<{ stopped: boolean; chatId?: string }>(`/api/agents/${id}/stop`, { method: "POST" }),
  runState: (id: string) => call<{ running: boolean; chatId: string | null; startedAt: string | null; stopped: boolean }>(`/api/agents/${id}/stop`),
  testAgent: (id: string) => call<RuntimeTestResult>(`/api/agents/${id}/test`, { method: "POST" }),
  testRuntime: (draft: RuntimeDraft) => call<RuntimeTestResult>("/api/runtime/test", { method: "POST", body: JSON.stringify(draft) }),
  providers: () => call<{ connections: ProviderConnectionView[] }>("/api/providers"),
  createProvider: (body: unknown) => call<{ connection: ProviderConnectionView }>("/api/providers", { method: "POST", body: JSON.stringify(body) }),
  updateProvider: (id: string, body: unknown) =>
    call<{ connection: ProviderConnectionView }>(`/api/providers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProvider: (id: string) => call<{ ok: true }>(`/api/providers/${id}`, { method: "DELETE" }),
  testProvider: (id: string, model?: string) =>
    call<RuntimeTestResult>(`/api/providers/${id}/test`, { method: "POST", body: JSON.stringify({ model }) }),

  // credentials
  credentials: () => call<{ credentials: CredentialMeta[] }>("/api/credentials"),
  createCredential: (name: string, values: Record<string, string>) =>
    call<{ credential: CredentialMeta }>("/api/credentials", { method: "POST", body: JSON.stringify({ name, values }) }),
  updateCredential: (id: string, body: { name?: string; values?: Record<string, string> }) =>
    call<{ credential: CredentialMeta }>(`/api/credentials/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteCredential: (id: string) => call<{ ok: true }>(`/api/credentials/${id}`, { method: "DELETE" }),

  // mcp servers
  mcpServers: () => call<{ servers: McpServerView[] }>("/api/mcp-servers"),
  createMcpServer: (body: { name: string; config: McpServerConfig; credentialId?: string | null }) =>
    call<{ server: McpServerView; discovery?: McpTestResult }>("/api/mcp-servers", { method: "POST", body: JSON.stringify(body) }),
  updateMcpServer: (id: string, body: { name?: string; config?: McpServerConfig; credentialId?: string | null; enabled?: boolean }) =>
    call<{ server: McpServerView }>(`/api/mcp-servers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteMcpServer: (id: string) => call<{ ok: true }>(`/api/mcp-servers/${id}`, { method: "DELETE" }),
  testMcpServer: (id: string) => call<McpTestResult & { server: McpServerView }>(`/api/mcp-servers/${id}/test`, { method: "POST" }),
  refreshMcpTools: (id: string) => call<McpTestResult & { server: McpServerView }>(`/api/mcp-servers/${id}/refresh-tools`, { method: "POST" }),

  startMcpOAuth: (id: string) => call<{ authorizeUrl: string; state: string }>(`/api/mcp-servers/${id}/oauth/start`, { method: "POST" }),
  disconnectMcpOAuth: (id: string) => call<{ ok: true; server: McpServerView }>(`/api/mcp-servers/${id}/oauth/disconnect`, { method: "POST" }),
  getMcpServer: (id: string) => call<{ server: McpServerView }>(`/api/mcp-servers/${id}`),

  setAgentGrants: (id: string, mcpGrants: McpGrant[]) =>
    call<{ agent: AgentView }>(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify({ mcpGrants }) }),

  // projects (Director engine)
  projects: () => call<{ projects: ProjectView[] }>("/api/projects"),
  createProject: (body: { title: string; rootPath: string; goal: string; directorAgentId: string; builderAgentId: string; reviewerAgentId: string; createDir?: boolean }) =>
    call<{ project: ProjectView }>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  project: (id: string) => call<{ project: ProjectView; activity: ProjectActivity[]; messages: ProjectMessage[] }>(`/api/projects/${id}`),
  deleteProject: (id: string) => call<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE" }),
  projectMessage: (id: string, message: string) => call<{ ok: true }>(`/api/projects/${id}/messages`, { method: "POST", body: JSON.stringify({ message }) }),
  pauseProject: (id: string) => call<{ project: ProjectView }>(`/api/projects/${id}/pause`, { method: "POST" }),
  resumeProject: (id: string) => call<{ project: ProjectView }>(`/api/projects/${id}/resume`, { method: "POST" }),

  // capabilities + Capability Manager
  capabilities: () => call<{ capabilities: CapabilityView[]; overview: CapabilityManagerOverview; requests: CapabilityRequest[]; activity: CapabilityActivity[] }>("/api/capabilities"),
  capabilityRequest: (id: string) => call<{ request: CapabilityRequest; activity: CapabilityActivity[] }>(`/api/capability-requests/${id}`),
  createCapabilityRequest: (body: { agentId: string; capability: string; reason?: string; context?: string }) =>
    call<{ request: CapabilityRequest }>("/api/capability-requests", { method: "POST", body: JSON.stringify(body) }),
  decidePayment: (id: string, decision: "approved" | "rejected", note?: string) =>
    call<{ request: CapabilityRequest }>(`/api/capability-requests/${id}/decide`, { method: "POST", body: JSON.stringify({ decision, note }) }),
  discussRequest: (id: string, message: string) =>
    call<{ reply: string; request: CapabilityRequest }>(`/api/capability-requests/${id}/discuss`, { method: "POST", body: JSON.stringify({ message }) }),

  // payments
  paymentOverview: () => call<{ overview: PaymentOverview; recent: PaymentTransaction[]; pending: PaymentRequest[]; methods: PaymentMethod[] }>("/api/payments/overview"),
  paymentSettings: () => call<{ settings: PaymentSettings; methods: PaymentMethod[] }>("/api/payments/settings"),
  updatePaymentSettings: (body: { autoApproveLimit?: number; defaultPaymentMethodId?: string | null }) => call<{ settings: PaymentSettings }>("/api/payments/settings", { method: "PUT", body: JSON.stringify(body) }),
  paymentMethods: () => call<{ methods: PaymentMethod[]; defaultId: string | null }>("/api/payments/methods"),
  addPaymentMethod: (body: Record<string, unknown>) => call<{ method: PaymentMethod }>("/api/payments/methods", { method: "POST", body: JSON.stringify(body) }),
  updatePaymentMethod: (id: string, body: Record<string, unknown>) => call<{ method: PaymentMethod }>(`/api/payments/methods/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deletePaymentMethod: (id: string) => call<{ ok: true }>(`/api/payments/methods/${id}`, { method: "DELETE" }),
  paymentRequests: () => call<{ requests: PaymentRequest[] }>("/api/payments/requests"),
  createPaymentRequest: (body: { agentId: string; merchant: string; amount: number; reason: string; billingType?: string; interval?: string }) => call<{ request: PaymentRequest }>("/api/payments/requests", { method: "POST", body: JSON.stringify(body) }),
  paymentRequest: (id: string) => call<{ request: PaymentRequest; transaction: PaymentTransaction | null }>(`/api/payments/requests/${id}`),
  approvePayment: (id: string, paymentMethodId: string | null, note?: string) => call<{ request: PaymentRequest }>(`/api/payments/requests/${id}/approve`, { method: "POST", body: JSON.stringify({ paymentMethodId, note }) }),
  rejectPayment: (id: string, note?: string) => call<{ request: PaymentRequest }>(`/api/payments/requests/${id}/reject`, { method: "POST", body: JSON.stringify({ note }) }),
  cancelPayment: (id: string, note?: string) => call<{ request: PaymentRequest }>(`/api/payments/requests/${id}/cancel`, { method: "POST", body: JSON.stringify({ note }) }),
  resolvePaymentException: (id: string, status: "SUCCEEDED" | "FAILED", note?: string) => call<{ request: PaymentRequest }>(`/api/payments/requests/${id}/resolve`, { method: "POST", body: JSON.stringify({ status, note }) }),
  paymentHistory: () => call<{ transactions: PaymentTransaction[] }>("/api/payments/history"),

  // agent browser dock (the agent's own session — never a new browser)
  agentBrowser: (id: string) => call<{ live: boolean; control: "agent" | "owner"; handoff: BrowserHandoff | null; session: string; image?: string; url?: string | null; title?: string | null; viewport?: { width: number; height: number }; error?: string }>(`/api/agents/${id}/browser`),
  agentBrowserAction: (id: string, body: Record<string, unknown>) => call<{ ok: true; handoff?: BrowserHandoff }>(`/api/agents/${id}/browser`, { method: "POST", body: JSON.stringify(body) }),

  // owner action center ("Needs You")
  actionCenter: () => call<{ actions: OwnerAction[]; recent: OwnerAction[]; counts: { total: number; blocking: number }; notifications: OwnerNotification[]; unread: number }>("/api/action-center"),
  ownerAction: (id: string) => call<{ action: OwnerAction }>(`/api/action-center/${encodeURIComponent(id)}`),
  resolveOwnerAction: (id: string, body: Record<string, unknown>) => call<{ action: OwnerAction; counts: { total: number; blocking: number } }>(`/api/action-center/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) }),
  readNotifications: (body: { id?: string; all?: boolean }) => call<{ ok: true; unread: number }>("/api/notifications", { method: "POST", body: JSON.stringify(body) }),

  // company custom data
  customData: () => call<{ data: CustomDatum[]; namespaces: { namespace: string; count: number }[] }>("/api/company/custom-data"),
  addCustomDatum: (body: Record<string, unknown>) => call<{ datum: CustomDatum }>("/api/company/custom-data", { method: "POST", body: JSON.stringify(body) }),
  updateCustomDatum: (id: string, body: Record<string, unknown>) => call<{ datum: CustomDatum }>(`/api/company/custom-data/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteCustomDatum: (id: string) => call<{ ok: true }>(`/api/company/custom-data/${id}`, { method: "DELETE" }),

  // what an agent decided on its own during the task it is working on
  agentAssumptionsForChat: (id: string, chatId: string) => call<{ assumptions: AgentAssumption[] }>(`/api/agents/${id}/assumptions?chat=${chatId}`),
  agentAssumptions: (id: string) => call<{ assumptions: AgentAssumption[] }>(`/api/agents/${id}/assumptions`),

  // company profile
  company: (reveal?: boolean) => call<{ profile: CompanyProfileView; requests: CompanyInfoRequest[]; activity: CompanyActivity[] }>(`/api/company${reveal ? "?reveal=taxId" : ""}`),
  updateCompany: (body: Record<string, unknown>) => call<{ profile: CompanyProfileView; resolved: CompanyInfoRequest[] }>("/api/company", { method: "PATCH", body: JSON.stringify(body) }),
  addCompanyContact: (body: Record<string, unknown>) => call<{ contact: CompanyContact; profile: CompanyProfileView }>("/api/company/contacts", { method: "POST", body: JSON.stringify(body) }),
  updateCompanyContact: (id: string, body: Record<string, unknown>) => call<{ contact: CompanyContact; profile: CompanyProfileView }>(`/api/company/contacts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteCompanyContact: (id: string) => call<{ ok: true; profile: CompanyProfileView }>(`/api/company/contacts/${id}`, { method: "DELETE" }),
  companyRequestAction: (id: string, action: "resolve" | "cancel") => call<{ request: CompanyInfoRequest }>(`/api/company/requests/${id}`, { method: "POST", body: JSON.stringify({ action }) }),

  // credentials (logins)
  logins: () => call<{ credentials: LoginCredentialView[]; requests: CredentialRequest[]; activity: CredentialActivity[] }>("/api/logins"),
  createLogin: (body: Record<string, unknown>) => call<{ credential: LoginCredentialView; request?: CredentialRequest }>("/api/logins", { method: "POST", body: JSON.stringify(body) }),
  updateLogin: (id: string, body: Record<string, unknown>) => call<{ credential: LoginCredentialView }>(`/api/logins/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteLogin: (id: string) => call<{ ok: true }>(`/api/logins/${id}`, { method: "DELETE" }),
  cancelCredentialRequest: (id: string) => call<{ request: CredentialRequest }>(`/api/logins/requests/${id}/cancel`, { method: "POST" }),

  // browser
  browserSessions: () => call<{ sessions: BrowserSessionInfo[] }>("/api/browser/sessions"),
  browserSessionAction: (id: string, action: "cancel" | "release" | "delete") =>
    call<{ ok: true }>("/api/browser/sessions", { method: "POST", body: JSON.stringify({ id, action }) }),
  browserLab: (session: string, tool: string, args: Record<string, unknown>) =>
    call<BrowserLabResult>("/api/browser/lab", { method: "POST", body: JSON.stringify({ session, tool, args }) }),
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.detail ? `${err.message} — ${err.detail}` : err.message;
  return err instanceof Error ? err.message : String(err);
}
