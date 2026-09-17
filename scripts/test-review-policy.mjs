#!/usr/bin/env node
/* ------------------------------------------------------------------
   Who verifies what.

   Review used to be structural: any session that changed a file got an
   independent Reviewer, so a copy change cost two agent runs and a QA
   session had its matrix executed twice by two agents who each believed
   they were the one doing the real verification.

   The Director now decides per session. These checks hold the engine to
   that decision and, more importantly, to telling the truth about it:
   a review nobody ran and a review that ran out of budget must never
   read as a pass.

     node scripts/test-review-policy.mjs [baseUrl] [--keep]
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
// nothing here runs a model turn; only planning, persistence and rendering
const runtime = { runtimeType: "claude-code", providerConnectionId: conns[0].id, model: "claude-haiku-4-5" };

const tag = Date.now().toString(36).slice(-5);
const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexora-rev-${tag}-`));
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
fs.writeFileSync(path.join(root, "README.md"), "# review policy test\n");
git("init", "-q", "-b", "main"); git("config", "user.email", "r@nexora.local"); git("config", "user.name", "review test");
git("add", "-A"); git("commit", "-qm", "start");

const made = [];
const mk = async (name, role) => {
  const { agent } = await api("/api/agents", { name, role, dept: "engineering", toolPermissions: ["read_files", "write_files", "run_commands"], instructions: "Do the work you are given.", runtime });
  made.push(agent.id); return agent;
};

let projectId = null;
try {
  const dir = await mk(`REV Director ${tag}`, "Project Director");
  const bld = await mk(`REV Builder ${tag}`, "Engineer");
  const alt = await mk(`REV Second Builder ${tag}`, "Engineer");
  const rev = await mk(`REV Reviewer ${tag}`, "Reviewer");
  const { project } = await api("/api/projects", { title: `Review policy ${tag}`, rootPath: root, goal: "Check who verifies what.", directorAgentId: dir.id, builderAgentId: bld.id, reviewerAgentId: rev.id });
  projectId = project.id;
  await director(projectId, "set_plan", { summary: "One milestone.", milestones: [{ key: "M1", name: "Work", goal: "Nothing runs.", acceptance: "n/a", depends_on: [] }] });

  const plan = await director(projectId, "plan_sessions", {
    milestone: "M1", reasoning: "Harness-driven.",
    sessions: [
      { key: "S1", name: "Risky build", purpose: "auth", prompt: "Implement login.", depends_on: [], isolated: true, review_policy: "required", review_why: "authentication" },
      { key: "S2", name: "Copy tweak", purpose: "wording", prompt: "Fix a typo in the README.", depends_on: [], isolated: true, kind: "cleanup", review_policy: "none", review_why: "one word in a readme" },
      { key: "S3", name: "QA pass", purpose: "testing", prompt: "Run the test matrix.", depends_on: [], isolated: true, kind: "qa", review_policy: "spot_check", review_why: "the session already tests; audit it" },
      { key: "S4", name: "Unstated", purpose: "default", prompt: "Do a thing.", depends_on: [], isolated: true, agent_id: alt.id },
    ],
  });
  const byKey = (k) => store().projectSessions.find((s) => s.projectId === projectId && s.key === k);

  await test("the Director can choose review required, spot_check or none", async () => {
    assert(plan.ok, `plan_sessions failed: ${plan.error}`);
    assert(byKey("S1").reviewPolicy === "required", `S1 is ${byKey("S1").reviewPolicy}`);
    assert(byKey("S2").reviewPolicy === "none", `S2 is ${byKey("S2").reviewPolicy}`);
    assert(byKey("S3").reviewPolicy === "spot_check", `S3 is ${byKey("S3").reviewPolicy}`);
    return "required / none / spot_check all persisted";
  });

  await test("an unstated policy defaults to required, not to none", async () => {
    assert(byKey("S4").reviewPolicy === "required", `a session with no review_policy became ${byKey("S4").reviewPolicy}`);
    return "silence means review";
  });

  await test("the decision is persisted with who made it and why", async () => {
    const s = byKey("S2");
    assert(s.reviewPolicyBy, "nothing records who chose the policy");
    assert(/one word in a readme/.test(s.reviewPolicyWhy ?? ""), `the reason was not kept: ${s.reviewPolicyWhy}`);
    return `chosen by ${s.reviewPolicyBy} — ${s.reviewPolicyWhy}`;
  });

  await test("session kind is persisted and defaults to build", async () => {
    assert(byKey("S3").kind === "qa", `S3 kind is ${byKey("S3").kind}`);
    assert(byKey("S2").kind === "cleanup", `S2 kind is ${byKey("S2").kind}`);
    assert(byKey("S1").kind === "build", `an unstated kind became ${byKey("S1").kind}`);
    return "qa / cleanup / build";
  });

  await test("the Director is told which agent will actually run each session", async () => {
    const t = plan.text ?? "";
    assert(/S4: builder REV Second Builder/.test(t), `the named agent is not reported back: ${t.slice(-400)}`);
    assert(new RegExp(`S1: builder REV Builder ${tag} \\(project default`).test(t), `an unset agent_id is not reported as the default: ${t.slice(-400)}`);
    assert(/NO Reviewer will run/.test(t), "a no-review session is not called out to the Director");
    return "assignments and policies echoed back";
  });

  await test("a no-review session is never shown as review passed", async () => {
    const md = await (await fetch(`${BASE}/api/projects/${projectId}/export`, { headers: { cookie } })).text();
    assert(/Review policy:\*\* none/.test(md), "the export does not state the policy");
    assert(/skipped — the Director chose no reviewer/.test(md), "a skipped review is not described as skipped");
    assert(!/S2[\s\S]{0,600}passed independent review/.test(md), "a session nobody reviewed is described as passing");
    return "export says skipped, never passed";
  });

  await test("the export answers why there was no Reviewer, without guessing", async () => {
    const md = await (await fetch(`${BASE}/api/projects/${projectId}/export`, { headers: { cookie } })).text();
    assert(/Reviewer:\*\* none — review policy for this session is/.test(md), "the export still names a Reviewer for a session that has none");
    assert(/one word in a readme/.test(md), "the Director's reason is not in the export");
    return "policy, chooser and reason all present";
  });

  await test("integration is refused instructions that contradict the real topology", async () => {
    // these sessions are isolated, so make a non-isolated milestone to test in place
    await director(projectId, "set_plan", { summary: "Two milestones.", milestones: [
      { key: "M1", name: "Work", goal: "Nothing runs.", acceptance: "n/a", depends_on: [] },
      { key: "M2", name: "Shared", goal: "In place.", acceptance: "n/a", depends_on: [] },
    ] });
    await director(projectId, "plan_sessions", { milestone: "M2", reasoning: "x", sessions: [{ key: "T1", name: "In place", purpose: "p", prompt: "do", depends_on: [], isolated: false }] });
    const s = store().projectSessions.find((x) => x.projectId === projectId && x.key === "T1");
    const fsdb = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
    fsdb.projectSessions.find((x) => x.id === s.id).status = "completed";
    fs.writeFileSync(path.join(DATA_DIR, "nexora.json"), JSON.stringify(fsdb, null, 2));
    const bad = await director(projectId, "integrate_milestone", { milestone: "M2", instructions: "Merge the T1 session branch into the integration branch. Then validate." });
    assert(!bad.ok, "a merge-the-session-branch instruction was accepted for an in-place milestone");
    assert(/no session branch exists/.test(bad.error ?? ""), `the refusal does not state the topology: ${bad.error}`);
    const ok = await director(projectId, "integrate_milestone", { milestone: "M2", instructions: "The work is already on the integration branch; validate it in place and run the build." });
    assert(ok.ok, `a correct in-place instruction was refused: ${ok.error}`);
    return "contradiction refused, in-place accepted";
  });

  await test("an integration session inherits the right kind and a required review", async () => {
    const int = store().projectSessions.find((x) => x.projectId === projectId && x.key === "M2.INT");
    assert(int, "no integration session was created");
    assert(int.kind === "integration", `integration session kind is ${int.kind}`);
    assert(int.reviewPolicy === "required", `integration review policy is ${int.reviewPolicy}`);
    assert(/already established/.test(int.prompt), "integration is not told what earlier sessions proved");
    assert(!/Merge the T1 session branch/.test(int.prompt), "the contradictory instruction reached the session anyway");
    return "integration · required · prior evidence supplied";
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
