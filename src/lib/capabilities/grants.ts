/* Text view of an agent's access, shared by the console tools and the manager prompt. */
import { TOOL_CATALOG } from "@/lib/runtime/catalog";
import type { AgentRecord } from "@/lib/runtime/types";
import { getServer, toolsForServer } from "@/lib/mcp/store";

export function grantsText(agent: AgentRecord): string {
  const native = agent.toolPermissions.map((id) => TOOL_CATALOG.find((t) => t.id === id)?.label ?? id);
  const mcp = (agent.mcpGrants ?? []).map((g) => {
    const srv = getServer(g.serverId);
    if (!srv) return null;
    const tools = g.tools === "all" ? `all tools (${toolsForServer(srv.id).filter((t) => !t.missing).length})` : g.tools.map((t) => t.split("__").pop()).join(", ");
    return `${srv.name}: ${g.enabled ? tools : "disabled"}`;
  }).filter(Boolean);
  return `Native permissions: ${native.join(", ") || "none"}\nMCP grants: ${mcp.length ? mcp.join("; ") : "none"}`;
}
