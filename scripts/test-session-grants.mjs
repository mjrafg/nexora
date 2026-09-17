#!/usr/bin/env node
/* ------------------------------------------------------------------
   What the Director may hand a session.

   A planning model asking for spending authority must be refused, and
   told why. What it legitimately needs must arrive, apply to that
   session only, and never be written back onto the agent — otherwise a
   grant made for one build follows that agent into every other project.

     node scripts/test-session-grants.mjs [baseUrl] [--keep]
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
const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push(true); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push(false); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 300)}`); }
}

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: requirePassword() }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const conns = (await api("/api/providers")).connections;
// no model needed: nothing here runs a turn, only the planning path is exercised
const runtime = { runtimeType: "claude-code", providerConnectionId: conns[0].id, model: "claude-haiku-4-5" };

const tag = Date.now().toString(36).slice(-5);
const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexora-grant-${tag}-`));
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
fs.writeFileSync(path.join(root, "README.md"), "# grant test\n");
git("init", "-q", "-b", "main"); git("config", "user.email", "g@nexora.local"); git("config", "user.name", "grant test");
git("add", "-A"); git("commit", "-qm", "start");

const made = [];
const mk = async (name, role, perms) => {
  const { agent } = await api("/api/agents", { name, role, dept: "engineering", toolPermissions: perms, instructions: "Do the work you are given.", runtime });
  made.push(agent.id); return agent;
};

let projectId = null;
try {
  const dir = await mk(`GRANT Director ${tag}`, "Project Director", ["read_files"]);
  // deliberately bare: everything this Builder gets must come from the grant
  const bld = await mk(`GRANT Builder ${tag}`, "Engineer", ["read_files"]);
  const rev = await mk(`GRANT Reviewer ${tag}`, "Reviewer", ["read_files"]);
  const { project } = await api("/api/projects", { title: `Grant test ${tag}`, rootPath: root, goal: "Check what a Director may give.", directorAgentId: dir.id, builderAgentId: bld.id, reviewerAgentId: rev.id });
  projectId = project.id;
  await director(projectId, "set_plan", { summary: "One milestone.", milestones: [{ key: "M1", name: "Work", goal: "Nothing runs.", acceptance: "n/a", depends_on: [] }] });

  const plan = await director(projectId, "plan_sessions", {
    milestone: "M1", reasoning: "Harness-driven.",
    sessions: [
      { key: "S1", name: "Needs to build", purpose: "legitimate ask", prompt: "Build something.", depends_on: [], isolated: true, kind: "build", review_policy: "required",
        grant_tools: ["write_files", "run_commands", "browser", "company_profile"] },
      { key: "S2", name: "Overreaches", purpose: "asks for the owner's authority", prompt: "Buy something.", depends_on: [], isolated: true, kind: "build", review_policy: "required",
        grant_tools: ["payments", "payments_use", "credentials", "company_profile_manage", "not_a_real_permission", "write_files"] },
      { key: "S3", name: "Asks for nothing", purpose: "control", prompt: "Do nothing.", depends_on: [], isolated: true, kind: "build", review_policy: "required" },
    ],
  });

  const byKey = (k) => store().projectSessions.find((s) => s.projectId === projectId && s.key === k);

  await test("what the work legitimately needs is granted", async () => {
    const g = byKey("S1").grants;
    assert(g, "S1 got no grant");
    for (const t of ["write_files", "run_commands", "browser", "company_profile"]) assert(g.tools.includes(t), `${t} missing`);
    assert(g.grantedBy === "director" && g.grantedAt, "the grant does not say who made it or when");
    return g.tools.join(", ");
  });

  await test("money, logins and company-data writes are refused", async () => {
    const g = byKey("S2").grants;
    const banned = ["payments", "payments_use", "credentials", "company_profile_manage"];
    for (const t of banned) assert(!g?.tools.includes(t), `${t} WAS GRANTED — the ceiling does not hold`);
    assert(!g?.tools.includes("not_a_real_permission"), "an invented permission was accepted");
    assert(g?.tools.includes("write_files"), "the legitimate part of the ask was thrown away with the rest");
    return `kept ${g.tools.join(", ")}, refused ${banned.length + 1}`;
  });

  await test("the Director is told what it did not get, and why", async () => {
    assert(plan.ok, `plan_sessions failed: ${plan.error}`);
    assert(/Not granted/.test(plan.text ?? ""), `no refusal reported: ${String(plan.text).slice(0, 200)}`);
    for (const t of ["payments", "credentials"]) assert(plan.text.includes(t), `${t} not named in the refusal`);
    assert(/owner/i.test(plan.text), "the refusal does not say whose decision it is");
    return String(plan.text).split("Not granted:")[1].trim().split("\n").slice(0, 2).join(" | ");
  });

  await test("a session that asked for nothing gets nothing", async () => {
    assert(!byKey("S3").grants, `S3 has ${JSON.stringify(byKey("S3").grants)}`);
    return "no grant recorded";
  });

  await test("the grant is the session's, not the agent's", async () => {
    const agent = store().agents.find((a) => a.id === bld.id);
    assert(agent.toolPermissions.length === 1 && agent.toolPermissions[0] === "read_files",
      `the Builder's own permissions changed to: ${agent.toolPermissions.join(", ")}`);
    return `agent still holds only ${agent.toolPermissions.join(", ")}`;
  });

  await test("a tool server nobody on the project was trusted with is refused", async () => {
    const servers = store().mcpServers ?? [];
    if (!servers.length) return "no tool servers configured here — nothing to check";
    const r = await director(projectId, "plan_sessions", {
      milestone: "M1", reasoning: "Harness-driven.",
      sessions: [{ key: "S4", name: "Wants a server", purpose: "unearned reach", prompt: "x", depends_on: [], isolated: true, kind: "build", review_policy: "required", grant_servers: [servers[0].name] }],
    });
    const g = byKey("S4")?.grants;
    assert(!g?.servers?.length, `granted ${servers[0].name} without the owner ever trusting it here`);
    assert(/Capability Manager/.test(r.text ?? ""), `the refusal does not point at the owner's path: ${String(r.text).slice(0, 160)}`);
    return `${servers[0].name} refused, Capability Manager named`;
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
