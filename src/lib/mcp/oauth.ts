/* ------------------------------------------------------------------
   MCP Authorization (OAuth 2.1) for HTTP servers that are OAuth-protected
   (RFC 9728 protected-resource metadata + RFC 8414 AS metadata + RFC 7591
   dynamic client registration + authorization-code with PKCE + refresh).

   The browser-consent step is driven from the UI: start() returns an authorize
   URL, the owner signs in, the provider redirects to our callback, and we
   exchange the code for tokens. Tokens are stored encrypted on the server
   record and injected as `Authorization: Bearer` at execution time only.
   ------------------------------------------------------------------ */

import { createHash, randomBytes } from "node:crypto";
import { getServer, updateServerOAuth, readOAuthSecret, writeOAuthSecret } from "./store";
import type { McpServerRecord } from "./types";

const b64url = (b: Buffer) => b.toString("base64url");

type ProtectedResourceMeta = { resource?: string; authorization_servers?: string[]; scopes_supported?: string[] };
type AsMeta = {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
};

export type OAuthMeta = {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scope: string;
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Discover the OAuth endpoints protecting an MCP HTTP server. */
export async function discoverOAuth(server: McpServerRecord): Promise<OAuthMeta> {
  const url = server.config.url;
  if (!url) throw new Error("Server has no URL.");
  const origin = new URL(url).origin;
  const pr =
    (await fetchJson<ProtectedResourceMeta>(`${origin}/.well-known/oauth-protected-resource`)) ??
    (await fetchJson<ProtectedResourceMeta>(new URL(".well-known/oauth-protected-resource" + new URL(url).pathname, origin).href));
  const asBase = pr?.authorization_servers?.[0] ?? origin;
  const as =
    (await fetchJson<AsMeta>(`${asBase.replace(/\/$/, "")}/.well-known/oauth-authorization-server`)) ??
    (await fetchJson<AsMeta>(`${asBase.replace(/\/$/, "")}/.well-known/openid-configuration`));
  if (!as?.authorization_endpoint || !as?.token_endpoint) {
    throw new Error("This server did not advertise OAuth endpoints (no authorization-server metadata).");
  }
  const scope = (pr?.scopes_supported ?? as.scopes_supported ?? []).join(" ");
  return {
    resource: pr?.resource ?? url,
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint,
    scope,
  };
}

/** Dynamic client registration (RFC 7591) — public client + PKCE. */
async function registerClient(meta: OAuthMeta, redirectUri: string): Promise<{ clientId: string; clientSecret?: string }> {
  if (!meta.registrationEndpoint) throw new Error("This server requires manual client registration (no DCR endpoint).");
  const res = await fetch(meta.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Nexora OS",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: meta.scope || undefined,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Client registration failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { client_id?: string; client_secret?: string };
  if (!json.client_id) throw new Error("Client registration returned no client_id.");
  return { clientId: json.client_id, clientSecret: json.client_secret };
}

/* ---- pending authorizations (between start and callback) ---- */

type Pending = {
  serverId: string;
  meta: OAuthMeta;
  clientId: string;
  clientSecret?: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
};
const pending = new Map<string, Pending>();
setInterval(() => {
  const now = Date.now();
  for (const [k, p] of pending) if (now - p.createdAt > 15 * 60_000) pending.delete(k);
}, 60_000).unref();

/** Begin OAuth: discover, register, and return the authorize URL to open. */
export async function startOAuth(serverId: string, origin: string): Promise<{ authorizeUrl: string; state: string }> {
  const server = getServer(serverId);
  if (!server || server.config.transport !== "http") throw new Error("OAuth applies to HTTP MCP servers only.");
  const meta = await discoverOAuth(server);
  const redirectUri = `${origin}/api/mcp-servers/oauth/callback`;
  const reg = server.oauth?.clientId
    ? { clientId: server.oauth.clientId, clientSecret: readOAuthSecret(serverId)?.clientSecret }
    : await registerClient(meta, redirectUri);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  pending.set(state, { serverId, meta, clientId: reg.clientId, clientSecret: reg.clientSecret, verifier, redirectUri, createdAt: Date.now() });
  const p = new URLSearchParams({
    response_type: "code",
    client_id: reg.clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource: meta.resource,
  });
  if (meta.scope) p.set("scope", meta.scope);
  return { authorizeUrl: `${meta.authorizationEndpoint}?${p.toString()}`, state };
}

/** Complete OAuth after the provider redirects back with a code. */
export async function completeOAuth(state: string, code: string): Promise<{ serverId: string }> {
  const p = pending.get(state);
  if (!p) throw new Error("This authorization has expired. Start again.");
  pending.delete(state);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.verifier,
    resource: p.meta.resource,
  });
  if (p.clientSecret) body.set("client_secret", p.clientSecret);
  const res = await fetch(p.meta.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  const tok = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!tok.access_token) throw new Error("Token endpoint returned no access_token.");
  const expiresAt = tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined;
  writeOAuthSecret(p.serverId, { clientSecret: p.clientSecret, accessToken: tok.access_token, refreshToken: tok.refresh_token });
  updateServerOAuth(p.serverId, {
    clientId: p.clientId,
    authorizationEndpoint: p.meta.authorizationEndpoint,
    tokenEndpoint: p.meta.tokenEndpoint,
    registrationEndpoint: p.meta.registrationEndpoint,
    resource: p.meta.resource,
    scope: p.meta.scope,
    expiresAt,
    connected: true,
  });
  return { serverId: p.serverId };
}

/** A valid access token for a server, refreshing if it is expired/near expiry. Null if not connected. */
export async function validAccessToken(server: McpServerRecord): Promise<string | null> {
  if (!server.oauth?.connected) return null;
  const secret = readOAuthSecret(server.id);
  if (!secret?.accessToken) return null;
  const expiresAt = server.oauth.expiresAt ?? 0;
  if (!expiresAt || expiresAt - Date.now() > 60_000) return secret.accessToken;
  // refresh
  if (!secret.refreshToken) return secret.accessToken;
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: secret.refreshToken,
      client_id: server.oauth.clientId,
      resource: server.oauth.resource,
    });
    if (secret.clientSecret) body.set("client_secret", secret.clientSecret);
    const res = await fetch(server.oauth.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return secret.accessToken;
    const tok = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!tok.access_token) return secret.accessToken;
    writeOAuthSecret(server.id, { clientSecret: secret.clientSecret, accessToken: tok.access_token, refreshToken: tok.refresh_token ?? secret.refreshToken });
    updateServerOAuth(server.id, { ...server.oauth, expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined, connected: true });
    return tok.access_token;
  } catch {
    return secret.accessToken;
  }
}

export function disconnectOAuth(serverId: string): void {
  writeOAuthSecret(serverId, null);
  const server = getServer(serverId);
  if (server?.oauth) updateServerOAuth(serverId, { ...server.oauth, connected: false, expiresAt: undefined });
}
