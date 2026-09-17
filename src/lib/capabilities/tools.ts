/* ------------------------------------------------------------------
   Capability tool servers.

     "nexora"              → request_capability — available to EVERY agent;
                              routes to the Capability Manager, never the Owner
     "capability_manager"  → the Capability Manager's console: registry,
                              MCP servers, credentials, grants, request state.

   All actions are deterministic wrappers over Nexora's existing MCP engine,
   credential vault and agent grants — no second engine, no workflow logic.
   ------------------------------------------------------------------ */

import { readDb, updateDb, now } from "@/lib/store/db";
import { TOOL_CATALOG } from "@/lib/runtime/catalog";
import type { AgentRecord } from "@/lib/runtime/types";
import type { McpServerConfig, McpServerRecord } from "@/lib/mcp/types";
import {
  createCredential, createServer, deleteServer, getServer, listCredentials, listServers, toolsForServer, updateServer, credentialName,
} from "@/lib/mcp/store";
import { discoverTools, mcpDisconnect, testServer } from "@/lib/mcp/service";
import { registerToolServer, type InternalToolDef, type InternalToolResult, type InternalToolServer, type ToolCallContext } from "@/lib/tools/internal";
import { capabilitiesAsText } from "./registry";
import { grantsText } from "./grants";
import { addCapabilityActivity, findRequest, patchRequest, setRequestStatus, upsertCapability } from "./store";
import { CAPABILITY_MANAGER_ID, currentRequestId, failRequest, resolveRequest, submitCapabilityRequest } from "./manager";
import { startNewActionAttempt } from "@/lib/guard";

const ok = (text: string): InternalToolResult => ({ ok: true, text });
const fail = (text: string): InternalToolResult => ({ ok: false, text });
const short = (id: string) => id.slice(0, 8);

type Args = Record<string, unknown>;
const s = (v: unknown, max = 2_000) => (typeof v === "string" ? v.slice(0, max).trim() : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : []);
const map = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (k.trim() && typeof val === "string") out[k.trim()] = val;
  return Object.keys(out).length ? out : undefined;
};

function findServer(ref: unknown): McpServerRecord | null {
  const r = s(ref, 200).toLowerCase();
  if (!r) return null;
  return listServers().find((x) => x.id === r || x.slug === r || x.name.toLowerCase() === r) ?? listServers().find((x) => x.id.startsWith(r)) ?? null;
}

function findAgent(ref: unknown): AgentRecord | null {
  const r = s(ref, 200).toLowerCase();
  if (!r) return null;
  const agents = readDb().agents;
  return agents.find((a) => a.id === r || a.name.toLowerCase() === r) ?? agents.find((a) => a.id.startsWith(r)) ?? null;
}

function requestRef(args: Args): string | null {
  const ref = s(args.request, 80);
  const found = ref ? findRequest(ref) : null;
  if (found) return found.id;
  return currentRequestId();
}

function serverLine(srv: McpServerRecord): string {
  const tools = toolsForServer(srv.id).filter((t) => !t.missing);
  const cfg = srv.config.transport === "http" ? `http ${srv.config.url}` : `stdio ${srv.config.command} ${(srv.config.args ?? []).join(" ")}`;
  return `- ${srv.name} (slug ${srv.slug}, id ${short(srv.id)}) — ${srv.enabled ? "enabled" : "disabled"} · ${cfg} · credential: ${credentialName(srv.credentialId) ?? "none"}${srv.oauth?.connected ? " · OAuth connected" : ""} · last test: ${srv.lastTestOk === null || srv.lastTestOk === undefined ? "never" : srv.lastTestOk ? "ok" : `FAILED (${srv.lastTestError ?? ""})`}\n  tools (${tools.length}): ${tools.map((t) => t.name).join(", ") || "(none discovered)"}`;
}

