/* ------------------------------------------------------------------
   Credential Manager — types.

   A login credential is metadata (name, service, site, description,
   username) plus a reference to a hidden vault credential that holds the
   password. Agents discover credentials by reasoning over the metadata
   (list_credentials) and ask Nexora to insert values into browser fields;
   they never receive the password.

   MVP security assumption: no technical read-back prevention — agents are
   bound by the behavioural rule "never read an inserted value back". A
   future hardening phase should add secure_fill isolation, protected
   browser elements, secret-aware DOM/screenshot redaction and blocked
   read-back of inserted values.
   ------------------------------------------------------------------ */

export type CredentialType = "username_password" | "api_key" | "token";
export type LoginCredentialStatus = "AVAILABLE" | "DISABLED";

export type LoginCredential = {
  id: string;
  name: string;
  service: string;
  site: string;
  loginUrl?: string;
  description: string;
  username: string;
  type: CredentialType;
  status: LoginCredentialStatus;
  /** hidden vault credential holding PASSWORD (and USERNAME) */
  vaultCredentialId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastUsedBy?: string;
  useCount: number;
};

/** what agents and the UI see — never the secret */
export type LoginCredentialView = Omit<LoginCredential, "vaultCredentialId" | "username"> & { usernameMasked: string; hasPassword: boolean };

export type CredentialRequestStatus = "WAITING" | "RESOLVED" | "CANCELLED";

export type CredentialRequest = {
  id: string;
  requesterAgentId: string;
  requesterName: string;
  service: string;
  site: string;
  loginUrl?: string;
  reason: string;
  required: string;
  status: CredentialRequestStatus;
  resolvedCredentialId?: string;
  /** requester's execution scope — the resume continues it */
  executionScopeId?: string;
  capabilityRequestId?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resumedAt?: string;
};

export type CredentialActivityKind = "created" | "updated" | "used" | "required" | "resolved" | "disabled" | "enabled" | "deleted" | "generated";

export type CredentialActivity = {
  id: string;
  ts: number;
  kind: CredentialActivityKind;
  text: string;
  credentialId?: string;
  agentId?: string;
  requestId?: string;
};
