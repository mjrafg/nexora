/* ------------------------------------------------------------------
   A throwaway Nexora, built the way production is built.

   Some things can only be checked against the real build — money, a
   restart, the exact configuration that ships — and none of them may be
   checked against the owner's data. So this starts a second Nexora from
   the same source, compiled with `next build` and served with
   `next start`, on a loopback-only port, against an empty data
   directory that is deleted afterwards.

   The copy lives inside the repository because Node resolves packages by
   walking up: a symlinked node_modules is rejected by Turbopack, and a
   second `next dev` in the same folder is refused outright.
   ------------------------------------------------------------------ */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startSandbox({ port = 3311, user = "sandbox", pass = "sandbox-pw", verbose = false } = {}) {
  const root = process.cwd();
  const app = path.join(root, ".nexora-sandbox");
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-sandbox-"));
  const base = `http://127.0.0.1:${port}`;
  const log = (...a) => console.log("[sandbox]", ...a);

  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });
  for (const f of ["package.json", "next.config.ts", "tsconfig.json", "postcss.config.mjs", "eslint.config.mjs", "next-env.d.ts"]) {
    if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(app, f));
  }
  for (const d of ["src", "public", "scripts"]) fs.cpSync(path.join(root, d), path.join(app, d), { recursive: true });
  spawnSync(process.execPath, ["scripts/set-user.mjs", user, pass], { cwd: root, env: { ...process.env, NEXORA_DATA_DIR: data }, stdio: "ignore" });

  log(`building the production bundle in ${path.basename(app)} …`);
  const built = spawnSync(path.join(root, "node_modules/.bin/next"), ["build"], {
    cwd: app,
    env: { ...process.env, NEXORA_DATA_DIR: data, NODE_ENV: "production" },
    encoding: "utf8",
  });
  if (built.status !== 0) {
    fs.writeFileSync(path.join(root, "sandbox-build.log"), `${built.stdout ?? ""}\n${built.stderr ?? ""}`);
    throw new Error(`the sandbox build failed — see sandbox-build.log`);
  }

  // everything the server says is kept, so a crash can be explained rather
  // than guessed at
  const logFile = path.join(data, "server.log");
  let child = null;
  const spawnServer = () => {
    const c = spawn(path.join(root, "node_modules/.bin/next"), ["start", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: app,
      env: { ...process.env, NEXORA_DATA_DIR: data, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (tag) => (b) => {
      fs.appendFileSync(logFile, `${tag} ${b}`);
      if (verbose) process.stdout.write(`${tag} ${b}`);
    };
    c.stdout.on("data", keep("[srv]"));
    c.stderr.on("data", keep("[srv!]"));
    c.on("exit", (code, signal) => fs.appendFileSync(logFile, `[srv] exited code=${code} signal=${signal}\n`));
    return c;
  };
  const up = async (ms = 90_000) => {
    for (let i = 0; i < ms / 400; i++) {
      try { const r = await fetch(`${base}/api/auth/me`); if (r.status === 200 || r.status === 401) return; } catch { /* not yet */ }
      await sleep(400);
    }
    throw new Error("the sandbox never came up");
  };
  const down = async () => {
    if (!child) return;
    child.kill("SIGTERM");
    for (let i = 0; i < 40 && child.exitCode === null && !child.signalCode; i++) await sleep(400);
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    for (let i = 0; i < 40; i++) {
      try { await fetch(`${base}/api/auth/me`); } catch { return; }
      await sleep(400);
    }
  };

  child = spawnServer();
  await up();
  log(`up on ${base} · data ${data}`);

  return {
    base,
    dataDir: data,
    logFile,
    /**
     * Is it still there? A single failed fetch is not an answer: a pooled
     * keep-alive socket that the server has already closed fails once and
     * succeeds on the retry, and calling that a dead server would make the
     * harness lie about the thing it exists to check.
     */
    async alive(tries = 3) {
      for (let i = 0; i < tries; i++) {
        try { const r = await fetch(`${base}/api/auth/me`); if (r.status === 200 || r.status === 401) return true; }
        catch { /* try again on a fresh socket */ }
        await sleep(500);
      }
      return false;
    },
    tail(lines = 25) {
      try { return fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-lines).join("\n"); }
      catch { return "(no server log)"; }
    },
    appDir: app,
    user,
    pass,
    /** Stop the way systemd stops it, then start again. */
    async restart() {
      log("stopping (SIGTERM) …");
      await down();
      log("starting again …");
      child = spawnServer();
      await up();
    },
    async stop({ keepData = false } = {}) {
      await down();
      fs.rmSync(app, { recursive: true, force: true });
      if (!keepData) fs.rmSync(data, { recursive: true, force: true });
      else log(`data kept at ${data}`);
      log("gone");
    },
  };
}

/** Sign in to a sandbox and return a fetch helper bound to it. */
export async function sandboxApi(sb) {
  const r = await fetch(`${sb.base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: sb.user, password: sb.pass }) });
  if (!r.ok) throw new Error(`sandbox login failed: ${r.status}`);
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  return async (url, body, method = body ? "POST" : "GET") => {
    const res = await fetch(`${sb.base}${url}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${j.error ?? ""}`);
    return j;
  };
}
