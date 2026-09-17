/* ------------------------------------------------------------------
   Web-driven logins for the CLI runtimes.

   Claude Code: native OAuth (PKCE). We build the same authorize URL the
                `claude` CLI uses, the owner signs in and pastes the returned
                code, and we exchange it at api.anthropic.com. The WHOLE
                credential is kept — access token, refresh token and expiry —
                and the access half is injected as CLAUDE_CODE_OAUTH_TOKEN when
                the runtime spawns `claude`.

                It used to keep only the access token. That works for a few
                hours and then every Director, Builder and Reviewer turn fails
                with "401 OAuth access token has expired", with no native CLI
                login to fall back on, and the only cure was the owner signing
                in again. The renewable half of the credential was being parsed
                and thrown away.
   Codex:       `codex login --device-auth` under a pseudo-terminal → prints a
                URL + one-time code; the owner enters it in the browser and the
                CLI persists ~/.codex/auth.json.
   ------------------------------------------------------------------ */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { deleteSecret, getSecret, putSecret } from "@/lib/store/db";
import { augmentedPath, childEnv, findBinary, runCli, tail } from "./adapters/cli";
import { CODEX_CANDIDATES } from "./adapters/codex";
import { mergeRefreshed, needsRefresh, parseCredential, singleFlight, type ClaudeCredential, type TokenResponse } from "./claude-credential";

export type { ClaudeCredential };

export type LoginRuntime = "claude-code" | "codex";
/** Pre-refresh format: a bare access token and nothing to renew it with. */
export const CLAUDE_TOKEN_SECRET_ID = "claude-code-oauth-token";
/** Current format: the whole credential, as JSON. */
export const CLAUDE_CRED_SECRET_ID = "claude-code-oauth";



/* ---- Claude Code OAuth constants (same public client the CLI uses) ---- */
const CLAUDE_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  tokenUrl: "https://api.anthropic.com/v1/oauth/token",
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  scope: "user:inference",
};

export type LoginSession = {
  id: string;
  runtime: LoginRuntime;
  status: "starting" | "awaiting-browser" | "awaiting-code" | "exchanging" | "completed" | "failed" | "cancelled";
  url?: string;
  /** Codex: the one-time device code to enter in the browser. */
  code?: string;
  message?: string;
  startedAt: string;
  updatedAt: string;
};

type Internal = LoginSession & {
  child?: ChildProcess;
  output: string;
  /** Claude PKCE material. */
  verifier?: string;
  state?: string;
};

/* ---------- the stored credential ---------- */

export function readClaudeCredential(): ClaudeCredential | null {
  const cred = parseCredential(getSecret(CLAUDE_CRED_SECRET_ID), getSecret(CLAUDE_TOKEN_SECRET_ID));
  // migrate the old shape in place, so an upgrade never logs the owner out
  if (cred && getSecret(CLAUDE_TOKEN_SECRET_ID)) writeClaudeCredential(cred);
  return cred;
}

export function writeClaudeCredential(cred: ClaudeCredential | null): void {
  if (!cred) {
    deleteSecret(CLAUDE_CRED_SECRET_ID);
    deleteSecret(CLAUDE_TOKEN_SECRET_ID);
    return;
  }
  putSecret(JSON.stringify(cred), CLAUDE_CRED_SECRET_ID);
  // the new copy is on disk before the old one goes: one credential at rest, not two
  if (getSecret(CLAUDE_TOKEN_SECRET_ID)) deleteSecret(CLAUDE_TOKEN_SECRET_ID);
}

/* ---------- refresh ---------- */

/** Why the last refresh failed, for the owner-facing status line. Never a token. */
let lastRefreshError: string | null = null;
/**
 * One refresh at a time.
 *
 * The Director, a Builder and a Reviewer can all want a token in the same
 * instant. Refresh tokens rotate, so three simultaneous refreshes would race
 * and two of them would persist a refresh token the provider has already
 * replaced. The app is a single process, so one shared promise is the whole
 * lock that is needed.
 */
const refreshOnce = singleFlight<ClaudeCredential | null>();

