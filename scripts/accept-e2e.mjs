#!/usr/bin/env node
/* ------------------------------------------------------------------
   One small project, start to finish, through the real path.

   Nothing here injects a decision the run is supposed to make: the
   Director writes the plan, decomposes it, picks the skills and decides
   the topology. The harness only creates the project and then reads what
   the engine recorded.

     node scripts/accept-e2e.mjs [baseUrl] [--keep]
   ------------------------------------------------------------------ */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BASE = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:3111";
const KEEP = process.argv.includes("--keep");
const USER = process.env.NEXORA_USER || "mjrafg";
const DATA_DIR = process.env.NEXORA_DATA_DIR || path.join(process.cwd(), "data");

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
const store = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push({ ok: true, name }); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push({ ok: false, name }); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 320)}`); }
}

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: requirePassword() }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];

/* ---------------------------------------------------------------- the cheap models the policy names */
const cat = await api("/api/catalog");
const conns = (await api("/api/providers")).connections;
const CHOICES = [
  { runtimeType: "claude-code", providerConnectionId: "conn-anthropic", model: "claude-haiku-4-5" },
  { runtimeType: "codex", providerConnectionId: "conn-openai", model: "gpt-5.6-luna" },
];
let runtime = null;
for (const o of CHOICES.filter((o) => conns.some((c) => c.id === o.providerConnectionId))) {
  const { agent } = await api("/api/agents", { name: `E2E probe ${Date.now().toString(36).slice(-5)}`, role: "Analyst", dept: "operations", toolPermissions: [], instructions: "Answer briefly.", runtime: o });
  const t = await api(`/api/agents/${agent.id}/test`, { message: "Reply with the single word ready." }).catch((e) => ({ ok: false, message: String(e.message) }));
  await api(`/api/agents/${agent.id}`, null, "DELETE").catch(() => {});
  console.log(`  ${o.runtimeType}/${o.model}: ${t.ok ? "available" : `unavailable — ${String(t.message).slice(0, 80)}`}`);
  if (t.ok) { runtime = o; break; }
}
assert(runtime, "neither cheap model named by the test policy is available — not switching to a costlier one");
console.log(`\n=== acceptance run · ${runtime.runtimeType}/${runtime.model}\n`);

const tag = Date.now().toString(36).slice(-5);
const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexora-e2e-${tag}-`));
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
fs.writeFileSync(path.join(root, "README.md"), `# Tiny Counter ${tag}\n\nA one-page counter. Nothing built yet.\n`);
git("init", "-q", "-b", "main"); git("config", "user.email", "e2e@nexora.local"); git("config", "user.name", "e2e");
git("add", "-A"); git("commit", "-qm", "start");

const made = [];
const mk = async (name, role, perms) => {
  const { agent } = await api("/api/agents", { name, role, dept: "engineering", toolPermissions: perms, instructions: "Do the work you are given, and report honestly what you checked.", runtime });
  made.push(agent.id); return agent;
};

