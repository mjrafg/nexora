/* ------------------------------------------------------------------
   Internal tool servers — Nexora's own deterministic actions exposed to
   agents as MCP-shaped tools, independent of the AI runtime:

     CLI runtimes (Claude Code, Codex)  → stdio proxy scripts/mcp-nexora.mjs
                                          → POST /api/internal/tools (turn token)
     API runtime                        → executed in-process

   A TURN TOKEN is minted per agent turn and carries the agent identity and
   the servers that turn may use. The proxy only ever holds that token, so a
   prompt-injected agent cannot act as another agent by editing a body field
   (the same reason Tandem derives the browser role from the run context).
   ------------------------------------------------------------------ */

import { randomBytes } from "node:crypto";
import type { TurnEmitter, BrowserActionMeta } from "@/lib/activity";

export type InternalToolDef = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** side-effect class (default READ_ONLY: internal tools are idempotent unless declared otherwise) */
  sideEffect?: "READ_ONLY" | "SIDE_EFFECT" | "FINANCIAL";
  /** the result carries secrets (payment details): never recorded in activity, ledger summaries or persisted transcripts */
  sensitive?: boolean;
  /**
   * Argument names whose values must never be recorded verbatim — the runner
   * masks them in activity and scrubs them from the guard ledger. Use it for
   * free-form arguments that an agent might fill with something it should not
   * have (a value field that turns out to be a card number, say).
   */
  maskArgs?: string[];
};

export type ToolCallContext = {
  agentId: string;
  turnId: string;
  emit: TurnEmitter;
  /** override the browser session key (Test Lab, project sessions); default agent:<id> */
  browserKey?: string;
  /** logical work scope for side-effect deduplication */
  scopeId?: string;
  /** the conversation the tool was called from — where work created here reports back */
  chatId?: string;
};

export type InternalToolResult = {
  ok: boolean;
  text: string;
  images?: { mimeType: string; data: string }[];
  browser?: BrowserActionMeta;
};

export type InternalToolServer = {
  /** MCP server slug → tools are served as mcp__<slug>__<tool> to CLIs */
  slug: string;
  name: string;
  tools: InternalToolDef[];
  /** the server records its own activity events (adapters must not duplicate them) */
  selfRecords?: boolean;
  /** subset of `tools` a given agent may see/call (default: all) */
  toolsFor?: (agent: { id: string; toolPermissions: string[] }) => InternalToolDef[];
  call: (name: string, args: Record<string, unknown>, ctx: ToolCallContext) => Promise<InternalToolResult>;
};

/* ---------------------------------------------------------------- registry */

const registry = new Map<string, InternalToolServer>();

export function registerToolServer(server: InternalToolServer): InternalToolServer {
  registry.set(server.slug, server);
  return server;
}

export function getToolServer(slug: string): InternalToolServer | null {
  return registry.get(slug) ?? null;
}

/* ---------------------------------------------------------------- turn tokens */

type TurnGrant = { token: string; ctx: ToolCallContext; servers: string[]; expiresAt: number };
const grants = new Map<string, TurnGrant>();
const TOKEN_TTL_MS = 6 * 60 * 60_000; // longer than any turn; revoked explicitly when the turn ends

export function issueTurnToken(ctx: ToolCallContext, servers: string[]): string {
  const token = randomBytes(24).toString("hex");
  grants.set(token, { token, ctx, servers, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

export function resolveTurnToken(token: string | undefined): TurnGrant | null {
  if (!token) return null;
  const g = grants.get(token);
  if (!g) return null;
  if (g.expiresAt < Date.now()) { grants.delete(token); return null; }
  return g;
}

export function revokeTurnToken(token: string): void {
  grants.delete(token);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, g] of grants) if (g.expiresAt < now) grants.delete(k);
}, 10 * 60_000).unref();

