/* ------------------------------------------------------------------
   Capability registry — ONE computed view used both by the Capabilities
   page and by the Capability Manager programmatically.

   Sources, merged by capability id:
     1. native capabilities Nexora provides itself (browser, search, terminal…)
     2. well-known capability categories matched against the company's MCP
        servers by keyword (email ← zoho/gmail/smtp, dns ← cloudflare…)
     3. every other enabled MCP server as its own capability
     4. explicit CapabilityRecords the Capability Manager registered
   ------------------------------------------------------------------ */

import { readDb } from "@/lib/store/db";
import { listServers, toolsForServer } from "@/lib/mcp/store";
import type { CapabilityView } from "./types";

type Known = { id: string; name: string; description: string; keywords: string[] };

/** Capability categories the company commonly needs; matched by keyword against MCP servers and tools. */
export const KNOWN_CAPABILITIES: Known[] = [
  { id: "email", name: "Email", description: "Send and read company email.", keywords: ["mail", "zoho", "gmail", "smtp", "sendgrid", "resend", "postmark", "outlook"] },
  { id: "dns", name: "DNS Management", description: "Manage domains and DNS records.", keywords: ["cloudflare", "dns", "route53", "namecheap", "godaddy"] },
  { id: "source-control", name: "Source Control", description: "Repositories, issues and pull requests.", keywords: ["github", "gitlab", "bitbucket"] },
  { id: "phone", name: "Phone Verification", description: "Receive SMS/voice verification codes.", keywords: ["phone", "sms", "twilio", "vonage", "telnyx"] },
  { id: "social", name: "Social Publishing", description: "Publish to social networks.", keywords: ["twitter", "linkedin", "social", "buffer", "mastodon", "bluesky", "facebook", "instagram"] },
  { id: "calendar", name: "Calendar", description: "Read and schedule calendar events.", keywords: ["calendar", "calendly", "cal.com"] },
  { id: "payments", name: "Payments", description: "Charge customers and manage invoices.", keywords: ["stripe", "paypal", "paddle", "invoice"] },
  { id: "database", name: "Database", description: "Query and manage databases.", keywords: ["postgres", "mysql", "supabase", "sqlite", "mongodb", "database"] },
  { id: "hosting", name: "Cloud Hosting", description: "Deploy and operate servers and sites.", keywords: ["vercel", "netlify", "aws", "hetzner", "digitalocean", "fly.io", "docker", "kubernetes"] },
  { id: "analytics", name: "Analytics", description: "Traffic, search and product analytics.", keywords: ["analytics", "search console", "plausible", "posthog", "mixpanel"] },
  { id: "crm", name: "CRM", description: "Customer records and deals.", keywords: ["crm", "hubspot", "salesforce", "pipedrive"] },
  { id: "chat", name: "Team Chat", description: "Post to Slack, Discord or Teams.", keywords: ["slack", "discord", "teams"] },
  { id: "storage", name: "File Storage", description: "Cloud files and documents.", keywords: ["drive", "dropbox", "s3", "onedrive", "notion", "docs"] },
];

function haystack(serverName: string, slug: string, toolNames: string[]): string {
  return `${serverName} ${slug} ${toolNames.join(" ")}`.toLowerCase();
}