async function refreshClaude(cred: ClaudeCredential): Promise<ClaudeCredential | null> {
  if (!cred.refresh) return cred;
  try {
    const res = await fetch(CLAUDE_OAUTH.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: cred.refresh, client_id: CLAUDE_OAUTH.clientId }),
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await res.text();
    let json: TokenResponse & { error?: string; error_description?: string } = {};
    try {
      json = JSON.parse(raw);
    } catch {
      /* non-JSON */
    }
    const next = res.ok ? mergeRefreshed(cred, json, Date.now()) : null;
    if (!next || next === cred) {
      lastRefreshError = json.error_description || json.error || `HTTP ${res.status}`;
      return cred;
    }
    writeClaudeCredential(next);
    lastRefreshError = null;
    return next;
  } catch (err) {
    // a network blip must not throw away a credential that still works
    lastRefreshError = String(err instanceof Error ? err.message : err).slice(0, 200);
    return cred;
  }
}

/**
 * A usable access token, renewed if it would not survive the work it is for.
 *
 * `needMs` is how long the caller expects to be using it — a turn's timeout.
 */
export async function claudeAccessToken(needMs = 0): Promise<string | null> {
  const cred = readClaudeCredential();
  if (!cred) return null;
  if (!needsRefresh(cred, needMs, Date.now())) return cred.access;
  const fresh = await refreshOnce(() => refreshClaude(cred));
  return fresh?.access ?? cred.access;
}

const sessions = new Map<string, Internal>();
const SESSION_TTL_MS = 20 * 60 * 1000;

const b64url = (b: Buffer) => b.toString("base64url");

const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[78=>]/g, "")
    .replace(/\r/g, "");

function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  try {
    if (pid) process.kill(-pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null && pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 3000).unref();
}

function publicView(s: Internal): LoginSession {
  const { child: _c, output: _o, verifier: _v, state: _st, ...rest } = s;
  void _c;
  void _o;
  void _v;
  void _st;
  return rest;
}

function touch(s: Internal, patch: Partial<LoginSession>) {
  Object.assign(s, patch, { updatedAt: new Date().toISOString() });
}

export function listSessions(): LoginSession[] {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - Date.parse(s.startedAt) > SESSION_TTL_MS) {
      if (!["completed", "failed", "cancelled"].includes(s.status)) {
        if (s.child) killTree(s.child);
        touch(s, { status: "failed", message: "Login timed out" });
      }
      if (now - Date.parse(s.updatedAt) > SESSION_TTL_MS) sessions.delete(id);
    }
  }
  return [...sessions.values()].map(publicView);
}

export function getSession(id: string): LoginSession | null {
  const s = sessions.get(id);
  return s ? publicView(s) : null;
}

export function cancelSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  if (!["completed", "failed", "cancelled"].includes(s.status)) {
    if (s.child) killTree(s.child);
    touch(s, { status: "cancelled", message: "Cancelled" });
  }
}

function claudeBin() {
  return findBinary("claude", [process.env.CLAUDE_CODE_BIN ?? ""]);
}
function codexBin() {
  return findBinary("codex", CODEX_CANDIDATES);
}

export function startLogin(runtime: LoginRuntime): LoginSession {
  for (const s of sessions.values()) {
    if (s.runtime === runtime && !["completed", "failed", "cancelled"].includes(s.status)) return publicView(s);
  }
  return runtime === "claude-code" ? startClaudeLogin() : startCodexLogin();
}

/* ---------- Claude Code: native PKCE ---------- */

function startClaudeLogin(): LoginSession {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  const url =
    `${CLAUDE_OAUTH.authorizeUrl}?code=true&client_id=${CLAUDE_OAUTH.clientId}` +
    `&response_type=code&redirect_uri=${encodeURIComponent(CLAUDE_OAUTH.redirectUri)}` +
    `&scope=${encodeURIComponent(CLAUDE_OAUTH.scope)}&code_challenge=${challenge}` +
    `&code_challenge_method=S256&state=${state}`;
  const now = new Date().toISOString();
  const s: Internal = {
    id: randomUUID(),
    runtime: "claude-code",
    status: "awaiting-code",
    url,
    message: "Open the link, sign in, then paste the code shown on the page.",
    startedAt: now,
    updatedAt: now,
    output: "",
    verifier,
    state,
  };
  sessions.set(s.id, s);
  return publicView(s);
}

