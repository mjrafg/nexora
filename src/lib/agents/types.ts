/** One reversible choice an agent made instead of interrupting the owner. */
export type AgentAssumption = {
  id: string;
  agentId: string;
  agentName: string;
  /** execution scope = the task it belongs to */
  scopeId?: string;
  summary: string;
  detail?: string;
  /** the Custom Data entry that now holds the value, when one was stored */
  customDataKey?: string;
  createdAt: string;
};
