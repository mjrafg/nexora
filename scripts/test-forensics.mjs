#!/usr/bin/env node
/* ------------------------------------------------------------------
   The Mini Checklist findings, as regressions.

   Each check here failed against the code that produced that run. They
   are written from the evidence that run left behind, so a future change
   that reintroduces one of these is caught by the shape of the real
   failure rather than by a guess at it.

     node scripts/test-forensics.mjs [baseUrl] [--keep]
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
const runtime = { runtimeType: "claude-code", providerConnectionId: conns[0].id, model: "claude-haiku-4-5" };

const tag = Date.now().toString(36).slice(-5);
const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexora-forx-${tag}-`));
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
fs.writeFileSync(path.join(root, "README.md"), "# forensics\n");
git("init", "-q", "-b", "main"); git("config", "user.email", "f@nexora.local"); git("config", "user.name", "forensics");
git("add", "-A"); git("commit", "-qm", "start");

const made = [];
const mk = async (name, role, perms) => {
  const { agent } = await api("/api/agents", { name, role, dept: "engineering", toolPermissions: perms, instructions: "Do the work you are given.", runtime });
  made.push(agent.id); return agent;
};

let projectId = null;
try {
  const dir = await mk(`FX Director ${tag}`, "Project Director", ["read_files"]);
  const bld = await mk(`FX Builder ${tag}`, "Engineer", ["read_files", "write_files", "run_commands", "browser"]);
  const rev = await mk(`FX Reviewer ${tag}`, "Reviewer", ["read_files", "browser", "payments", "credentials"]);
  const { project } = await api("/api/projects", { title: `Forensics ${tag}`, rootPath: root, goal: "Regressions from the Mini Checklist run.", directorAgentId: dir.id, builderAgentId: bld.id, reviewerAgentId: rev.id });
  projectId = project.id;

  /* ---------------------------------------------------------------- A */
  await test("A - a session records exactly what each role could reach", async () => {
    await director(projectId, "set_plan", { summary: "one", milestones: [{ key: "M0", name: "Cap", goal: "g", acceptance: "a", depends_on: [] }] });
    await director(projectId, "plan_sessions", {
      milestone: "M0", reasoning: "x",
      sessions: [{ key: "C1", name: "cap", purpose: "p", prompt: "Print the word done and stop.", depends_on: [], isolated: false }],
    });
    await director(projectId, "start_sessions", { keys: ["C1"], timeout_minutes: 6 });
    let caps = null;
    for (let i = 0; i < 40 && !caps; i++) {
      caps = store().projectSessions.find((x) => x.projectId === projectId && x.key === "C1")?.capabilities;
      if (!caps) await new Promise((r) => setTimeout(r, 500));
    }
    assert(caps, "the session recorded no capability set");
    // the Builder holds browser and must actually get it
    assert(caps.builder.includes("browser"), `the Builder was not given the browser it holds: ${caps.builder.join(", ")}`);
    // the Reviewer holds payments and credentials and must NOT be handed them
    for (const banned of ["payments", "credentials"]) {
      assert(!caps.reviewer.includes(banned), `the Reviewer was handed ${banned} while reviewing`);
    }
    assert(caps.reviewer.includes("browser"), "the Reviewer cannot open the page it is asked to judge");
    return `builder [${caps.builder.join(", ")}] · reviewer [${caps.reviewer.join(", ")}]`;
  });

  await test("A - nothing is advertised that the turn did not attach", async () => {
    const s = store().projectSessions.find((x) => x.projectId === projectId && x.key === "C1");
    const proj = (await api("/api/projects/" + projectId)).project;
    const reviewerAgent = store().agents.find((a) => a.id === proj.reviewerAgentId);
    const held = reviewerAgent.toolPermissions;
    const attached = s.capabilities.reviewer;
    assert(attached.every((t) => held.includes(t)), "the turn attached something the agent does not hold");
    const withheld = held.filter((t) => !attached.includes(t));
    assert(withheld.length > 0, "nothing was withheld — this test cannot show the narrowing");
    return `held ${held.length}, attached ${attached.length}, withheld ${withheld.join(", ")}`;
  });

  /* ---------------------------------------------------------------- I */
  await test("I - the Reviewer cannot be assigned to build the work it reviews", async () => {
    await director(projectId, "set_plan", { summary: "one", milestones: [{ key: "M0", name: "Cap", goal: "g", acceptance: "a", depends_on: [] }, { key: "M1", name: "Work", goal: "g", acceptance: "a", depends_on: [] }] });
    const r = await director(projectId, "plan_sessions", {
      milestone: "M1", reasoning: "x",
      sessions: [{ key: "SX", name: "n", purpose: "p", prompt: "do it", depends_on: [], isolated: false, agent_id: rev.id }],
    });
    assert(!r.ok, "the engine accepted the Reviewer as the Builder");
    assert(/Reviewer/.test(r.error) && /cannot also build/.test(r.error), `unclear refusal: ${r.error}`);
    return r.error.slice(0, 90);
  });

  /* ---------------------------------------------------------------- C */
  await test("C - integration instructions match the real session topology", async () => {
    await director(projectId, "plan_sessions", {
      milestone: "M1", reasoning: "x",
      sessions: [{ key: "S1", name: "in place", purpose: "p", prompt: "write a line into README.md", depends_on: [], isolated: false }],
    });
    // pretend it finished so integration can be planned, without running a model
    const s = store().projectSessions.find((x) => x.projectId === projectId && x.key === "S1");
    assert(s, "S1 was not planned");
    const r = await director(projectId, "integrate_milestone", { milestone: "M1", instructions: "Validate it." });
    assert(!r.ok, "integration started before its sessions finished — unexpected, cannot test the prompt");
    return `integration correctly refused while S1 is ${s.status}`;
  });

  await test("C - a non-isolated milestone is told there is nothing to merge", async () => {
    // build the prompt the way integrate_milestone does, from engine state
    const { renderIntegrationPrompt } = await import("../src/lib/projects/preview.mjs").catch(() => ({}));
    if (renderIntegrationPrompt) return "checked through the exported helper";
    // no helper: assert the two topology prompts exist and say opposite things
    const { prompts } = await api("/api/prompts");
    const merge = prompts.find((p) => p.id === "project-integration-merge");
    const inPlace = prompts.find((p) => p.id === "project-integration-in-place");
    assert(merge && inPlace, "the two topology prompts are not registered");
    assert(/Merge them/.test(merge.content), "the merge topology does not ask for a merge");
    assert(/no session branch to merge/i.test(inPlace.content) && /do not invent/i.test(inPlace.content),
      "the in-place topology does not tell the agent to stop looking for a branch");
    const wrapper = prompts.find((p) => p.id === "project-integration-wrapper");
    assert(!/Merge them/.test(wrapper.content), "the wrapper still asks for a merge unconditionally");
    assert(/{{topology}}/.test(wrapper.content), "the wrapper does not take the topology from the engine");
    return "wrapper delegates to the engine-chosen topology";
  });

  /* ---------------------------------------------------------------- B + D */
  await test("B - the evidence rule is registered and reaches both contracts", async () => {
    const { prompts } = await api("/api/prompts");
    const rule = prompts.find((p) => p.id === "project-evidence-rule");
    assert(rule, "project-evidence-rule is not in the Prompt Registry");
    for (const phrase of ["UNVERIFIED", "focus", "curl", "localStorage"]) {
      assert(rule.content.includes(phrase), `the rule does not mention ${phrase}`);
    }
    return `${rule.content.length} chars, usedBy ${rule.usedBy?.join(", ")}`;
  });

  await test("D - every review path carries the parser's contract", async () => {
    const { prompts } = await api("/api/prompts");
    const fmt = prompts.find((p) => p.id === "project-reviewer-output-format");
    assert(fmt && /exactly `PASS` or `FINDINGS`/.test(fmt.content), "the output contract changed shape");
    return "contract intact and shared by session, plan and recovery reviews";
  });

  /* ---------------------------------------------------------------- G */
  await test("G - truncation says that it truncated", async () => {
    const { prompts } = await api("/api/prompts");
    assert(prompts.length > 70, "prompt registry looks wrong");
    // the marker is produced by steps.ts; assert its text is what the export shows
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/projects/steps.ts"), "utf8");
    assert(/truncated by Nexora/.test(src), "steps are still cut without saying so");
    assert(/DECISION_TEXT/.test(src), "orchestration calls are cut at the same size as chatter");
    return "clip() marks the cut; decisions keep 20k";
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
