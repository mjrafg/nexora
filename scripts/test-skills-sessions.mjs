#!/usr/bin/env node
/* ------------------------------------------------------------------
   Skills through the real session pipeline.

   The Director's own tool calls are made here instead of by a model —
   not because the model cannot make them, but because on this host no
   runtime can currently call the Director's MCP tools (see the report).
   Everything BELOW that call is the shipped code: planSessions stores
   the selection, launchSession composes the Builder's turn, the review
   loop composes the Reviewer's, and a real model on a real repository
   does the work.

     node scripts/test-skills-sessions.mjs [baseUrl] [--keep]
   ------------------------------------------------------------------ */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** The owner password for the instance under test. Never hardcoded: a real
  * deployment's login must not live in source control. */
function requirePassword() {
  const p = process.env.NEXORA_PASS;
  if (!p) throw new Error("Set NEXORA_PASS (the owner password for the Nexora instance you are testing).");
  return p;
}


const BASE = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:3111";
const KEEP = process.argv.includes("--keep");
const USER = process.env.NEXORA_USER || "mjrafg";
const PASS = requirePassword();
const DATA_DIR = process.env.NEXORA_DATA_DIR || path.join(process.cwd(), "data");
const TOKEN = fs.readFileSync(path.join(DATA_DIR, "internal-token"), "utf8").trim();
let cookie = "";

async function api(url, body, method = body ? "POST" : "GET") {
  const r = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error ?? ""}`);
  return j;
}
/** The Director's own engine tools, called the way its MCP server calls them. */
const director = async (projectId, op, args = {}) => {
  const r = await fetch(`${BASE}/api/internal/director`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN, projectId, op, args }) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${op} -> ${j.error}`);
  return j;
};
const store = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push(true); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push(false); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 400)}`); }
}

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];

/* ---------------------------------------------------------------- a runtime that answers */
const cat = await api("/api/catalog");
const conns = (await api("/api/providers")).connections;
let runtime = null;
for (const o of [
  { runtimeType: "claude-code", providerConnectionId: "conn-anthropic", model: cat.defaults?.model ?? "claude-haiku-4-5" },
  { runtimeType: "codex", providerConnectionId: "conn-openai", model: cat.defaults?.codexModel ?? "gpt-5-codex" },
].filter((o) => conns.some((c) => c.id === o.providerConnectionId))) {
  const { agent } = await api("/api/agents", { name: `SKS probe ${Date.now().toString(36).slice(-5)}`, role: "Analyst", dept: "operations", toolPermissions: [], instructions: "Answer briefly.", runtime: o });
  const t = await api(`/api/agents/${agent.id}/test`, { message: "Reply with the single word ready." }).catch((e) => ({ ok: false, message: String(e.message) }));
  await api(`/api/agents/${agent.id}`, null, "DELETE").catch(() => {});
  console.log(`  ${o.runtimeType}/${o.model}: ${t.ok ? "available" : `unavailable — ${String(t.message).slice(0, 80)}`}`);
  if (t.ok) { runtime = o; break; }
}
assert(runtime, "no CLI runtime is available — the Builder cannot run");
console.log(`\n=== skills through the session pipeline · ${runtime.runtimeType}/${runtime.model}\n`);

const tag = Date.now().toString(36).slice(-5);
const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexora-sks-${tag}-`));
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
fs.writeFileSync(path.join(root, "index.html"), `<!doctype html>\n<title>Status</title>\n<div id="board"></div>\n`);
fs.writeFileSync(path.join(root, "notes.md"), `# Notes\n\nNothing yet.\n`);
git("init", "-q", "-b", "main");
git("config", "user.email", "sks@nexora.local");
git("config", "user.name", "Nexora skills session test");
git("add", "-A");
git("commit", "-qm", "the page as it stands");