function buildConfig(args: Args, base?: McpServerConfig): McpServerConfig {
  const transport = args.transport === "http" ? "http" : args.transport === "stdio" ? "stdio" : base?.transport ?? (s(args.url) ? "http" : "stdio");
  if (transport === "http") {
    const url = s(args.url, 2000) || base?.url || "";
    if (!/^https?:\/\//.test(url)) throw new Error("http transport needs a valid http(s) url.");
    return { transport, url, headers: map(args.headers) ?? base?.headers };
  }
  const command = s(args.command, 500) || base?.command || "";
  if (!command) throw new Error("stdio transport needs a command (e.g. npx).");
  return { transport, command, args: args.args !== undefined ? list(args.args) : base?.args ?? [], env: map(args.env) ?? base?.env };
}


function autoGrantManager(serverId: string) {
  // the Capability Manager may use every server so it can test tools end to end
  updateDb((d) => {
    const cm = d.agents.find((a) => a.id === CAPABILITY_MANAGER_ID);
    if (!cm) return;
    cm.mcpGrants ??= [];
    if (!cm.mcpGrants.some((g) => g.serverId === serverId)) cm.mcpGrants.push({ serverId, enabled: true, tools: "all" });
  });
}

/* ---------------------------------------------------------------- console tools */

const CONSOLE_TOOLS: InternalToolDef[] = [
  { name: "list_capabilities", description: "The company capability registry: what is available (native, MCP-backed, registered) and what is not.", inputSchema: { type: "object", properties: {} } },
  { name: "list_mcp_servers", description: "Every configured MCP server with transport, credential, last test result and discovered tools.", inputSchema: { type: "object", properties: {} } },
  { name: "add_mcp_server", sideEffect: "SIDE_EFFECT", description: "Add an MCP server to the company registry and discover its tools. stdio: command + args (+ non-secret env); http: url (+ headers; a header value may reference a credential key as ${KEY}). Attach a credential by name/id for secrets. Returns the discovered tools or the connection error.", inputSchema: { type: "object", properties: { name: { type: "string" }, transport: { type: "string", enum: ["stdio", "http"] }, command: { type: "string" }, args: { type: "array", items: { type: "string" } }, env: { type: "object" }, url: { type: "string" }, headers: { type: "object" }, credential: { type: "string" } }, required: ["name"] } },
  { name: "edit_mcp_server", sideEffect: "SIDE_EFFECT", description: "Change an MCP server's name, transport/command/args/env/url/headers or enabled flag, then re-discover tools.", inputSchema: { type: "object", properties: { server: { type: "string" }, name: { type: "string" }, transport: { type: "string", enum: ["stdio", "http"] }, command: { type: "string" }, args: { type: "array", items: { type: "string" } }, env: { type: "object" }, url: { type: "string" }, headers: { type: "object" }, enabled: { type: "boolean" } }, required: ["server"] } },
  { name: "test_mcp_server", description: "Connect to an MCP server and list its tools (connection test).", inputSchema: { type: "object", properties: { server: { type: "string" } }, required: ["server"] } },
  { name: "refresh_mcp_tools", description: "Re-discover an MCP server's tools and persist them (existing grants are kept).", inputSchema: { type: "object", properties: { server: { type: "string" } }, required: ["server"] } },
  { name: "remove_mcp_server", sideEffect: "SIDE_EFFECT", description: "Remove an MCP server and every grant that references it.", inputSchema: { type: "object", properties: { server: { type: "string" } }, required: ["server"] } },
  { name: "list_credentials", description: "Credentials in the vault: names and KEY names only (values are never shown).", inputSchema: { type: "object", properties: {} } },
  { name: "create_credential", sideEffect: "SIDE_EFFECT", description: "Store a new credential (one or more KEY=value secrets) in the vault. Values are encrypted and never echoed back.", inputSchema: { type: "object", properties: { name: { type: "string" }, values: { type: "object", description: "e.g. {\"API_KEY\": \"...\"}" } }, required: ["name", "values"] } },
  { name: "attach_credential", sideEffect: "SIDE_EFFECT", description: "Attach a vault credential to an MCP server (stdio: injected as env; http: ${KEY} header substitution).", inputSchema: { type: "object", properties: { server: { type: "string" }, credential: { type: "string" } }, required: ["server", "credential"] } },
  { name: "list_agent_tool_grants", description: "An agent's native tool permissions and MCP grants.", inputSchema: { type: "object", properties: { agent: { type: "string", description: "agent id or name" } }, required: ["agent"] } },
  { name: "grant_agent_mcp_server", sideEffect: "SIDE_EFFECT", description: "Grant an agent ALL tools of an MCP server.", inputSchema: { type: "object", properties: { agent: { type: "string" }, server: { type: "string" } }, required: ["agent", "server"] } },
  { name: "grant_agent_mcp_tools", sideEffect: "SIDE_EFFECT", description: "Grant an agent specific tools of an MCP server (minimum access).", inputSchema: { type: "object", properties: { agent: { type: "string" }, server: { type: "string" }, tools: { type: "array", items: { type: "string" } } }, required: ["agent", "server", "tools"] } },
  { name: "grant_agent_native_tool", sideEffect: "SIDE_EFFECT", description: "Grant an agent a native Nexora tool permission: browser, web_search, web_fetch, read_files, write_files, run_commands.", inputSchema: { type: "object", properties: { agent: { type: "string" }, tool: { type: "string" } }, required: ["agent", "tool"] } },
  { name: "revoke_agent_tool", sideEffect: "SIDE_EFFECT", description: "Revoke an agent's access: a whole MCP server, specific MCP tools, or a native tool.", inputSchema: { type: "object", properties: { agent: { type: "string" }, server: { type: "string" }, tools: { type: "array", items: { type: "string" } }, native_tool: { type: "string" } }, required: ["agent"] } },
  { name: "register_capability", sideEffect: "SIDE_EFFECT", description: "Record a capability in the company registry (e.g. after installing an MCP): name, description, provider label, status, backing server, tags.", inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, provider: { type: "string" }, status: { type: "string", enum: ["available", "unavailable"] }, server: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["name", "provider"] } },
  { name: "set_request_status", description: "Update the request's state (RESEARCHING, INSTALLING, TESTING) with a one-line note the Owner can follow.", inputSchema: { type: "object", properties: { request: { type: "string" }, status: { type: "string", enum: ["RESEARCHING", "INSTALLING", "TESTING"] }, note: { type: "string" } }, required: ["status", "note"] } },
  { name: "resolve_request", description: "Mark the request RESOLVED. The requesting agent resumes automatically with your summary and the list of granted tools.", inputSchema: { type: "object", properties: { request: { type: "string" }, summary: { type: "string" }, granted: { type: "array", items: { type: "string" }, description: "tool or capability names now available to the requester" } }, required: ["summary"] } },
  { name: "fail_request", description: "Mark the request FAILED with an honest reason. The requester resumes and is told what is blocked.", inputSchema: { type: "object", properties: { request: { type: "string" }, reason: { type: "string" } }, required: ["reason"] } },
];

