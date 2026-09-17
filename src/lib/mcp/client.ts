/* ------------------------------------------------------------------
   MCP JSON-RPC client — independent port of Tandem's mcpClient.

   Two transports:
     - stdio: spawn the configured command; newline-delimited JSON-RPC
     - http:  Streamable HTTP (POST JSON-RPC; JSON or SSE-framed replies;
              honours the Mcp-Session-Id header)
   Connections are pooled per server and shut down after idling.
   Credentials are injected here (stdio → env; http → ${KEY} header
   substitution) and never logged.
   ------------------------------------------------------------------ */

import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { McpServerRecord } from "./types";
import { credentialValues } from "./store";
import { validAccessToken } from "./oauth";

const IDLE_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 60_000;

const EXTRA_PATHS = [path.join(os.homedir(), ".local", "node", "bin"), path.join(os.homedir(), ".local", "bin"), "/opt/node22/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
function augmentedPath(): string {
  const cur = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return [...new Set([...cur, ...EXTRA_PATHS])].join(path.delimiter);
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

interface Rpc {
  call(method: string, params: unknown): Promise<Record<string, unknown>>;
  close(): void;
  lastUsed: number;
  dead: boolean;
}

/* ---------------------------------------------------------------- stdio */

class StdioConn implements Rpc {
  private proc: ChildProcess;
  private buf = "";
  private nextId = 10;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private initDone: Promise<void>;
  lastUsed = Date.now();
  dead = false;

  constructor(command: string, args: string[], env: Record<string, string>) {
    if (!command.trim()) throw new Error("MCP stdio server has no command configured.");
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: augmentedPath(), HOME: process.env.HOME, ...env } as unknown as NodeJS.ProcessEnv,
    });
    this.proc.on("error", (err) => this.fail(new Error(`MCP server process failed to start: ${err.message}`)));
    this.proc.on("close", (code) => this.fail(new Error(`MCP server process exited (code ${code ?? "?"}).`)));
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => this.onData(chunk));
    this.initDone = this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "nexora-os", version: "1" },
    }).then(() => {
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    });
  }

  private fail(err: Error) {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; error?: { message?: string }; result?: Record<string, unknown> };
        const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
        if (p) {
          this.pending.delete(msg.id!);
          if (msg.error) p.reject(new Error(String(msg.error.message ?? "MCP error")));
          else p.resolve(msg.result ?? {});
        }
      } catch {
        /* non-JSON stdout noise — ignore */
      }
    }
  }

  private rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (this.dead) return Promise.reject(new Error("MCP server connection is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${CALL_TIMEOUT_MS / 1000}s.`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async call(method: string, params: unknown): Promise<Record<string, unknown>> {
    await this.initDone;
    this.lastUsed = Date.now();
    return this.rpc(method, params);
  }

  close() {
    this.fail(new Error("closed"));
  }
}

/* ---------------------------------------------------------------- http */

class HttpConn implements Rpc {
  private sessionId: string | null = null;
  private nextId = 10;
  private initDone: Promise<void> | null = null;
  lastUsed = Date.now();
  dead = false;

  constructor(private url: string, private headers: Record<string, string>) {}

  private async post(body: unknown): Promise<{ json: Record<string, unknown> | null; sessionId: string | null }> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const sessionId = res.headers.get("mcp-session-id");
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP server returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
    let json: Record<string, unknown> | null = null;
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        if (line.startsWith("data:")) {
          try {
            json = JSON.parse(line.slice(5).trim());
          } catch {
            /* keep looking */
          }
        }
      }
    } else if (text.trim()) {
      json = JSON.parse(text);
    }
    return { json, sessionId };
  }

  private async rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const { json, sessionId } = await this.post({ jsonrpc: "2.0", id, method, params });
    if (sessionId) this.sessionId = sessionId;
    const j = json as { error?: { message?: string }; result?: Record<string, unknown> } | null;
    if (j?.error) throw new Error(String(j.error.message ?? "MCP error"));
    return j?.result ?? {};
  }

  async call(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (!this.initDone) {
      this.initDone = this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "nexora-os", version: "1" } }).then(async () => {
        await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
      });
    }
    await this.initDone;
    this.lastUsed = Date.now();
    return this.rpc(method, params);
  }

  close() {
    this.dead = true;
  }
}