export function listCapabilities(): CapabilityView[] {
  const db = readDb();
  const out = new Map<string, CapabilityView>();
  const servers = listServers();
  const serverInfo = servers.map((s) => {
    const tools = toolsForServer(s.id).filter((t) => !t.missing);
    return { server: s, tools, hay: haystack(s.name, s.slug, tools.map((t) => t.name)) };
  });

  // 1. native
  const anyAgentHas = (perm: string) => db.agents.some((a) => a.toolPermissions.includes(perm));
  out.set("browser", { id: "browser", name: "Web Browser", description: "Nexora's built-in Chromium: open sites, read documentation, fill forms, sign up, screenshots.", status: "available", provider: "Native Browser", kind: "native", tags: ["browser", "web"], registered: false, tools: ["browser_*"], toolCount: 21 });
  out.set("web-search", { id: "web-search", name: "Web Search", description: "Search the web (browser_search on every runtime; WebSearch on Claude Code).", status: "available", provider: "Native Browser · Claude Code", kind: "native", tags: ["search", "web"], registered: false });
  out.set("terminal", { id: "terminal", name: "Terminal", description: "Run shell commands in an agent workspace (permission: Run commands).", status: anyAgentHas("run_commands") ? "available" : "available", provider: "Runtime shell", kind: "native", tags: ["terminal", "shell"], registered: false });
  out.set("filesystem", { id: "filesystem", name: "Filesystem", description: "Read and write files in an agent workspace.", status: "available", provider: "Runtime file tools", kind: "native", tags: ["files"], registered: false });

  // 2. known categories ← MCP servers
  const matched = new Set<string>();
  for (const k of KNOWN_CAPABILITIES) {
    const hits = serverInfo.filter((si) => k.keywords.some((kw) => si.hay.includes(kw)));
    const enabled = hits.filter((h) => h.server.enabled);
    const primary = enabled[0] ?? hits[0];
    if (primary) matched.add(primary.server.id);
    for (const h of hits) matched.add(h.server.id);
    out.set(k.id, {
      id: k.id,
      name: k.name,
      description: k.description,
      status: enabled.length ? "available" : "unavailable",
      provider: primary ? `${primary.server.name} MCP${enabled.length > 1 ? ` +${enabled.length - 1}` : ""}` : "—",
      kind: "mcp",
      serverId: primary?.server.id ?? null,
      toolCount: primary ? primary.tools.length : undefined,
      tools: primary ? primary.tools.map((t) => t.name).slice(0, 40) : undefined,
      tags: k.keywords.slice(0, 4),
      registered: false,
    });
  }

  // 3. every other MCP server (unless an explicit registered capability already presents it)
  const registeredServers = new Set(db.capabilities.map((c) => c.serverId).filter(Boolean));
  for (const si of serverInfo) {
    if (matched.has(si.server.id) || registeredServers.has(si.server.id)) continue;
    const id = `mcp:${si.server.slug}`;
    out.set(id, {
      id,
      name: si.server.name,
      description: `${si.tools.length} tool${si.tools.length === 1 ? "" : "s"} via MCP.`,
      status: si.server.enabled && si.server.lastTestOk !== false ? "available" : "unavailable",
      provider: `${si.server.name} MCP`,
      kind: "mcp",
      serverId: si.server.id,
      toolCount: si.tools.length,
      tools: si.tools.map((t) => t.name).slice(0, 40),
      tags: [si.server.slug],
      registered: false,
    });
  }

  // 4. explicit records override / extend
  for (const c of db.capabilities) {
    const prev = out.get(c.id);
    const server = c.serverId ? serverInfo.find((si) => si.server.id === c.serverId) : undefined;
    out.set(c.id, {
      id: c.id,
      name: c.name,
      description: c.description || prev?.description || "",
      status: server ? (server.server.enabled ? "available" : "unavailable") : c.status,
      provider: c.provider || prev?.provider || "—",
      kind: c.kind,
      serverId: c.serverId ?? prev?.serverId ?? null,
      toolCount: server ? server.tools.length : prev?.toolCount,
      tools: server ? server.tools.map((t) => t.name).slice(0, 40) : prev?.tools,
      tags: c.tags.length ? c.tags : prev?.tags ?? [],
      registered: true,
    });
  }

  const order = (v: CapabilityView) => (v.status === "available" ? 0 : 1);
  return [...out.values()].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
}

/** Compact text form for the Capability Manager's prompt. */
export function capabilitiesAsText(): string {
  return listCapabilities()
    .map((c) => `- ${c.name} — ${c.status.toUpperCase()}${c.provider !== "—" ? ` · ${c.provider}` : ""}${c.toolCount ? ` · ${c.toolCount} tools` : ""}${c.tools?.length ? ` (${c.tools.slice(0, 12).join(", ")}${c.tools.length > 12 ? ", …" : ""})` : ""}`)
    .join("\n");
}
