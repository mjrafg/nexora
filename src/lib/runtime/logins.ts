/* ------------------------------------------------------------------
   Web-driven logins for the CLI runtimes.

   Claude Code: native OAuth (PKCE). We build the same authorize URL the
                `claude` CLI uses, the owner signs in and pastes the returned
                code, and we exchange it for a long-lived token at
                api.anthropic.com. The token is stored as a secret and injected
                as CLAUDE_CODE_OAUTH_TOKEN when the runtime spawns `claude`.
   Codex:       `codex login --device-auth` under a pseudo-terminal → prints a
                URL + one-time code; the owner enters it in the browser and the
                CLI persists ~/.codex/auth.json.
   ------------------------------------------------------------------ */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { deleteSecret, getSecret, putSecret } from "@/lib/store/db";
import { augmentedPath, childEnv, findBinary, runCli, tail } from "./adapters/cli";
import { CODEX_CANDIDATES } from "./adapters/codex";

export type LoginRuntime = "claude-code" | "codex";
export const CLAUDE_TOKEN_SECRET_ID = "claude-code-oauth-token";

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
    let json: { access_token?: string; refresh_token?: string; error?: string; error_description?: string } = {};
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
    putSecret(json.access_token, CLAUDE_TOKEN_SECRET_ID);
    touch(s, { status: "completed", message: "Signed in. Claude Code will use this token from now on." });
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

export type RuntimeLoginStatus = { loggedIn: boolean; detail?: string; method?: string; installed: boolean };

export async function claudeStatus(): Promise<RuntimeLoginStatus> {
  const bin = claudeBin();
  if (!bin) return { loggedIn: false, installed: false, detail: "Claude Code CLI not found" };
  const token = getSecret(CLAUDE_TOKEN_SECRET_ID);
  const env = childEnv(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {});
  const r = await runCli(bin, ["auth", "status", "--json"], { env, timeoutMs: 20_000 });
  try {
    const j = JSON.parse(r.stdout.trim()) as { loggedIn?: boolean; email?: string; authMethod?: string; subscriptionType?: string };
    const who = [j.email, j.subscriptionType].filter(Boolean).join(" · ");
    return {
      loggedIn: !!j.loggedIn,
      installed: true,
      method: token ? "web token" : j.authMethod,
      detail: j.loggedIn ? who || (token ? "Signed in with a web token" : "Logged in") : "Not logged in",
    };
  } catch {
    return { loggedIn: !!token, installed: true, detail: token ? "Web token stored" : tail(r.stderr || r.stdout, 200) || "Not logged in" };
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
    deleteSecret(CLAUDE_TOKEN_SECRET_ID);
    const bin = claudeBin();
    if (bin) await runCli(bin, ["auth", "logout"], { env: childEnv(), timeoutMs: 20_000 });
  } else {
    const bin = codexBin();
    if (bin) await runCli(bin, ["logout"], { env: childEnv(), timeoutMs: 20_000 });
  }
}
