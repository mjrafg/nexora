export const dynamic = "force-dynamic";

import { completeOAuth } from "@/lib/mcp/oauth";
import { discoverTools } from "@/lib/mcp/service";
import { getServer } from "@/lib/mcp/store";

function page(title: string, body: string, ok: boolean): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:14px system-ui;background:#0b1220;color:#e8ecf5;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:420px;text-align:center;padding:24px;border:1px solid rgba(255,255,255,.1);border-radius:16px;background:rgba(255,255,255,.03)">
<div style="font-size:32px">${ok ? "✅" : "⚠️"}</div>
<h1 style="font-size:16px;margin:12px 0 6px">${title}</h1>
<p style="color:#aab2c5;font-size:13px">${body}</p>
<p style="color:#6f7890;font-size:12px;margin-top:16px">You can close this window and return to Nexora OS.</p>
</div><script>setTimeout(()=>window.close(),2500)</script>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  if (err) return page("Authorization declined", url.searchParams.get("error_description") || err, false);
  if (!code || !state) return page("Authorization failed", "Missing code or state in the callback.", false);
  try {
    const { serverId } = await completeOAuth(state, code);
    // best-effort: discover tools now that we can authenticate
    const server = getServer(serverId);
    if (server) await discoverTools(server);
    return page("Connected", `${server?.name ?? "The MCP server"} is now authorized. Its tools have been discovered.`, true);
  } catch (e) {
    return page("Authorization failed", e instanceof Error ? e.message : String(e), false);
  }
}
