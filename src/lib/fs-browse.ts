/* ------------------------------------------------------------------
   Directory browsing for the owner's own UI.

   Work can be pinned to a folder: the agent's CLI runtime then runs there
   instead of in its private workspace, which is how a task gets a real
   repository or project directory to work in (the same idea as a Tandem
   project root). The owner is the only one who browses — agents never see
   this, they are simply started in the folder they were given.
   ------------------------------------------------------------------ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKSPACES_DIR } from "@/lib/store/db";

export type DirEntry = { name: string; path: string };
export type DirListing = {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
  /** the handful of places worth starting from on this machine */
  quickLinks: DirEntry[];
  writable: boolean;
  /** how many entries were hidden (dot directories, node_modules, overflow) */
  hidden: number;
};

const NOISE = new Set(["node_modules", ".git", ".next", "__pycache__", "venv", ".venv"]);
const MAX = 400;

export function quickLinks(): DirEntry[] {
  const home = os.homedir();
  // ordered by how often they are the right answer: a task usually belongs to a
  // real project directory, not to an agent's private workspace
  return [
    { name: "Projects", path: path.join(home, "projects") },
    { name: "Home", path: home },
    { name: "/opt", path: "/opt" },
    { name: "/srv", path: "/srv" },
    { name: "Agent workspaces", path: WORKSPACES_DIR },
    { name: "Root", path: "/" },
  ].filter((l) => {
    try { return fs.statSync(l.path).isDirectory(); } catch { return false; }
  });
}

export function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function listDir(input: string): DirListing {
  if (!path.isAbsolute(input)) throw new Error("A folder path must be absolute, for example /opt/myproject.");
  const dir = path.resolve(input);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT" ? `${dir} does not exist.`
      : code === "EACCES" ? `${dir} cannot be read (permission denied).`
      : code === "ENOTDIR" ? `${dir} is a file, not a folder.`
      : `${dir} could not be read.`
    );
  }
  const all = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !NOISE.has(e.name));
  const dirs = all
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX);
  return {
    path: dir,
    parent: dir === path.parse(dir).root ? null : path.dirname(dir),
    dirs,
    quickLinks: quickLinks(),
    writable: isWritable(dir),
    hidden: entries.filter((e) => e.isDirectory()).length - dirs.length,
  };
}

/** One new folder inside an existing one. No paths, no nesting, no surprises. */
export function makeDir(parent: string, name: string): DirEntry {
  if (!path.isAbsolute(parent)) throw new Error("The parent folder must be an absolute path.");
  // agents run shell commands inside this folder, so the name stays plain:
  // letters, digits, dash, underscore and dot, and nothing that needs quoting
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+/, "").replace(/-+$/g, "-").slice(0, 80);
  if (!clean) throw new Error("Give the folder a name using letters or digits.");
  const parentDir = path.resolve(parent);
  if (!fs.existsSync(parentDir)) throw new Error(`${parentDir} does not exist.`);
  if (!isWritable(parentDir)) throw new Error(`${parentDir} is not writable.`);
  const target = path.join(parentDir, clean);
  if (fs.existsSync(target)) throw new Error(`“${clean}” already exists here.`);
  fs.mkdirSync(target, { recursive: false });
  return { name: clean, path: target };
}

/** A folder name from a task title: "Fix the login issue" → "fix-the-login-issue". */
export function folderNameFor(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "task";
}

/** The folder a task will actually run in, validated at assignment time. */
export function assertUsableFolder(dir: string): string {
  if (!path.isAbsolute(dir)) throw new Error("A folder path must be absolute, for example /opt/myproject.");
  const resolved = path.resolve(dir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`${resolved} does not exist. Create it first, or pick another folder.`);
  }
  if (!stat.isDirectory()) throw new Error(`${resolved} is a file, not a folder.`);
  return resolved;
}