async function exchangeClaudeCode(s: Internal, pasted: string) {
  // The callback page shows "<code>#<state>"; accept either form.
  const [code, stateFromCode] = pasted.trim().split("#");
  touch(s, { status: "exchanging", message: "Exchanging code for a token…" });
  try {
    const res = await fetch(CLAUDE_OAUTH.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        state: stateFromCode ?? s.state,
        client_id: CLAUDE_OAUTH.clientId,
        redirect_uri: CLAUDE_OAUTH.redirectUri,
        code_verifier: s.verifier,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await res.text();
    let json: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string } = {};
    try {
      json = JSON.parse(raw);
    } catch {
      /* non-JSON */
    }
    if (!res.ok || !json.access_token) {
      const detail = json.error_description || json.error || raw.slice(0, 200);
      // Stay on awaiting-code so the owner can grab a fresh code and retry.
      touch(s, { status: "awaiting-code", message: `That code was rejected (${detail}). Codes expire fast — reload the link, sign in, and paste the new code.` });
      return;
    }
    writeClaudeCredential({
      access: json.access_token,
      refresh: json.refresh_token,
      expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
      obtainedAt: Date.now(),
    });
    lastRefreshError = null;
    touch(s, {
      status: "completed",
      message: json.refresh_token
        ? "Signed in. Nexora will keep this login renewed on its own."
        : "Signed in — but the provider returned no refresh token, so this login will need repeating when it expires.",
    });
  } catch (err) {
    touch(s, { status: "awaiting-code", message: `Token exchange failed: ${String(err)}. Try pasting a fresh code.` });
  }
}

/* ---------- Codex: device-auth under a pty ---------- */

function ptyArgs(cmd: string[]): { bin: string; args: string[] } {
  if (process.platform === "linux" && findBinary("script")) {
    const quoted = cmd.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    return { bin: "script", args: ["-q", "-e", "-c", quoted, "/dev/null"] };
  }
  return { bin: "python3", args: ["-c", "import pty,sys; sys.exit(pty.spawn(sys.argv[1:]) and 1)", ...cmd] };
}

