/* ------------------------------------------------------------------
   Git plumbing for project runs (ported from Tandem's director/engine.ts +
   gitFlow.ts, simplified): integration branch, per-session worktrees,
   dependency merges, checkpoints, fast-forward delivery, cleanup.
   ------------------------------------------------------------------ */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function git(dir: string, args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    let out = "";
    let err = "";
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ ok: false, stdout: out, stderr: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, stdout: out.trim(), stderr: err.trim() });
    });
  });
}

export async function isRepo(dir: string): Promise<boolean> {
  return (await git(dir, ["rev-parse", "--is-inside-work-tree"])).ok;
}

export async function currentBranch(dir: string): Promise<string | null> {
  const r = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok && r.stdout !== "HEAD" ? r.stdout : null;
}

export async function hasCommits(dir: string): Promise<boolean> {
  return (await git(dir, ["rev-parse", "--verify", "HEAD"])).ok;
}

/** Initialize a repo with a baseline commit when the directory is not one yet. */
export async function ensureRepo(dir: string): Promise<void> {
  if (await isRepo(dir)) {
    if (!(await hasCommits(dir))) {
      await git(dir, ["add", "-A"]);
      await git(dir, ["-c", "user.name=Nexora OS", "-c", "user.email=nexora@agent24.io", "commit", "--allow-empty", "-m", "nexora: baseline"]);
    }
    return;
  }
  const init = await git(dir, ["init", "-q"]);
  if (!init.ok) throw new Error(`git init failed: ${init.stderr}`);
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.name=Nexora OS", "-c", "user.email=nexora@agent24.io", "commit", "--allow-empty", "-m", "nexora: baseline"]);
}

export function integrationBranchName(projectId: string): string {
  return `nexora/${projectId.slice(0, 8)}/integration`;
}

/** Create the integration branch off the current base branch if missing; returns {integration, base}. */
export async function ensureIntegrationBranch(dir: string, projectId: string): Promise<{ integration: string; base: string | null }> {
  await ensureRepo(dir);
  const integration = integrationBranchName(projectId);
  const base = await currentBranch(dir);
  const exists = (await git(dir, ["rev-parse", "--verify", `refs/heads/${integration}`])).ok;
  if (!exists) {
    const r = await git(dir, ["branch", integration]);
    if (!r.ok) throw new Error(`Could not create ${integration}: ${r.stderr}`);
  }
  return { integration, base: base && base !== integration ? base : null };
}

