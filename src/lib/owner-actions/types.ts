/* ------------------------------------------------------------------
   Owner actions — the single place the owner looks to answer
   "does anything need me right now?".

   This is a coordination layer, not a new source of truth. A payment
   still lives in Payments, a login request in Credentials, a capability
   in Capabilities, company information in the Company Profile. Those
   records are PROJECTED into owner actions so the owner sees one list;
   resolving here resolves the authoritative record.

   Kinds that have no other home — a field an agent needs, a decision,
   a human step in the browser, more turns for a long task — are stored
   here natively.
   ------------------------------------------------------------------ */

export type OwnerActionKind =
  | "data"
  | "approval"
  | "payment"
  | "credential"
  | "capability"
  | "browser"
  | "captcha"
  | "otp"
  | "signature"
  | "turn_budget"
  | "decision"
  | "other";

export type OwnerActionStatus = "OPEN" | "RESOLVED" | "CANCELLED";

/** Which authoritative record this action stands for, when it is a projection. */
export type OwnerActionSourceType = "native" | "credential" | "payment" | "capability" | "company" | "browser_handoff";

export type OwnerFieldType = "text" | "number" | "date" | "boolean" | "email" | "phone" | "url" | "select" | "multi_select" | "json" | "textarea";

export type OwnerField = {
  /** where the answer belongs if the owner keeps it: a Company Profile field key or a Custom Data key */
  key: string;
  label: string;
  type: OwnerFieldType;
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: string[];
  /** offer "save for future" — off for one-off or sensitive answers */
  saveForFuture?: boolean;
};

export type OwnerChoice = { value: string; label: string; style?: "primary" | "danger" | "ghost"; note?: string };

export type OwnerActionPayload = {
  /** kind "data" */
  fields?: OwnerField[];
  /** kind "approval" / "decision" */
  choices?: OwnerChoice[];
  /** free-form, non-secret detail rendered as a definition list */
  details?: { label: string; value: string }[];
  /** kind "turn_budget" */
  turns?: { used: number; limit: number; grant: number; step?: string };
  /** where the owner can see the underlying record */
  href?: string;
};

export type OwnerActionNotification = {
  state: "pending" | "sent" | "suppressed" | "failed";
  sentAt?: string;
  count: number;
  /** content hash, so an unchanged action is never re-announced */
  hash?: string;
};

export type OwnerActionResolution = {
  by: "owner" | "system";
  /** the choice the owner made, or "submitted" for a data form */
  choice?: string;
  note?: string;
  at: string;
};

export type OwnerAction = {
  id: string;
  kind: OwnerActionKind;
  agentId: string;
  agentName: string;
  /** the execution scope of the task that is blocked — the resume continues it */
  taskId?: string;
  /** browser session key when the action needs the agent's live page */
  sessionId?: string;
  title: string;
  reason: string;
  status: OwnerActionStatus;
  /** true when the agent genuinely cannot make progress without the owner */
  blocking: boolean;
  createdAt: string;
  updatedAt: string;
  viewedAt?: string;
  resolvedAt?: string;
  sourceRequestType: OwnerActionSourceType;
  sourceRequestId?: string;
  browserSessionId?: string;
  notification: OwnerActionNotification;
  payload: OwnerActionPayload;
  resolution?: OwnerActionResolution;
  capabilityRequestId?: string;
};

/** Per-projection owner state (viewed, notified) — projections have no row of their own. */
export type OwnerActionMeta = {
  id: string;
  viewedAt?: string;
  notification: OwnerActionNotification;
  updatedAt: string;
};

export type OwnerNotification = {
  id: string;
  actionId: string;
  title: string;
  body: string;
  href: string;
  urgency: "normal" | "high";
  state: "unread" | "read";
  /** one row per action-content, so the same unchanged action never notifies twice */
  dedupeKey: string;
  delivery: { inApp: true; push?: "sent" | "failed" | "skipped"; error?: string };
  createdAt: string;
  readAt?: string;
};