function startCodexLogin(): LoginSession {
  const bin = codexBin();
  if (!bin) throw new Error("Codex CLI not found on this server");
  const { bin: pty, args } = ptyArgs([bin, "login", "--device-auth"]);
  const env = childEnv({ TERM: "xterm-256color", COLUMNS: "200", LINES: "50" });
  const child = spawn(/*turbopackIgnore: true*/ pty, args, {
    env: { ...env, PATH: augmentedPath() } as unknown as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const now = new Date().toISOString();
  const s: Internal = { id: randomUUID(), runtime: "codex", status: "starting", startedAt: now, updatedAt: now, child, output: "" };
  sessions.set(s.id, s);

  const onData = (d: Buffer) => {
    s.output += d.toString();
    if (s.output.length > 200_000) s.output = s.output.slice(-100_000);
    const clean = stripAnsi(s.output);
    const url = clean.match(/https:\/\/auth\.openai\.com\/[^\s]+/)?.[0];
    const code = clean.match(/\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\b/)?.[1];
    if (url && code && s.status === "starting") touch(s, { status: "awaiting-browser", url, code });
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (err) => touch(s, { status: "failed", message: String(err) }));
  child.on("close", async (exitCode) => {
    if (["completed", "cancelled"].includes(s.status)) return;
    const st = await codexStatus();
    if (st.loggedIn) touch(s, { status: "completed", message: "Codex is logged in." });
    else touch(s, { status: "failed", message: exitCode === 0 ? "Login ended without a stored session" : tail(stripAnsi(s.output).trim(), 400) || `Codex exited with code ${exitCode}` });
  });
  return publicView(s);
}

export function submitCode(id: string, code: string): LoginSession {
  const s = sessions.get(id);
  if (!s) throw new Error("Login session not found");
  if (s.runtime !== "claude-code") throw new Error("This login does not take a pasted code");
  if (s.status !== "awaiting-code") throw new Error(`Login is ${s.status}`);
  void exchangeClaudeCode(s, code);
  touch(s, { status: "exchanging", message: "Exchanging code for a token…" });
  return publicView(s);
}

/* ---------- status / logout ---------- */

export type RuntimeLoginStatus = { loggedIn: boolean; detail?: string; method?: string; installed: boolean; /** epoch ms, when known */ expiresAt?: number };

export async function claudeStatus(): Promise<RuntimeLoginStatus> {
  const bin = claudeBin();
  if (!bin) return { loggedIn: false, installed: false, detail: "Claude Code CLI not found" };
  const cred = readClaudeCredential();
  // ask for a token the way a turn would, so status reflects a renewed login
  const token = await claudeAccessToken();
  const env = childEnv(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {});
  const r = await runCli(bin, ["auth", "status", "--json"], { env, timeoutMs: 20_000 });
  const fresh = token ? readClaudeCredential() : cred;
  const life = () => {
    if (!fresh) return "";
    if (!fresh.refresh) return " · will need signing in again when it expires (no refresh token)";
    if (!fresh.expiresAt) return " · renewed automatically";
    const mins = Math.round((fresh.expiresAt - Date.now()) / 60_000);
    return ` · renews automatically, this token valid ${mins > 0 ? `${mins} min` : "now expired"}`;
  };
  /*
   * `claude auth status` reports that a credential is configured, not that it
   * works — it answers loggedIn:true for a token the provider would reject.
   * The expiry we now keep is the one thing here that can actually contradict
   * it, so a credential that is past its expiry and has nothing to renew it
   * with is reported for what it is.
   */
  const dead = !!fresh?.expiresAt && fresh.expiresAt <= Date.now();
  try {
    const j = JSON.parse(r.stdout.trim()) as { loggedIn?: boolean; email?: string; authMethod?: string; subscriptionType?: string };
    const who = [j.email, j.subscriptionType].filter(Boolean).join(" · ");
    if (dead) return { loggedIn: false, installed: true, method: "web token", expiresAt: fresh?.expiresAt, detail: `This login expired and could not be renewed${lastRefreshError ? ` (${lastRefreshError})` : ""} — sign in again.` };
    return {
      loggedIn: !!j.loggedIn,
      installed: true,
      method: token ? "web token" : j.authMethod,
      expiresAt: fresh?.expiresAt,
      detail: j.loggedIn
        ? `${who || (token ? "Signed in with a web token" : "Logged in")}${life()}${lastRefreshError ? ` · last renewal failed: ${lastRefreshError}` : ""}`
        : "Not logged in",
    };
  } catch {
    /*
     * Holding a token is not the same as being signed in.
     *
     * This used to answer `loggedIn: !!token`, so an expired credential still
     * showed a green dot and "Signed in" while every agent turn was failing
     * with a 401. If the status cannot be read, say so.
     */
    return {
      loggedIn: false,
      installed: true,
      expiresAt: fresh?.expiresAt,
      detail: tail(r.stderr || r.stdout, 200) || (token ? "A credential is stored, but its status could not be read" : "Not logged in"),
    };
  }
}

export async function codexStatus(): Promise<RuntimeLoginStatus> {
  const bin = codexBin();
  if (!bin) return { loggedIn: false, installed: false, detail: "Codex CLI not found" };
  const r = await runCli(bin, ["login", "status"], { env: childEnv(), timeoutMs: 20_000 });
  const text = (r.stdout + r.stderr).trim();
  const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
  return { loggedIn, installed: true, detail: text.split("\n")[0] || (loggedIn ? "Logged in" : "Not logged in") };
}

export async function logout(runtime: LoginRuntime): Promise<void> {
  if (runtime === "claude-code") {
    writeClaudeCredential(null);
    lastRefreshError = null;
    const bin = claudeBin();
    if (bin) await runCli(bin, ["auth", "logout"], { env: childEnv(), timeoutMs: 20_000 });
  } else {
    const bin = codexBin();
    if (bin) await runCli(bin, ["logout"], { env: childEnv(), timeoutMs: 20_000 });
  }
}