export function worktreeDir(rootPath: string, projectId: string, key: string): string {
  return path.join(path.dirname(rootPath), ".nexora-worktrees", `${path.basename(rootPath)}-${projectId.slice(0, 8)}`, key.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
}

export function sessionBranchName(projectId: string, key: string): string {
  return `nexora/${projectId.slice(0, 8)}/${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** Ensure an isolated worktree for a session branch (created off the integration branch). */
export async function ensureWorktree(rootPath: string, dir: string, branch: string, integration: string): Promise<void> {
  if (fs.existsSync(path.join(dir, ".git"))) return;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const exists = (await git(rootPath, ["rev-parse", "--verify", `refs/heads/${branch}`])).ok;
  const r = exists
    ? await git(rootPath, ["worktree", "add", dir, branch], 60_000)
    : await git(rootPath, ["worktree", "add", dir, "-b", branch, integration], 60_000);
  if (!r.ok) throw new Error(`Could not create the session worktree: ${r.stderr}`);
}

/** Merge completed dependency branches into a session's checkout; returns what was merged. */
export async function mergeDependencyBranches(dir: string, branches: string[]): Promise<string[]> {
  const merged: string[] = [];
  for (const b of branches) {
    const already = await git(dir, ["merge-base", "--is-ancestor", b, "HEAD"]);
    if (already.ok) continue;
    const m = await git(dir, ["-c", "user.name=Nexora OS", "-c", "user.email=nexora@agent24.io", "merge", "--no-edit", b], 60_000);
    if (!m.ok) {
      await git(dir, ["merge", "--abort"]);
      throw new Error(`Dependency branch ${b} does not merge cleanly: ${m.stderr.slice(-300)}`);
    }
    merged.push(b);
  }
  return merged;
}

/**
 * Commit whatever a session left behind, so work is never lost.
 *
 * The subject names the session. It used to be the first 72 characters of the
 * Builder's brief, which for an integration session produced commits titled
 * "nexora: This is a milestone INTEGRATION session. You are on the project
 * integrat" — prompt text in the project's permanent history.
 *
 * `add -A` is deliberate: a half-finished change the agent did not commit is
 * still work, and losing it is worse than committing it. What it sweeps is
 * reported back so delivery can question anything that arrived this way.
 */
export async function checkpoint(
  dir: string,
  label: string,
  /**
   * Absolute paths the session's agent actually wrote, from its own recorded
   * file steps. When given, untracked files outside it are left alone.
   *
   * A checkpoint used to `git add -A`, which is how a test server's `server.log`
   * ended up committed to the integration branch and cost a whole cleanup
   * session to remove. An untracked file nobody wrote through a file tool and
   * nobody staged is not this session's work — it is what running the work left
   * behind. Omit the set (no step record available) and the old sweep-everything
   * behaviour stands, so a missing record can never silently lose real work.
   */
  wroteFiles?: string[],
): Promise<{ hash: string; swept: string[]; left: string[] } | null> {
  const pending = await git(dir, ["status", "--porcelain"]);
  if (!pending.stdout.trim()) return null;
  // files the agent never staged itself — the ones worth questioning later
  const untracked = pending.stdout
    .split("\n")
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);

  let swept = untracked;
  let left: string[] = [];
  if (wroteFiles) {
    const owned = new Set(wroteFiles.map((f) => path.relative(dir, path.resolve(dir, f))));
    const mine = (f: string) => owned.has(f.replace(/\/$/, "")) || [...owned].some((o) => o.startsWith(`${f.replace(/\/$/, "")}/`));
    swept = untracked.filter(mine);
    left = untracked.filter((f) => !mine(f));
  }

  // tracked edits and deletions always belong to the session; untracked files
  // only when the agent wrote them
  await git(dir, ["add", "-u"]);
  for (const f of swept) await git(dir, ["add", "--", f]);
  const staged = await git(dir, ["diff", "--cached", "--name-only"]);
  if (!staged.stdout.trim()) return null;

  const msg = `nexora: checkpoint ${label.replace(/\s+/g, " ").trim().slice(0, 60) || "session"}`;
  const c = await git(dir, ["-c", "user.name=Nexora OS", "-c", "user.email=nexora@agent24.io", "commit", "-q", "-m", msg]);
  if (!c.ok) return null;
  const hash = (await git(dir, ["rev-parse", "--short", "HEAD"])).stdout || null;
  return hash ? { hash, swept, left } : null;
}

/**
 * Files on `branch` whose every commit was made by the engine's checkpoint.
 *
 * A file the agent committed itself was a deliberate act. A file that only
 * ever arrived because a checkpoint swept the working tree may be a scratch
 * artifact — a note the session wrote to itself — and should be looked at
 * before it ships. This is evidence from history, not a guess from a filename.
 */
export async function checkpointOnlyFiles(dir: string, branch: string): Promise<string[]> {
  const listed = await git(dir, ["ls-tree", "-r", "--name-only", branch]);
  if (!listed.ok) return [];
  const out: string[] = [];
  for (const file of listed.stdout.split("\n").map((f) => f.trim()).filter(Boolean)) {
    const authors = await git(dir, ["log", "--format=%an", branch, "--", file]);
    if (!authors.ok) continue;
    const who = authors.stdout.split("\n").map((a) => a.trim()).filter(Boolean);
    if (who.length && who.every((a) => a === "Nexora OS")) out.push(file);
  }
  return out;
}

export type WorktreeSnapshot = { porcelain: string; head: string };

export async function snapshot(dir: string): Promise<WorktreeSnapshot> {
  const [p, h] = await Promise.all([git(dir, ["status", "--porcelain"]), git(dir, ["rev-parse", "HEAD"])]);
  return { porcelain: p.stdout, head: h.stdout };
}

/** Files changed between two snapshots (uncommitted delta + commits made). */
export async function changedFiles(dir: string, before: WorktreeSnapshot, after: WorktreeSnapshot): Promise<{ files: string[]; note: string }> {
  const files = new Set<string>();
  for (const line of after.porcelain.split("\n")) if (line.trim()) files.add(line.trim());
  let note = "Uncommitted changes per `git status --porcelain` (status + path):";
  if (before.head && after.head && before.head !== after.head) {
    const diff = await git(dir, ["diff", "--name-status", `${before.head}..${after.head}`]);
    for (const line of diff.stdout.split("\n")) if (line.trim()) files.add(line.trim());
    note = "Changes committed during the run plus any uncommitted changes (status + path):";
  }
  return { files: [...files].slice(0, 200), note };
}

export async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(dir, ["merge-base", "--is-ancestor", ancestor, descendant])).ok;
}

/** Deliver: fast-forward base to integration and check base out. */
export async function deliver(rootPath: string, integration: string, base: string): Promise<{ ok: boolean; message: string }> {
  if (await isAncestor(rootPath, integration, base)) {
    const co = await git(rootPath, ["checkout", base]);
    return co.ok ? { ok: true, message: `${base} already contains ${integration}. The repository is on ${base}.` } : { ok: false, message: `Could not switch to ${base}: ${co.stderr}` };
  }
  if (!(await isAncestor(rootPath, base, integration))) {
    return { ok: false, message: `${base} has commits that are not on ${integration} — a fast-forward is impossible. Launch a reconciliation session to merge ${integration} into ${base}, then deliver again.` };
  }
  const co = await git(rootPath, ["checkout", base]);
  if (!co.ok) return { ok: false, message: `Could not switch to ${base}: ${co.stderr} — likely uncommitted local changes.` };
  const ff = await git(rootPath, ["merge", "--ff-only", integration]);
  if (!ff.ok) return { ok: false, message: `Fast-forward failed: ${ff.stderr}` };
  return { ok: true, message: `Delivered — ${base} now equals ${integration}, and the repository is checked out on ${base}.` };
}

export async function removeWorktree(rootPath: string, dir: string): Promise<void> {
  await git(rootPath, ["worktree", "remove", "--force", dir]);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* gone */
  }
  await git(rootPath, ["worktree", "prune"]);
}