const made = [];
const mk = async (name, role, perms, instructions) => {
  const { agent } = await api("/api/agents", { name, role, dept: "engineering", toolPermissions: perms, instructions, runtime });
  made.push(agent.id);
  return agent;
};

let projectId = null;
try {
  const dir = await mk(`SKS Director ${tag}`, "Project Director", ["read_files"], "You plan engineering projects.");
  const bld = await mk(`SKS Builder ${tag}`, "Engineer", ["read_files", "write_files", "run_commands"], "You build what the brief asks for and say plainly what you did.");
  const rev = await mk(`SKS Reviewer ${tag}`, "Reviewer", ["read_files"], "You review independently and report what is actually wrong.");
  const { project } = await api("/api/projects", {
    title: `Skills sessions ${tag}`, rootPath: root,
    goal: "Two small pieces of work on a static page.",
    directorAgentId: dir.id, builderAgentId: bld.id, reviewerAgentId: rev.id,
  });
  projectId = project.id;

  await director(projectId, "set_plan", {
    summary: "One milestone, three sessions: one that needs UI guidance, one clerical, one that needs nothing.",
    milestones: [{ key: "M1", name: "Status page and notes", goal: "Make the page usable and record who wrote it.", acceptance: "Both files updated.", depends_on: [] }],
  });

  // the selection a Director would make: ids chosen per session, plus two ids
  // that must be dropped — one that does not exist, one the owner ships off
  await director(projectId, "plan_sessions", {
    milestone: "M1",
    reasoning: "Scripted selection: the harness is standing in for the Director's tool call only.",
    sessions: [
      {
        key: "S1", name: "Accessible status rows", purpose: "UI work",
        prompt: "In index.html, replace the empty #board with three rows for the services api, web and worker. Each row shows the service name and a status word, with a colour. It must be readable on a phone and have a proper heading structure and labels a screen reader can use. Plain HTML and CSS in that one file. Do not install anything, do not run a package manager, do not reach the network. Then say what you changed.",
        depends_on: [], isolated: true, kind: "build", review_policy: "required",
        skills: ["frontend-ui-engineering", "no-such-skill", "test-driven-development"],
        reviewer_skills: ["code-review-and-quality"],
      },
      {
        key: "S2", name: "Record the author", purpose: "Clerical",
        prompt: "Create CONTRIBUTORS.md listing the single commit author already in this repository's git history. Nothing else. Do not install anything and do not reach the network.",
        depends_on: [], isolated: true, kind: "build", review_policy: "required", skills: [], reviewer_skills: [],
      },
    ],
  });

  const sessions = () => store().projectSessions.filter((s) => s.projectId === projectId);
  const deliveries = () => (store().skillDeliveries ?? []).filter((d) => sessions().some((s) => d.scopeId.startsWith(`session:${s.id}`)));
  const byKey = (k) => sessions().find((s) => s.key === k);
  const libRev = (await api("/api/skills")).source.revision;

  await test("selection is stored on the session record with the revision it was chosen from", async () => {
    const s1 = byKey("S1");
    assert(s1.skills, "S1 has no selection");
    assert(s1.skills.revision === libRev, `stored revision ${s1.skills.revision} is not the library's`);
    assert(s1.skills.chosenBy === "director" && s1.skills.chosenAt, "the record does not say who chose or when");
    assert(s1.reviewerSkills?.skillIds.join() === "code-review-and-quality", `reviewer got ${s1.reviewerSkills?.skillIds}`);
    return `S1 builder [${s1.skills.skillIds}] · reviewer [${s1.reviewerSkills.skillIds}] @ ${libRev.slice(0, 7)}`;
  });

  await test("an id that does not exist, and one the owner ships off, are dropped rather than breaking the plan", async () => {
    const ids = byKey("S1").skills.skillIds;
    assert(!ids.includes("no-such-skill"), "an invented id was stored");
    assert(!ids.includes("test-driven-development"), "a skill the owner has not enabled was stored");
    assert(ids.includes("frontend-ui-engineering"), "the real selection was lost with the bad ones");
    assert(byKey("S2").skills === null, `S2 should have no selection, has ${JSON.stringify(byKey("S2").skills)}`);
    return `3 asked for, 1 kept: ${ids.join(", ")}`;
  });

  /* ---------------------------------------------------------------- live work */
  console.log("\n  starting both sessions for real…");
  const started = Date.now();
  await director(projectId, "start_sessions", { keys: ["S1", "S2"], timeout_minutes: 12 });
  while (Date.now() - started < 22 * 60_000) {
    const ss = sessions();
    if (ss.length === 2 && ss.every((s) => ["COMPLETED", "FAILED", "TIMEOUT", "PAUSED"].includes(s.status))) break;
    await sleep(10_000);
  }
  for (const s of sessions()) console.log(`  ${s.key}: ${s.status}${s.lastVerdict ? ` · ${s.lastVerdict}` : ""} · reviews ${s.reviewsConsumed} · ${s.tokens ? `${s.tokens.turns} turn(s), in ${s.tokens.input}, out ${s.tokens.output}` : "no usage recorded"}`);

  await test("D - the Builder was sent exactly the skills selected for its session", async () => {
    const s1 = byKey("S1");
    const mine = deliveries().filter((d) => d.scopeId === `session:${s1.id}` && d.via === "brief");
    assert(mine.length, "the Builder was sent no skill at all");
    assert(mine.every((d) => s1.skills.skillIds.includes(d.skillId)), `sent something unselected: ${mine.map((d) => d.skillId)}`);
    assert(mine.every((d) => d.agentId === s1.agentId || d.agentId), "the record does not say who received it");
    return mine.map((d) => `${d.skillId} (${d.bytes}B)`).join(", ");
  });

  await test("D - the fresh Reviewer received its own, different skills in its own conversation", async () => {
    const s1 = byKey("S1");
    const rev = deliveries().filter((d) => d.scopeId.startsWith(`session:${s1.id}:review:`));
    assert(rev.length, `no review round ran (session ${s1.status}, reviews ${s1.reviewsConsumed}) — nothing to check`);
    assert(rev.every((d) => s1.reviewerSkills.skillIds.includes(d.skillId)), `reviewer got ${rev.map((d) => d.skillId)}`);
    const builderIds = new Set(deliveries().filter((d) => d.scopeId === `session:${s1.id}`).map((d) => d.skillId));
    assert(!rev.some((d) => builderIds.has(d.skillId)), "the Reviewer was handed the Builder's guidance");
    return `${rev.map((d) => `${d.skillId}@round ${d.scopeId.split(":").pop()}`).join(", ")} · builder had ${[...builderIds].join(", ")}`;
  });

  await test("E - the session that was given nothing received nothing", async () => {
    const s2 = byKey("S2");
    const any = deliveries().filter((d) => d.scopeId.startsWith(`session:${s2.id}`));
    assert(!any.some((d) => d.via === "brief"), `S2 was sent ${any.filter((d) => d.via === "brief").map((d) => d.skillId)}`);
    return any.length ? `${any.length} looked up by the agent itself, 0 sent` : "no skill text reached it";
  });

  await test("F - the selection and its revision survived the whole run", async () => {
    const s1 = byKey("S1");
    assert(s1.skills.skillIds.length === 1 && s1.skills.revision === libRev, "the selection changed during the run");
    const revs = new Set(deliveries().map((d) => d.revision));
    assert(revs.size <= 1, `delivered from ${[...revs].length} different revisions`);
    return `still [${s1.skills.skillIds}] @ ${s1.skills.revision.slice(0, 7)} after ${s1.reviewsConsumed} review round(s)`;
  });

  await test("I - the review produced a verdict the existing parser understood, within the limit", async () => {
    const s1 = byKey("S1");
    assert(s1.lastVerdict, "no verdict was recorded");
    assert(["pass", "findings"].includes(s1.lastVerdict), `unparsed verdict ${s1.lastVerdict}`);
    assert(s1.reviewsConsumed <= 2, `${s1.reviewsConsumed} review rounds`);
    return `${s1.lastVerdict}${s1.lastFindings?.length ? ` (${s1.lastFindings.length} finding(s))` : ""} in ${s1.reviewsConsumed} round(s)`;
  });

  await test("the work actually happened in the repository, not just in the reply", async () => {
    const detail = [];
    let anyWork = false;
    for (const s of sessions()) {
      const branch = s.branch ?? "HEAD";
      const g = (...a) => { try { return execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim(); } catch (e) { return `(${String(e.message).split("\n")[0].slice(0, 60)})`; } };
      const diff = g("diff", "--stat", "main", branch);
      const log = g("log", "--oneline", `main..${branch}`);
      // an isolated session works in its own worktree; uncommitted work there
      // is still work, so look at both
      const wt = s.cwd && fs.existsSync(s.cwd) ? g("-C", s.cwd, "status", "--short") : "(worktree gone)";
      if (diff || log) anyWork = true;
      detail.push(`${s.key}[${s.status}] branch ${branch}: ${log ? `${log.split("\n").length} commit(s)` : "no commits"}${diff ? `, ${diff.split("\n").pop()}` : ""}${wt && wt !== "(worktree gone)" ? ` · worktree dirty: ${wt.split("\n").length} file(s)` : ""}`);
    }
    assert(anyWork, `no session committed anything — ${detail.join(" | ")}`);
    return detail.join(" | ");
  });

  await test("what each session actually reported", async () => {
    const said = sessions().map((s) => `${s.key}: ${String(s.resultSummary ?? "(nothing)").replace(/\s+/g, " ").slice(0, 150)}`);
    assert(sessions().every((s) => s.resultSummary), "a session finished without reporting anything");
    return said.join(" | ");
  });

  /* ---------------------------------------------------------------- cost */
  const brief = deliveries().filter((d) => d.via === "brief").reduce((n, d) => n + d.bytes, 0);
  const lib = (await api("/api/skills")).skills.filter((s) => s.enabled).reduce((n, s) => n + s.bytes, 0);
  const tok = sessions().reduce((a, s) => ({ i: a.i + (s.tokens?.input ?? 0), o: a.o + (s.tokens?.output ?? 0), t: a.t + (s.tokens?.turns ?? 0) }), { i: 0, o: 0, t: 0 });
  console.log(`\n=== cost\n  ${tok.t} model turn(s) with usage · input ${tok.i.toLocaleString()} · output ${tok.o.toLocaleString()} · ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`  skill text delivered: ${brief.toLocaleString()} bytes (~${Math.round(brief / 4).toLocaleString()} tokens)`);
  console.log(`  the whole enabled library, if appended to every agent: ${lib.toLocaleString()} bytes (~${Math.round(lib / 4).toLocaleString()} tokens) per system prompt`);
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
} finally {
  if (!KEEP) {
    // delete by id, and sweep any project still pointing at this throwaway
    // repository — the Director can rename a project, so a title is no handle
    if (projectId) await api(`/api/projects/${projectId}`, null, "DELETE").catch(() => {});
    for (const p of (await api("/api/projects").catch(() => ({ projects: [] }))).projects ?? []) {
      if (p.rootPath === root) await api(`/api/projects/${p.id}`, null, "DELETE").catch(() => {});
    }
    for (const id of made) await api(`/api/agents/${id}`, null, "DELETE").catch(() => {});
    for (const d of [root, path.join(path.dirname(root), ".nexora-worktrees")]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
    console.log(`cleaned up the project, ${made.length} agents and ${root}`);
  } else console.log(`kept: project ${projectId} · repo ${root}`);
}
process.exit(results.every(Boolean) ? 0 : 1);
