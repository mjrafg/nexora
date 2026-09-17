/** Browser handoff — see ./handoff.ts. */
export type BrowserHandoffMode = "VIEW" | "INTERACTIVE";
export type BrowserHandoffStatus = "OPEN" | "RETURNED" | "CANCELLED";

export type BrowserHandoff = {
  id: string;
  agentId: string;
  agentName: string;
  /** the agent's own browser session key — never a new one */
  sessionKey: string;
  mode: BrowserHandoffMode;
  /** what the owner is being asked to look at or do */
  reason: string;
  status: BrowserHandoffStatus;
  /** scope the agent was working in, so the resume continues it */
  executionScopeId?: string;
  capabilityRequestId?: string;
  createdAt: string;
  updatedAt: string;
  returnedAt?: string;
  resumedAt?: string;
  ownerNote?: string;
};
