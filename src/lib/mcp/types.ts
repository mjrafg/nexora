/* ------------------------------------------------------------------
   MCP engine types (independent port/adaptation of Tandem's proven MCP
   implementation — Tandem itself is never modified or depended on).

   Company-level MCP servers + reusable credentials. Agents receive access
   through grants that live on the agent, independent of its AI runtime.
   ------------------------------------------------------------------ */

export type McpTransport = "stdio" | "http";

/** A reusable credential: a named set of one or more secret KEY=value pairs. */
export type CredentialMeta = {
  id: string;
  name: string;
  /** the secret KEYS only — values are never returned by any API */
  keys: string[];
  createdAt: string;
  updatedAt: string;
  /** names of MCP servers currently referencing this credential */
  usedBy: string[];
};

export type McpServerConfig = {
  transport: McpTransport;
  /** stdio */
  command?: string;
  args?: string[];
  /** non-secret env for stdio servers (secrets belong in the attached credential) */
  env?: Record<string, string>;
  /** http */
  url?: string;
  /**
   * non-secret headers for http servers. A value may reference a credential
   * secret with ${KEY}; the engine substitutes it at execution time only.
   */
  headers?: Record<string, string>;
};

export type McpToolRecord = {
  id: string;
  serverId: string;
  /** tool name on the remote server */
  name: string;
  /** globally unique served name: <server slug>__<name> */
  fullName: string;
  description: string;
  inputSchema: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  /** discovery no longer reports this tool (kept so grants are not lost silently) */
  missing?: boolean;
  /** MCP tool annotations as reported by the server (readOnlyHint, destructiveHint…) */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } | null;
  createdAt: string;
};

/** Owner / Capability Manager override of a tool's side-effect class. */
export type ToolPolicy = { fullName: string; class: "READ_ONLY" | "SIDE_EFFECT" | "FINANCIAL"; reason?: string; updatedAt: string };

export type McpOAuthMeta = {
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  resource: string;
  scope: string;
  expiresAt?: number;
  connected: boolean;
};

export type McpServerRecord = {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  config: McpServerConfig;
  credentialId: string | null;
  /** OAuth 2.1 authorization for protected HTTP servers (secrets stored separately). */
  oauth?: McpOAuthMeta;
  /** encrypted {clientSecret?, accessToken, refreshToken} */
  oauthSecretEnc?: string;
  createdAt: string;
  updatedAt: string;
  lastTestAt?: string | null;
  lastTestOk?: boolean | null;
  lastTestError?: string | null;
};

/** How much of a server an agent may use. */
export type McpGrant = {
  serverId: string;
  enabled: boolean;
  /** "all" tools on the server, or an explicit allow-list of tool fullNames */
  tools: "all" | string[];
};

/* ---- views (safe for the UI) ---- */

export type McpServerView = Omit<McpServerRecord, "oauthSecretEnc"> & {
  credentialName: string | null;
  tools: McpToolRecord[];
};

export type McpTestResult = {
  ok: boolean;
  message: string;
  detail?: string;
  toolCount?: number;
  durationMs: number;
};

/** A resolved, ready-to-execute tool available to a specific agent. */
export type AllowedTool = {
  fullName: string;
  serverId: string;
  serverName: string;
  serverSlug: string;
  toolName: string;
  description: string;
  inputSchema: McpToolRecord["inputSchema"];
};

/** A record of one MCP tool invocation, surfaced in chat (sanitized). */
export type ToolCallRecord = {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  result: string;
  error?: string;
  durationMs: number;
  /** image parts (e.g. browser screenshots) for runtimes that can see them */
  images?: { mimeType: string; data: string }[];
  /** side-effect guard verdict */
  guard?: import("@/lib/guard").GuardInfo;
  /** result contained secrets and was redacted before persistence */
  sensitive?: boolean;
};
