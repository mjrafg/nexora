#!/usr/bin/env node
/* ------------------------------------------------------------------
   A plan review leaves a record.

   A review of a plan or a recovery decision is a real turn by the
   Reviewer, but it belongs to no session and to no Director reply — so
   its steps had nowhere to live, and the project showed a verdict with
   nothing behind it. This drives a real plan review and reads the
   record back off disk.

     node scripts/test-review-record.mjs [baseUrl] [--keep]
   ------------------------------------------------------------------ */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BASE = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:3111";
const KEEP = process.argv.includes("--keep");
const USER = process.env.NEXORA_USER || "mjrafg";
const DATA_DIR = process.env.NEXORA_DATA_DIR || path.join(process.cwd(), "data");
const TOKEN = fs.readFileSync(path.join(DATA_DIR, "internal-token"), "utf8").trim();

function requirePassword() {
  const p = process.env.NEXORA_PASS;
  if (!p) throw new Error("Set NEXORA_PASS (the owner password for the Nexora instance you are testing).");
  return p;
}
let cookie = "";
async function api(url, body, method = body ? "POST" : "GET") {
  const r = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error ?? ""}`);
  return j;
}
const director = async (projectId, op, args = {}) => {
  const r = await fetch(`${BASE}/api/internal/director`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN, projectId, op, args }) });
  return r.json();
};
const store = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push(true); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push(false); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 300)}`); }
}

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: requirePassword() }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const cat = await api("/api/catalog");
const conns = (await api("/api/providers")).connections;
let runtime = null;
for (const o of [
  { runtimeType: "claude-code", providerConnectionId: "conn-anthropic", model: cat.defaults?.model ?? "claude-haiku-4-5" },
  { runtimeType: "codex", providerConnectionId: "conn-openai", model: cat.defaults?.codexModel ?? "gpt-5-codex" },
].filter((o) => conns.some((c) => c.id === o.providerConnectionId))) {
  const { agent } = await api("/api/agents", { name: `REV probe ${Date.now().toString(36).slice(-5)}`, role: "Analyst", dept: "operations", toolPermissions: [], instructions: "Answer briefly.", runtime: o });
  const t = await api(`/api/agents/${agent.id}/test`, { message: "Reply with the single word ready." }).catch((e) => ({ ok: false, message: String(e.message) }));
  await api(`/api/agents/${agent.id}`, null, "DELETE").catch(() => {});
  console.log(`  ${o.runtimeType}/${o.model}: ${t.ok ? "available" : `unavailable — ${String(t.message).slice(0, 70)}`}`);
  if (t.ok) { runtime = o; break; }
}
assert(runtime, "no CLI runtime is available — a plan review cannot run");

const tag = Date.now().toString(36).slice(-5);
const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexora-rev-${tag}-`));
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
fs.writeFileSync(path.join(root, "README.md"), "# review record test\n");
git("init", "-q", "-b", "main"); git("config", "user.email", "r@nexora.local"); git("config", "user.name", "review test");
git("add", "-A"); git("commit", "-qm", "start");

const made = [];
const mk = async (name, role, perms) => {
  const { agent } = await api("/api/agents", { name, role, dept: "engineering", toolPermissions: perms, instructions: "Do the work you are given.", runtime });
  made.push(agent.id); return agent;
};

let projectId = null;
try {
  const dir = await mk(`REV Director ${tag}`, "Project Director", ["read_files"]);
  const bld = await mk(`REV Builder ${tag}`, "Engineer", ["read_files", "write_files"]);
  const rev = await mk(`REV Reviewer ${tag}`, "Reviewer", ["read_files"]);
  const { project } = await api("/api/projects", { title: `Review record ${tag}`, rootPath: root, goal: "Check that a plan review leaves a record.", directorAgentId: dir.id, builderAgentId: bld.id, reviewerAgentId: rev.id });
  projectId = project.id;

  // set_plan runs the independent plan review — a Reviewer turn owned by no session
  await director(projectId, "set_plan", {
    summary: "One milestone: write a short note explaining the repository.",
    milestones: [{ key: "M1", name: "Explain the repo", goal: "Add NOTES.md describing what this repository is.", acceptance: "NOTES.md exists and is accurate.", depends_on: [] }],
  });

  const reviews = () => store().projectActivity.filter((a) => a.projectId === projectId && a.kind === "review");
  for (let i = 0; i < 90 && !reviews().some((a) => /accepted|findings returned|could not run/.test(a.text)); i++) await sleep(2_000);
  const verdictLine = reviews().find((a) => /accepted|findings returned/.test(a.text));
  assert(verdictLine, `the plan review never produced a verdict: ${reviews().map((a) => a.text).join(" | ") || "(nothing)"}`);
  console.log(`  verdict: ${verdictLine.text}`);

  await test("the review's verdict carries what the Reviewer actually did", async () => {
    assert(verdictLine.steps?.length, "the verdict line has no steps");
    const kinds = [...new Set(verdictLine.steps.map((e) => e.kind))];
    return `${verdictLine.steps.length} steps · kinds: ${kinds.join(", ")}`;
  });

  await test("every step names the Reviewer that produced it", async () => {
    const byAgent = verdictLine.steps.filter((e) => e.actor);
    assert(byAgent.length, "no step names an actor");
    assert(byAgent.every((e) => e.actor.role === "Reviewer"), `a non-Reviewer step was kept: ${[...new Set(byAgent.map((e) => e.actor.role))]}`);
    return `${byAgent.length} by ${[...new Set(byAgent.map((e) => e.actor.name))].join(", ")}`;
  });

  await test("it reaches the page and the export", async () => {
    const d = await api(`/api/projects/${projectId}`);
    const line = (d.activity ?? []).find((a) => a.id === verdictLine.id);
    assert(line?.steps?.length, "the project view does not carry the review's steps");
    const md = await (await fetch(`${BASE}/api/projects/${projectId}/export?format=markdown`, { headers: { cookie } })).text();
    assert(md.includes("(Reviewer)"), "the export does not carry the review's steps");
    return `${line.steps.length} steps in the view · export ${md.length} chars`;
  });

  await test("it survives a restart, being on disk rather than in the bus", async () => {
    const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"))
      .projectActivity.find((a) => a.id === verdictLine.id);
    assert(onDisk?.steps?.length, "the steps are not in the persisted store");
    return `${onDisk.steps.length} steps readable from disk`;
  });

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
} finally {
  if (!KEEP) {
    if (projectId) await api(`/api/projects/${projectId}`, null, "DELETE").catch(() => {});
    for (const p of (await api("/api/projects").catch(() => ({ projects: [] }))).projects ?? []) {
      if (p.rootPath === root) await api(`/api/projects/${p.id}`, null, "DELETE").catch(() => {});
    }
    for (const id of made) await api(`/api/agents/${id}`, null, "DELETE").catch(() => {});
    for (const d of [root, path.join(path.dirname(root), ".nexora-worktrees")]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
    console.log("cleaned up");
  } else console.log(`kept: project ${projectId} · repo ${root}`);
}
process.exit(results.every(Boolean) ? 0 : 1);
