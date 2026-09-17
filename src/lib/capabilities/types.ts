/* ------------------------------------------------------------------
   Capability Manager — types.

   A capability request is the unit of work: any agent asks for a capability,
   the Capability Manager (a normal Nexora agent with special tools) resolves
   it, and the requester resumes automatically. States are deliberately few.
   ------------------------------------------------------------------ */

export type CapabilityRequestStatus =
  | "PENDING"
  | "RESEARCHING"
  | "INSTALLING"
  | "TESTING"
  | "RESOLVED"
  | "WAITING_FOR_PAYMENT"
  | "FAILED";

export const OPEN_REQUEST_STATES: CapabilityRequestStatus[] = ["PENDING", "RESEARCHING", "INSTALLING", "TESTING"];

export type PaymentApproval = {
  product: string;
  cost: string;
  billing: string;
  why: string;
  alternatives: string;
  recommendation: string;
  requestedAt: string;
  /** linked Payments request (new flow) — decisions are made in Payments and mirrored here */
  paymentRequestId?: string;
  decision?: "approved" | "rejected";
  decidedAt?: string;
  ownerNote?: string;
};

export type CapabilityRequest = {
  id: string;
  requesterAgentId: string;
  requesterName: string;
  capability: string;
  reason: string;
  context: string;
  status: CapabilityRequestStatus;
  /** what the Capability Manager is doing right now (one line) */
  note?: string;
  resolution?: { summary: string; granted: string[] };
  payment?: PaymentApproval;
  error?: string;
  /** requester's execution scope at request time — the resume continues it, so completed side effects stay deduplicated */
  executionScopeId?: string;
  /** Capability Manager turns spent on this request */
  turns: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resumedAt?: string;
};

export type CapabilityActivityKind =
  | "requested"
  | "existing_found"
  | "research_started"
  | "browser_started"
  | "candidate_selected"
  | "mcp_installed"
  | "connection_tested"
  | "tools_discovered"
  | "grant_created"
  | "credential_stored"
  | "payment_requested"
  | "payment_decided"
  | "resolved"
  | "failed"
  | "agent_resumed"
  | "note";

export type CapabilityActivity = {
  id: string;
  requestId: string | null;
  ts: number;
  kind: CapabilityActivityKind;
  text: string;
  detail?: string | null;
};

/** A capability the company explicitly registered (the computed registry adds native + MCP-derived ones). */
export type CapabilityRecord = {
  id: string;
  name: string;
  description: string;
  status: "available" | "unavailable";
  /** e.g. "Cloudflare MCP", "Native Browser" */
  provider: string;
  kind: "native" | "mcp" | "cli" | "integration";
  serverId?: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type CapabilityView = {
  id: string;
  name: string;
  description: string;
  status: "available" | "unavailable";
  provider: string;
  kind: CapabilityRecord["kind"];
  serverId?: string | null;
  toolCount?: number;
  tools?: string[];
  tags: string[];
  /** true when the entry came from an explicit CapabilityRecord */
  registered: boolean;
};

export type CapabilityManagerOverview = {
  agentId: string;
  name: string;
  role: string;
  working: boolean;
  currentTask: string | null;
  activeRequests: number;
  waitingForPayment: number;
  capabilitiesAdded: number;
  capabilitiesAvailable: number;
  mcpServersConnected: number;
  mcpServersTotal: number;
};