async function consoleCall(name: string, args: Args, ctx: ToolCallContext): Promise<InternalToolResult> {
  if (ctx.agentId !== CAPABILITY_MANAGER_ID) return fail("Only the Capability Manager may use this console.");
  const reqId = requestRef(args);
  try {
    switch (name) {
      case "list_capabilities":
        return ok(capabilitiesAsText());
      case "list_mcp_servers": {
        const servers = listServers();
        return ok(servers.length ? servers.map(serverLine).join("\n") : "No MCP servers configured.");
      }
      case "add_mcp_server": {
        const nm = s(args.name, 80);
        if (!nm) return fail("name is required.");
        const config = buildConfig(args);
        let credentialId: string | null = null;
        if (s(args.credential)) {
          const c = listCredentials().find((x) => x.id === s(args.credential) || x.name.toLowerCase() === s(args.credential).toLowerCase());
          if (!c) return fail(`Credential "${s(args.credential)}" not found; create it first with create_credential.`);
          credentialId = c.id;
        }
        const server = createServer({ name: nm, config, credentialId });
        autoGrantManager(server.id);
        addCapabilityActivity(reqId, "mcp_installed", `MCP server "${server.name}" added`, config.transport === "http" ? config.url : `${config.command} ${(config.args ?? []).join(" ")}`);
        const disc = await discoverTools(server);
        if (disc.ok) addCapabilityActivity(reqId, "tools_discovered", `${disc.toolCount ?? 0} tools discovered on "${server.name}"`);
        else addCapabilityActivity(reqId, "connection_tested", `Connection to "${server.name}" failed`, disc.detail);
        const fresh = getServer(server.id)!;
        return disc.ok ? ok(`Added and discovered:\n${serverLine(fresh)}`) : fail(`Server added (id ${short(server.id)}) but discovery failed: ${disc.detail ?? disc.message}. Fix the config with edit_mcp_server / attach_credential and test again, or remove_mcp_server.`);
      }
      case "edit_mcp_server": {
        const srv = findServer(args.server);
        if (!srv) return fail("Server not found.");
        const config = ["transport", "command", "args", "env", "url", "headers"].some((k) => args[k] !== undefined) ? buildConfig(args, srv.config) : undefined;
        updateServer(srv.id, { name: s(args.name, 80) || undefined, config, enabled: typeof args.enabled === "boolean" ? args.enabled : undefined });
        mcpDisconnect(srv.id);
        const disc = await discoverTools(getServer(srv.id)!);
        return disc.ok ? ok(`Updated:\n${serverLine(getServer(srv.id)!)}`) : fail(`Updated, but discovery failed: ${disc.detail ?? disc.message}`);
      }
      case "test_mcp_server": {
        const srv = findServer(args.server);
        if (!srv) return fail("Server not found.");
        mcpDisconnect(srv.id);
        const r = await testServer(srv);
        addCapabilityActivity(reqId, "connection_tested", `Tested "${srv.name}": ${r.ok ? "connected" : "failed"}`, r.detail);
        return r.ok ? ok(`${srv.name}: ${r.message} — ${r.detail ?? ""}`) : fail(`${srv.name}: ${r.message} — ${r.detail ?? ""}`);
      }
      case "refresh_mcp_tools": {
        const srv = findServer(args.server);
        if (!srv) return fail("Server not found.");
        mcpDisconnect(srv.id);
        const r = await discoverTools(srv);
        if (r.ok) addCapabilityActivity(reqId, "tools_discovered", `${r.toolCount ?? 0} tools discovered on "${srv.name}"`);
        return r.ok ? ok(serverLine(getServer(srv.id)!)) : fail(`${r.message}: ${r.detail ?? ""}`);
      }
      case "remove_mcp_server": {
        const srv = findServer(args.server);
        if (!srv) return fail("Server not found.");
        deleteServer(srv.id);
        addCapabilityActivity(reqId, "note", `MCP server "${srv.name}" removed`);
        return ok(`Removed ${srv.name}.`);
      }
      case "list_credentials": {
        const creds = listCredentials();
        return ok(creds.length ? creds.map((c) => `- ${c.name} (id ${short(c.id)}) · keys: ${c.keys.join(", ")} · used by: ${c.usedBy.join(", ") || "nothing"}`).join("\n") : "The vault is empty.");
      }
      case "create_credential": {
        const nm = s(args.name, 80);
        const values = map(args.values);
        if (!nm || !values) return fail("name and values are required.");
        const c = createCredential(nm, values);
        addCapabilityActivity(reqId, "credential_stored", `Credential "${c.name}" stored in the vault (${c.keys.join(", ")})`);
        return ok(`Stored credential "${c.name}" (id ${short(c.id)}) with keys ${c.keys.join(", ")}. Values are never shown again.`);
      }
      case "attach_credential": {
        const srv = findServer(args.server);
        if (!srv) return fail("Server not found.");
        const c = listCredentials().find((x) => x.id === s(args.credential) || x.name.toLowerCase() === s(args.credential).toLowerCase());
        if (!c) return fail("Credential not found.");
        updateServer(srv.id, { credentialId: c.id });
        mcpDisconnect(srv.id);
        return ok(`Attached "${c.name}" to ${srv.name}. Test the server next.`);
      }
      case "list_agent_tool_grants": {
        const agent = findAgent(args.agent);
        if (!agent) return fail("Agent not found.");
        return ok(`${agent.name} (${agent.id})\n${grantsText(agent)}`);
      }
      case "grant_agent_mcp_server":
      case "grant_agent_mcp_tools": {
        const agent = findAgent(args.agent);
        const srv = findServer(args.server);
        if (!agent) return fail("Agent not found.");
        if (!srv) return fail("Server not found.");
        const available = toolsForServer(srv.id).filter((t) => !t.missing);
        let granted: string[] = [];
        updateDb((d) => {
          const a = d.agents.find((x) => x.id === agent.id)!;
          a.mcpGrants ??= [];
          const rest = a.mcpGrants.filter((g) => g.serverId !== srv.id);
          const prev = a.mcpGrants.find((g) => g.serverId === srv.id);
          if (name === "grant_agent_mcp_server") {
            a.mcpGrants = [...rest, { serverId: srv.id, enabled: true, tools: "all" }];
            granted = available.map((t) => t.name);
          } else {
            const wanted = list(args.tools).map((t) => t.split("__").pop()!.toLowerCase());
            const rows = available.filter((t) => wanted.includes(t.name.toLowerCase()));
            if (rows.length === 0) throw new Error(`None of ${wanted.join(", ")} exist on ${srv.name}. Available: ${available.map((t) => t.name).join(", ")}`);
            const merged = prev && prev.tools !== "all" ? [...new Set([...prev.tools, ...rows.map((t) => t.fullName)])] : prev?.tools === "all" ? "all" : rows.map((t) => t.fullName);
            a.mcpGrants = [...rest, { serverId: srv.id, enabled: true, tools: merged }];
            granted = rows.map((t) => t.name);
          }
          a.updatedAt = now();
        });
        addCapabilityActivity(reqId, "grant_created", `${agent.name} granted ${name === "grant_agent_mcp_server" ? "all tools" : granted.join(", ")} on "${srv.name}"`);
        return ok(`${agent.name} may now use ${srv.name}: ${granted.join(", ") || "(no tools discovered yet — refresh_mcp_tools)"}.`);
      }
      case "grant_agent_native_tool": {
        const agent = findAgent(args.agent);
        if (!agent) return fail("Agent not found.");
        const tool = s(args.tool, 40);
        if (!TOOL_CATALOG.some((t) => t.id === tool)) return fail(`Unknown native tool. Valid: ${TOOL_CATALOG.map((t) => t.id).join(", ")}`);
        updateDb((d) => {
          const a = d.agents.find((x) => x.id === agent.id)!;
          if (!a.toolPermissions.includes(tool)) a.toolPermissions.push(tool);
          a.updatedAt = now();
        });
        addCapabilityActivity(reqId, "grant_created", `${agent.name} granted native tool "${tool}"`);
        return ok(`${agent.name} now has the "${tool}" permission (independent of its runtime).`);
      }
      case "revoke_agent_tool": {
        const agent = findAgent(args.agent);
        if (!agent) return fail("Agent not found.");
        const nat = s(args.native_tool, 40);
        const srv = args.server ? findServer(args.server) : null;
        if (!nat && !srv) return fail("Give server (and optionally tools) or native_tool.");
        updateDb((d) => {
          const a = d.agents.find((x) => x.id === agent.id)!;
          if (nat) a.toolPermissions = a.toolPermissions.filter((t) => t !== nat);
          if (srv) {
            const wanted = list(args.tools).map((t) => t.split("__").pop()!.toLowerCase());
            if (wanted.length === 0) a.mcpGrants = (a.mcpGrants ?? []).filter((g) => g.serverId !== srv.id);
            else {
              a.mcpGrants = (a.mcpGrants ?? []).map((g) => {
                if (g.serverId !== srv.id) return g;
                const all = toolsForServer(srv.id).map((t) => t.fullName);
                const current = g.tools === "all" ? all : g.tools;
                return { ...g, tools: current.filter((f) => !wanted.includes(f.split("__").pop()!.toLowerCase())) };
              });
            }
          }
          a.updatedAt = now();
        });
        addCapabilityActivity(reqId, "note", `Revoked ${nat || `${srv!.name} ${list(args.tools).join(", ") || "(all)"}`} from ${agent.name}`);
        return ok("Revoked.");
      }
      case "register_capability": {
        const nm = s(args.name, 80);
        if (!nm) return fail("name is required.");
        const srv = args.server ? findServer(args.server) : null;
        const rec = upsertCapability({ name: nm, description: s(args.description, 400), provider: s(args.provider, 80) || (srv ? `${srv.name} MCP` : "—"), status: args.status === "unavailable" ? "unavailable" : "available", kind: srv ? "mcp" : "integration", serverId: srv?.id ?? null, tags: list(args.tags).slice(0, 8) });
        addCapabilityActivity(reqId, "note", `Capability "${rec.name}" registered (${rec.status})`);
        return ok(`Registered capability "${rec.name}" (${rec.status}, ${rec.provider}).`);
      }
      case "set_request_status": {
        if (!reqId) return fail("No request in context; pass request.");
        const status = s(args.status, 20) as "RESEARCHING" | "INSTALLING" | "TESTING";
        if (!["RESEARCHING", "INSTALLING", "TESTING"].includes(status)) return fail("status must be RESEARCHING, INSTALLING or TESTING.");
        const note = s(args.note, 300);
        setRequestStatus(reqId, status, note);
        addCapabilityActivity(reqId, status === "RESEARCHING" ? "research_started" : "note", `${status}: ${note}`);
        return ok(`Request #${short(reqId)} is now ${status}.`);
      }
      case "resolve_request": {
        if (!reqId) return fail("No request in context; pass request.");
        const summary = s(args.summary, 2_000);
        if (!summary) return fail("summary is required.");
        resolveRequest(reqId, summary, list(args.granted));
        return ok(`Request #${short(reqId)} resolved. The requesting agent resumes automatically.`);
      }
      case "fail_request": {
        if (!reqId) return fail("No request in context; pass request.");
        const reason = s(args.reason, 2_000) || "No reason given.";
        failRequest(reqId, reason);
        return ok(`Request #${short(reqId)} marked FAILED. The requesting agent is told.`);
      }
      case "request_payment_approval":
        return fail("Use the Payments tool instead: request_payment({ merchant, amount, reason, billing_type }) — the automatic spending limit decides whether the owner must approve, and you are resumed with the decision.");
      default:
        return fail(`Unknown tool ${name}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Shared by every agent: the Nexora server and the manager console both expose it. */
const ASSUMPTION_TOOL: InternalToolDef = {
  name: "record_assumption",
  description:
    "You kept working instead of interrupting the owner: record the choice you made. One line for what you decided, plus why. Use it for reversible decisions (a generated username, a skipped optional field, a default you picked, a provisional value you stored). These are collected for the end of the task, so the owner sees them once, together, and can correct them — they are NOT shown to the owner while you work. Do not record trivia, and never use it to excuse fabricating authoritative legal, tax, identity or financial information.",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string", description: 'one line, e.g. "Used agent24.admin as the account username"' },
      detail: { type: "string", description: "why this was the reasonable choice" },
      custom_data_key: { type: "string", description: "the company data key that now holds it, if you saved one" },
    },
    required: ["summary"],
  },
};

async function callAssumption(args: Record<string, unknown>, ctx: ToolCallContext): Promise<InternalToolResult> {
  const summary = s(args.summary, 200);
  if (!summary) return fail("summary is required.");
  const { recordAssumption } = await import("@/lib/agents/assumptions");
  const rec = recordAssumption({ agentId: ctx.agentId, summary, detail: s(args.detail, 600) || undefined, customDataKey: s(args.custom_data_key, 120) || undefined, scopeId: ctx.scopeId });
  return ok(`Recorded: "${rec.summary}". Keep working — it is reported to the owner when the task ends.`);
}

export const capabilityManagerToolServer: InternalToolServer = registerToolServer({
  slug: "capability_manager",
  name: "Capability Manager Console",
  // the manager works autonomously too, so it records assumptions like any other agent
  tools: [...CONSOLE_TOOLS, ASSUMPTION_TOOL],
  call: async (name, args, ctx) => (name === ASSUMPTION_TOOL.name ? callAssumption(args, ctx) : consoleCall(name, args, ctx)),
});

/* ---------------------------------------------------------------- request_capability (every agent) */

export const nexoraToolServer: InternalToolServer = registerToolServer({
  slug: "nexora",
  name: "Nexora",
  tools: [
    {
      name: "request_capability",
      sideEffect: "SIDE_EFFECT",
      description: "You lack a tool, integration, account or access you need? Ask Nexora's Capability Manager for it instead of the owner. Describe the capability, why you need it and what you were doing. Your request is handled autonomously (existing tools reused, free tools installed, only real spending goes to the owner) and you are resumed automatically with the result — so after calling this, finish your reply and stop working on the blocked part.",
      inputSchema: {
        type: "object",
        properties: {
          capability: { type: "string", description: "e.g. Cloudflare DNS management" },
          reason: { type: "string" },
          context: { type: "string", description: "what you were doing and what you will do once it is available" },
          team_checked: { type: "boolean", description: "Managers only: you have called list_team and confirmed that nobody reporting to you can already do this." },
          team_finding: { type: "string", description: "Managers only: what you found when you checked your team — who you considered and why they cannot do it." },
        },
        required: ["capability", "reason"],
      },
    },
    ASSUMPTION_TOOL,
    {
      name: "start_new_action_attempt",
      description: "Nexora prevents the same real-world action (send, create, purchase…) from running twice in one piece of work: a repeat returns the original result instead. Use this ONLY when the exact same action must genuinely happen again in this work (e.g. the customer explicitly asked for the same message to be resent, or you verified that an uncertain earlier attempt did NOT happen). Give the reason; it is audited. Then perform the action again.",
      inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
    },
  ],
  call: async (name, args, ctx) => {
    if (name === ASSUMPTION_TOOL.name) return callAssumption(args, ctx);
    if (name === "start_new_action_attempt") {
      const reason = s(args.reason, 300);
      if (!reason) return fail("reason is required.");
      const scope = ctx.scopeId ?? `turn:${ctx.turnId}`;
      const epoch = startNewActionAttempt(scope, reason, ctx.agentId);
      return ok(`New action attempt #${epoch} opened for this work scope (reason recorded). The next identical action will execute as a new operation.`);
    }
    if (name !== "request_capability") return fail(`Unknown tool ${name}`);
    const capability = s(args.capability, 200);
    if (!capability) return fail("capability is required.");
    // A manager asking Nexora to give IT a tool has usually taken work that
    // belongs to someone who already holds that tool. One look at the team
    // first — the manager still decides, it just decides with the facts.
    const { directReports } = await import("@/lib/tasks/store");
    const reports = directReports(ctx.agentId);
    if (reports.length && args.team_checked !== true) {
      return fail(
        `Not yet — you have ${reports.length} direct report${reports.length === 1 ? "" : "s"}. Needing access you do not have is usually a sign the work is with the wrong person, not that Nexora is missing something. Call list_team, look at what each of them already has, and if one of them can do this, give them the work with create_task instead. If you have looked and nobody on your team can do it either, call request_capability again with team_checked: true and team_finding set to what you found.`
      );
    }
    const teamNote = reports.length && s(args.team_finding, 1_000) ? `\n\nTeam checked first: ${s(args.team_finding, 1_000)}` : "";
    const r = submitCapabilityRequest(ctx.agentId, { capability, reason: s(args.reason, 2_000), context: `${s(args.context, 6_000)}${teamNote}` }, ctx.scopeId);
    if (!r) return fail("Agent not found.");
    patchRequest(r.id, { note: "Queued for the Capability Manager" });
    return ok(`Capability request #${short(r.id)} ("${capability}") was sent to the Capability Manager. It will check existing tools, install a free solution if needed, grant you access and resume you automatically. Stop working on the blocked part now and finish your reply.`);
  },
});