/* ---------------------------------------------------------------- pool */

const pool = new Map<string, Rpc>();

setInterval(() => {
  for (const [key, conn] of pool) {
    if (conn.dead || Date.now() - conn.lastUsed > IDLE_MS) {
      conn.close();
      pool.delete(key);
    }
  }
}, 60_000).unref();

/** Resolve credential values and non-secret config into the transport inputs. */
export function resolveEnv(server: McpServerRecord): Record<string, string> {
  const values = credentialValues(server.credentialId);
  return { ...(server.config.env ?? {}), ...values };
}

export function resolveHeaders(server: McpServerRecord): Record<string, string> {
  const values = credentialValues(server.credentialId);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(server.config.headers ?? {})) {
    out[k] = v.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, key) => values[key] ?? "");
  }
  // A credential attached to an HTTP server without an explicit Authorization
  // header means "send it as a Bearer token" — the common case, and what the
  // owner expects when they attach a token without knowing the ${KEY} syntax.
  const hasAuth = Object.keys(out).some((k) => k.toLowerCase() === "authorization");
  if (!hasAuth && server.credentialId) {
    const keys = Object.keys(values);
    const key = keys.find((k) => /^(token|api[_-]?key|access[_-]?token|bearer|mcp[_-]?token|key)$/i.test(k)) ?? (keys.length === 1 ? keys[0] : undefined);
    if (key && values[key]) out.Authorization = `Bearer ${values[key]}`;
  }
  return out;
}

async function connect(server: McpServerRecord): Promise<Rpc> {
  let headers = resolveHeaders(server);
  let tokenTag = "";
  if (server.config.transport === "http" && server.oauth?.connected) {
    const token = await validAccessToken(server);
    if (token) {
      headers = { ...headers, Authorization: `Bearer ${token}` };
      tokenTag = `:${token.slice(-8)}`;
    }
  }
  const key = `${server.id}:${server.updatedAt}${tokenTag}`;
  const existing = pool.get(key);
  if (existing && !existing.dead) return existing;
  for (const [k, c] of pool) {
    if (k.startsWith(`${server.id}:`)) {
      c.close();
      pool.delete(k);
    }
  }
  let conn: Rpc;
  if (server.config.transport === "http") {
    if (!server.config.url?.trim()) throw new Error("MCP http server has no URL configured.");
    conn = new HttpConn(server.config.url, headers);
  } else {
    conn = new StdioConn(server.config.command ?? "", server.config.args ?? [], resolveEnv(server));
  }
  pool.set(key, conn);
  return conn;
}

export async function mcpListTools(server: McpServerRecord): Promise<McpToolDef[]> {
  const result = await (await connect(server)).call("tools/list", {});
  const tools = result?.tools;
  if (!Array.isArray(tools)) throw new Error("The MCP server returned no tool list.");
  return tools as McpToolDef[];
}

export async function mcpCallTool(server: McpServerRecord, remoteName: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const result = (await (await connect(server)).call("tools/call", { name: remoteName, arguments: args })) as {
    content?: { type?: string; text?: string }[];
    isError?: boolean;
  };
  const parts: string[] = [];
  for (const c of result?.content ?? []) {
    if (c?.type === "text") parts.push(String(c.text ?? ""));
    else if (c?.type) parts.push(`[${c.type} content omitted]`);
  }
  const text = parts.join("\n") || JSON.stringify(result ?? null);
  return { ok: !result?.isError, text };
}

export function mcpDisconnect(serverId: string): void {
  for (const [k, c] of pool) {
    if (k.startsWith(`${serverId}:`)) {
      c.close();
      pool.delete(k);
    }
  }
}

/** Non-pooled launch spec (secrets resolved) for handing a server to an external CLI. */
export function serverLaunchSpec(server: McpServerRecord):
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { transport: "http"; url: string; headers: Record<string, string> } {
  if (server.config.transport === "http") {
    return { transport: "http", url: server.config.url ?? "", headers: resolveHeaders(server) };
  }
  return { transport: "stdio", command: server.config.command ?? "", args: server.config.args ?? [], env: resolveEnv(server) };
}
