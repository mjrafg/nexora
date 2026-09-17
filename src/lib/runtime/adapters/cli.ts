/* Shared helpers for CLI-backed runtimes (Claude Code, Codex). */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scrubAgentEnv } from "../child-env";
import type { HistoryTurn } from "../types";

export type Env = Record<string, string | undefined>;
import { WORKSPACES_DIR } from "@/lib/store/db";

const EXTRA_PATHS = [
  path.join(os.homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

export function augmentedPath(): string {
  const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return [...new Set([...current, ...EXTRA_PATHS])].join(path.delimiter);
}

/** Find an executable by name on the augmented PATH or in explicit candidate paths. */
export function findBinary(name: string, candidates: string[] = []): string | null {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  for (const dir of augmentedPath().split(path.delimiter)) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

export function runCli(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: Env; input?: string; timeoutMs?: number; onLine?: (line: string) => void; onSpawn?: (kill: () => void) => void } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const env = { ...(opts.env ?? process.env), PATH: augmentedPath() } as unknown as NodeJS.ProcessEnv;
    const child = spawn(bin, args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    opts.onSpawn?.(() => child.kill("SIGTERM"));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs ?? 300_000);

    let lineBuf = "";
    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (opts.onLine) {
        lineBuf += chunk;
        let i;
        while ((i = lineBuf.indexOf("\n")) !== -1) {
          const line = lineBuf.slice(0, i);
          lineBuf = lineBuf.slice(i + 1);
          if (line.trim()) opts.onLine(line);
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** Child env: inherit, but never leak the parent Claude Code session markers. */
export function childEnv(extra: Env = {}): Env {
  const env: Env = { ...process.env, ...extra };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return scrubAgentEnv(env);
}

export function agentWorkspace(agentId: string, override?: string): string {
  const dir = override && override.trim() ? path.resolve(override) : path.join(WORKSPACES_DIR, agentId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Render prior conversation so a fresh CLI session can continue it. */
export function renderTranscript(history: HistoryTurn[], message: string, speaker = "Owner"): string {
  if (history.length === 0) return message;
  const lines = history.map((t) => `${t.role === "user" ? speaker : "You"}: ${t.content}`);
  return [
    "Here is the conversation so far between you and the company owner. Continue it naturally; reply only to the latest message.",
    "",
    "<conversation>",
    ...lines,
    "</conversation>",
    "",
    `${speaker}: ${message}`,
  ].join("\n");
}

export function tail(s: string, n = 800): string {
  return s.length > n ? "…" + s.slice(-n) : s;
}