let projectId = null;
const evidence = {};
try {
  const dir = await mk(`E2E Director ${tag}`, "Project Director", ["read_files"]);
  const bld = await mk(`E2E Builder ${tag}`, "Engineer", ["read_files", "write_files", "run_commands", "browser"]);
  const rev = await mk(`E2E Reviewer ${tag}`, "Reviewer", ["read_files", "browser"]);
  evidence.agents = { director: dir.name, builder: bld.name, reviewer: rev.name, runtime };

  const { project } = await api("/api/projects", {
    title: `Tiny Counter ${tag}`,
    rootPath: root,
    goal: [
      "Build a tiny one-page counter app in this repository: index.html, styles.css, app.js. Plain HTML/CSS/JS, no build step, no dependencies, no backend.",
      "It must: show a count starting at 0; have + and − buttons that change it; have a Reset button; keep the count across a page refresh using localStorage; show a visible focus ring on every button for keyboard users; work at a 375px-wide phone viewport and at desktop width.",
      "Verification is part of the work. Open the page in the browser you have and check the behaviour for real — do not infer it from the source. Report anything you could not check as UNVERIFIED.",
      "Do not add a README beyond what is already there, and do not leave scratch or notes files behind.",
    ].join("\n"),
    directorAgentId: dir.id, builderAgentId: bld.id, reviewerAgentId: rev.id,
  });
  projectId = project.id;
  console.log(`  project ${projectId}\n`);

  const started = Date.now();
  const LIMIT = 45 * 60_000;
  let last = "";
  while (Date.now() - started < LIMIT) {
    const p = (await api(`/api/projects/${projectId}`)).project;
    const line = `${p.state} · ${(p.milestones ?? []).map((m) => `${m.key}:${m.status}`).join(" ")}`;
    if (line !== last) { console.log(`  ${new Date().toTimeString().slice(0, 8)} ${line}`); last = line; }
    if (["COMPLETED", "FAILED"].includes(p.state)) break;
    await sleep(15_000);
  }
  const elapsed = Math.round((Date.now() - started) / 1000);
  const db = store();
  const proj = db.projects.find((x) => x.id === projectId);
  const sessions = db.projectSessions.filter((s) => s.projectId === projectId);
  evidence.state = proj.state;
  evidence.elapsedSeconds = elapsed;

  await test("1-2 the Director planned the project and decomposed it into sessions", async () => {
    const ms = db.projectMilestones.filter((m) => m.projectId === projectId);
    assert(ms.length >= 1, "no milestones");
    assert(sessions.length >= 1, "no sessions");
    evidence.plan = ms.map((m) => `${m.key} ${m.name} [${m.status}]`);
    evidence.sessions = sessions.map((s) => `${s.key} ${s.status}`);
    return `${ms.length} milestone(s), ${sessions.length} session(s)`;
  });

  await test("3-4 the Director chose skills, and the choice is auditable", async () => {
    const withSkills = sessions.filter((s) => s.skills?.skillIds.length || s.reviewerSkills?.skillIds.length);
    if (!withSkills.length) {
      evidence.skills = "the Director selected none for this project";
      return "none selected — the mechanism is proven separately; a Director may judge small work needs no method";
    }
    for (const s of withSkills) {
      for (const sel of [s.skills, s.reviewerSkills].filter(Boolean)) {
        assert(sel.revision && /^[0-9a-f]{40}$/.test(sel.revision), `${s.key}: no pinned revision`);
        assert(sel.chosenBy === "director", `${s.key}: chosenBy is ${sel.chosenBy}`);
        assert(sel.chosenAt, `${s.key}: no timestamp`);
      }
    }
    evidence.skills = withSkills.map((s) => `${s.key} builder[${(s.skills?.skillIds ?? []).join("|")}] reviewer[${(s.reviewerSkills?.skillIds ?? []).join("|")}] @${(s.skills ?? s.reviewerSkills).revision.slice(0, 7)} by ${(s.skills ?? s.reviewerSkills).chosenBy}`);
    return evidence.skills.join(" · ");
  });

  await test("5-6 each role received only what it was given, and the record says what it could reach", async () => {
    const withCaps = sessions.filter((s) => s.capabilities);
    assert(withCaps.length, "no session recorded its capabilities");
    for (const s of withCaps) {
      assert(!s.capabilities.reviewer.includes("write_files"), `${s.key}: the Reviewer was handed write access`);
      assert(!s.capabilities.reviewer.includes("run_commands"), `${s.key}: the Reviewer was handed a shell`);
    }
    evidence.capabilities = withCaps.map((s) => `${s.key} builder[${s.capabilities.builder.join("|")}] reviewer[${s.capabilities.reviewer.join("|")}]`);
    return evidence.capabilities.join(" · ");
  });

  const base = proj.baseBranch ?? "main";
  await test("7 the Builder made a real file change", async () => {
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", proj.integrationBranch ?? base], { cwd: root, encoding: "utf8" }).trim().split("\n");
    for (const f of ["index.html", "app.js"]) assert(files.includes(f), `${f} was never created`);
    const diff = execFileSync("git", ["diff", "--stat", `${base}~1`, proj.integrationBranch ?? base], { cwd: root, encoding: "utf8" }).trim();
    evidence.files = files;
    evidence.diff = diff.split("\n").pop();
    return `${files.length} files · ${evidence.diff}`;
  });

  await test("8 the Reviewer answered in the exact PASS/FINDINGS contract", async () => {
    const reviewed = sessions.filter((s) => s.lastVerdict);
    assert(reviewed.length, "no session was reviewed");
    for (const s of reviewed) assert(["pass", "findings"].includes(s.lastVerdict), `${s.key}: ${s.lastVerdict}`);
    const unstructured = reviewed.flatMap((s) => s.lastFindings ?? []).filter((f) => /unstructured output/.test(f.title));
    assert(!unstructured.length, `a verdict fell through the parser: ${unstructured.length} unstructured`);
    evidence.verdicts = reviewed.map((s) => `${s.key}:${s.lastVerdict}(${s.reviewsConsumed}/2)`);
    return evidence.verdicts.join(" · ");
  });

  await test("9 a finding and a repair were exercised, if the work produced one", async () => {
    const repaired = sessions.filter((s) => s.reviewsConsumed > 1 || (s.lastFindings ?? []).length);
    evidence.repairs = repaired.map((s) => `${s.key}: ${s.reviewsConsumed} round(s), ${(s.lastFindings ?? []).length} finding(s)`);
    return repaired.length ? evidence.repairs.join(" · ") : "the work passed first time — nothing was damaged to force a finding";
  });

  await test("10 integration matched the topology the engine created", async () => {
    const intSessions = sessions.filter((s) => /\.INT$/.test(s.key));
    if (!intSessions.length) return "no integration session was needed";
    const isolated = sessions.filter((s) => s.branch).length;
    for (const s of intSessions) {
      const wantsMerge = /Merge them into/.test(s.prompt);
      const saysInPlace = /no session branch to merge/.test(s.prompt);
      assert(isolated ? wantsMerge : saysInPlace, `${s.key}: prompt does not match topology (isolated sessions: ${isolated})`);
    }
    evidence.topology = `${isolated} isolated session(s); integration told to ${isolated ? "merge" : "validate in place"}`;
    return evidence.topology;
  });

  await test("11-12 the browser was granted and actually used for the checks that need it", async () => {
    const steps = sessions.flatMap((s) => (s.steps ?? []).map((e) => ({ key: s.key, e })));
    const browserSteps = steps.filter((x) => x.e.kind === "browser" || /^browser__/.test(x.e.title ?? "") || /browser/i.test(x.e.meta ?? ""));
    assert(browserSteps.length, "no agent called the browser, though both were given one");
    const actions = [...new Set(browserSteps.map((x) => x.e.browser?.action ?? x.e.title))];
    evidence.browser = { calls: browserSteps.length, actions, bySession: [...new Set(browserSteps.map((x) => x.key))] };
    return `${browserSteps.length} browser calls in ${evidence.browser.bySession.join(", ")} · ${actions.slice(0, 8).join(", ")}`;
  });

  await test("13 no false browser/visual claim where the browser was not used", async () => {
    const claim = /\b(verified|confirmed|tested)\b[^.]{0,80}\b(visually|in the browser|at mobile|at desktop|keyboard|focus ring|console)\b/i;
    const offenders = [];
    for (const s of sessions) {
      const usedBrowser = (s.steps ?? []).some((e) => e.kind === "browser" || /^browser__/.test(e.title ?? ""));
      if (usedBrowser) continue;
      if (claim.test(s.resultSummary ?? "")) offenders.push(`${s.key}: ${String(s.resultSummary).match(claim)[0].slice(0, 70)}`);
    }
    assert(!offenders.length, `a session claimed browser verification without using one: ${offenders.join(" | ")}`);
    return "no session claimed a check it did not run";
  });

  await test("15 no scratch files were delivered", async () => {
    const onMaster = execFileSync("git", ["ls-tree", "-r", "--name-only", base], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const expected = new Set(["README.md", "index.html", "styles.css", "app.js"]);
    const extra = onMaster.filter((f) => !expected.has(f));
    evidence.delivered = onMaster;
    assert(!extra.length, `delivered files that were not part of the work: ${extra.join(", ")}`);
    return onMaster.join(", ");
  });

  await test("16 checkpoint commit messages are sane", async () => {
    const subjects = execFileSync("git", ["log", "--format=%an|%s", "--all"], { cwd: root, encoding: "utf8" }).trim().split("\n");
    const engine = subjects.filter((l) => l.startsWith("Nexora OS|")).map((l) => l.split("|")[1]);
    for (const sub of engine) {
      assert(!/INTEGRATION session|You are on the project|Required output format/i.test(sub), `a commit subject contains prompt text: ${sub.slice(0, 80)}`);
      assert(sub.length <= 80, `commit subject too long: ${sub.length}`);
    }
    evidence.commits = subjects.slice(0, 10);
    return engine.length ? `${engine.length} engine commit(s): ${engine.join(" | ").slice(0, 90)}` : "no engine checkpoints were needed";
  });

  await test("17 the project delivered", async () => {
    assert(proj.state === "COMPLETED", `project ended ${proj.state}`);
    const baseHead = execFileSync("git", ["rev-parse", base], { cwd: root, encoding: "utf8" }).trim();
    const intHead = proj.integrationBranch ? execFileSync("git", ["rev-parse", proj.integrationBranch], { cwd: root, encoding: "utf8" }).trim() : baseHead;
    assert(baseHead === intHead, `${base} was not fast-forwarded to the integration branch`);
    return `${base} == ${proj.integrationBranch ?? base} @ ${baseHead.slice(0, 8)}`;
  });

  await test("14 the export alone can reconstruct the run", async () => {
    const md = await (await fetch(`${BASE}/api/projects/${projectId}/export?format=markdown`, { headers: { cookie } })).text();
    for (const must of ["chosen by director", "library revision", "Builder could reach", "Reviewer could reach"]) {
      assert(md.includes(must), `the export does not carry "${must}"`);
    }
    evidence.exportChars = md.length;
    return `${md.length} chars, carries selection, revision, chosenBy and reach`;
  });

  const tok = sessions.reduce((a, s) => ({ i: a.i + (s.tokens?.input ?? 0), o: a.o + (s.tokens?.output ?? 0), t: a.t + (s.tokens?.turns ?? 0) }), { i: 0, o: 0, t: 0 });
  const msgs = db.projectMessages.filter((m) => m.projectId === projectId && m.usage);
  evidence.cost = {
    runtime: `${runtime.runtimeType}/${runtime.model}`,
    sessionTurns: tok.t, sessionInput: tok.i, sessionOutput: tok.o,
    directorTurns: msgs.length,
    directorInput: msgs.reduce((n, m) => n + (m.usage.inputTokens ?? 0), 0),
    directorOutput: msgs.reduce((n, m) => n + (m.usage.outputTokens ?? 0), 0),
    seconds: elapsed,
  };

  console.log("\n--- evidence ---");
  console.log(JSON.stringify(evidence, null, 1));
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} acceptance checks passed`);
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
process.exit(results.every((r) => r.ok) ? 0 : 1);
