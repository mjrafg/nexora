import { credentialName, listServers, toolsForServer } from "./store";
import type { McpServerRecord, McpServerView } from "./types";

export function toServerView(s: McpServerRecord): McpServerView {
  const { oauthSecretEnc: _secret, ...safe } = s;
  void _secret;
  return { ...safe, credentialName: credentialName(s.credentialId), tools: toolsForServer(s.id) };
}

export function listServerViews(): McpServerView[] {
  return listServers().map(toServerView);
}
