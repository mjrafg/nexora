#!/usr/bin/env node
/* ------------------------------------------------------------------
   Live acceptance for Director-decided review.

   One small disposable project, run through the real orchestration path
   with nothing forced: the Director picks the milestones, the sessions,
   the agents, the skills, and — the point of this run — whether each
   session is independently reviewed at all.

   The goal deliberately contains work of three different weights, so a
   Director exercising judgement has something to exercise it on. What is
   checked here is not that it made any particular choice, but that
   whatever it chose was honoured, recorded, and described truthfully.

     NEXORA_PASS=… node scripts/accept-review-policy.mjs [baseUrl] [--keep]
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
  catch (err) { results.push({ ok: false, name }); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 400)}`); }
}

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: requirePassword() }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const conns = (await api("/api/providers")).connections;

// the cheap models the test policy names, in order; never silently upgraded
const CHOICES = [
  { runtimeType: "claude-code", providerConnectionId: "conn-anthropic", model: "claude-haiku-4-5" },
  { runtimeType: "codex", providerConnectionId: "conn-openai", model: "gpt-5.6-luna" },
];
let runtime = null;
for (const o of CHOICES.filter((o) => conns.some((c) => c.id === o.providerConnectionId))) {
  const { agent } = await api("/api/agents", { name: `RP probe ${Date.now().toString(36).slice(-5)}`, role: "Analyst", dept: "operations", toolPermissions: [], instructions: "Answer briefly.", runtime: o });
  const t = await api(`/api/agents/${agent.id}/test`, { message: "Reply with the single word ready." }).catch((e) => ({ ok: false, message: String(e.message) }));
  await api(`/api/agents/${agent.id}`, null, "DELETE").catch(() => {});
  console.log(`  ${o.runtimeType}/${o.model}: ${t.ok ? "available" : `unavailable — ${String(t.message).slice(0, 90)}`}`);
  if (t.ok) { runtime = o; break; }
}
assert(runtime, "neither cheap model named by the test policy is available — not switching to a costlier one");
console.log(`\n=== review-policy acceptance · ${runtime.runtimeType}/${runtime.model}\n`);

const tag = Date.now().toString(36).slice(-5);
const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexora-rp-${tag}-`));
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
fs.writeFileSync(path.join(root, "README.md"), `# Unit Converter ${tag}\n\nA one-page converter. Teh app is not built yet.\n`);
fs.writeFileSync(path.join(root, "index.html"), "<!doctype html>\n<title>Unit Converter</title>\n<h1>Unit Converter</h1>\n");
git("init", "-q", "-b", "main"); git("config", "user.email", "rp@nexora.local"); git("config", "user.name", "rp");
git("add", "-A"); git("commit", "-qm", "start");

const made = [];
const mk = async (name, role, perms) => {
  const { agent } = await api("/api/agents", { name, role, dept: "engineering", toolPermissions: perms, instructions: "Do the work you are given, and report honestly what you checked.", runtime });
  made.push(agent.id); return agent;
};

let projectId = null;
const evidence = {};
try {
  const dir = await mk(`RP Director ${tag}`, "Project Director", ["read_files"]);
  const bld = await mk(`RP Builder ${tag}`, "Engineer", ["read_files", "write_files", "run_commands", "browser"]);
  const rev = await mk(`RP Reviewer ${tag}`, "Reviewer", ["read_files", "browser"]);
  evidence.agents = { director: dir.name, builder: bld.name, reviewer: rev.name, runtime };

  const { project } = await api("/api/projects", {
    title: `Unit Converter ${tag}`,
    rootPath: root,
    goal: [
      "This repository holds a stub one-page unit converter (index.html). Finish it, as plain HTML/CSS/JS with no build step, no dependencies and no backend.",
      "",
      "Three separate pieces of work, of quite different weight:",
      "1. The conversion feature itself: a number input, a 'from' and 'to' unit select (celsius/fahrenheit/kelvin), and a live converted result. The arithmetic must be correct in every direction, including negative values and zero. This is the part that is actually worth getting wrong-proof.",
      "2. A typo fix: README.md says 'Teh app'. It should say 'The app'. That is the entire change.",
      "3. A test pass over the finished converter, confirming the conversions and the page behave, and leaving a short written record of what was checked.",
      "",
      "You decide how to organise this into milestones and sessions, who runs each one, and — for each session — whether an independent review is worth its cost. Judge that from the work in front of you, not by habit.",
      "Where a claim needs the browser to be true, use the browser. Report anything you could not check as UNVERIFIED. Do not leave scratch, log or notes files behind.",
    ].join("\n"),
    directorAgentId: dir.id, builderAgentId: bld.id, reviewerAgentId: rev.id,
  });
  projectId = project.id;
  console.log(`  project ${projectId}\n`);

  const started = Date.now();
  const LIMIT = 60 * 60_000;
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
  const agentName = (id) => db.agents.find((a) => a.id === id)?.name ?? id;
  const steps = (s, role) => (s.steps ?? []).filter((e) => !role || e.actor?.role === role);
  const browserSteps = (s, role) => steps(s, role).filter((e) => e.kind === "browser");
  const work = sessions.filter((s) => !s.key.endsWith(".INT"));
  const ints = sessions.filter((s) => s.key.endsWith(".INT"));
  evidence.state = proj.state;
  evidence.elapsedSeconds = elapsed;
  evidence.sessions = sessions.map((s) => ({
    key: s.key, name: s.name.slice(0, 44), status: s.status, kind: s.kind,
    builder: agentName(s.agentId ?? proj.builderAgentId), assignedExplicitly: !!s.agentId,
    reviewPolicy: s.reviewPolicy, reviewPolicyBy: s.reviewPolicyBy, reviewPolicyWhy: (s.reviewPolicyWhy ?? "").slice(0, 110),
    reviewStatus: s.reviewStatus, rounds: s.reviewsConsumed,
    builderSteps: steps(s, "Builder").length, reviewerSteps: steps(s, "Reviewer").length,
    builderBrowser: browserSteps(s, "Builder").length, reviewerBrowser: browserSteps(s, "Reviewer").length,
  }));

  /* ---------------- 1-4: the decision is real, honoured and honest ------------- */

  await test("1 the Director's review-policy decision is persisted on every session", async () => {
    assert(sessions.length, "no sessions at all");
    for (const s of sessions) assert(s.reviewPolicy, `${s.key} has no reviewPolicy`);
    const by = [...new Set(sessions.map((s) => s.reviewPolicy))];
    evidence.policiesChosen = Object.fromEntries(by.map((p) => [p, sessions.filter((s) => s.reviewPolicy === p).map((s) => s.key)]));
    assert(sessions.every((s) => s.reviewPolicyBy), "a policy was recorded without saying who chose it");
    return `${sessions.length} sessions · ${by.join(", ")}`;
  });

  await test("2 a session the Director excused from review never instantiates a Reviewer", async () => {
    const none = sessions.filter((s) => s.reviewPolicy === "none" && s.startedAt);
    if (!none.length) return "the Director chose review on every session this run — nothing to check";
    for (const s of none) {
      assert(s.reviewsConsumed === 0, `${s.key} is policy none but consumed ${s.reviewsConsumed} review rounds`);
      assert(!s.lastVerdict, `${s.key} is policy none but carries a verdict: ${s.lastVerdict}`);
      assert(steps(s, "Reviewer").length === 0, `${s.key} is policy none but a Reviewer took ${steps(s, "Reviewer").length} steps`);
      assert(!(s.capabilities?.reviewer ?? []).length, `${s.key} attached reviewer capabilities for a review that never runs`);
    }
    return `${none.map((s) => s.key).join(", ")} — no reviewer turn, no verdict, no reviewer tools`;
  });

  await test("3 a skipped review is shown as skipped, never as passed", async () => {
    const none = sessions.filter((s) => s.reviewPolicy === "none");
    if (!none.length) return "no skipped session this run";
    const md = await (await fetch(`${BASE}/api/projects/${projectId}/export?format=markdown`, { headers: { cookie } })).text();
    for (const s of none) {
      const block = md.slice(md.indexOf(`### ${s.key} `));
      const upTo = block.slice(0, block.indexOf("### ", 4) > 0 ? block.indexOf("### ", 4) : 2000);
      assert(/skipped — the Director chose no reviewer/.test(upTo), `${s.key} is not described as skipped in the export`);
      assert(!/passed independent review/.test(upTo), `${s.key} is described as having passed a review that never ran`);
      assert(/Reviewer:\*\* none/.test(upTo), `${s.key} still names a Reviewer in the export`);
    }
    return `${none.map((s) => s.key).join(", ")} shown as skipped, with the reason`;
  });

  await test("4 a reviewed session still gets a real independent Reviewer", async () => {
    const reviewed = sessions.filter((s) => s.reviewPolicy !== "none" && s.status === "completed");
    assert(reviewed.length, "no session was independently reviewed at all this run");
    const ran = reviewed.filter((s) => s.reviewsConsumed > 0);
    assert(ran.length, `${reviewed.length} sessions required review but none consumed a round`);
    for (const s of ran) {
      assert(s.reviewStatus && s.reviewStatus !== "skipped", `${s.key} ran a review but its status is ${s.reviewStatus}`);
      assert(steps(s, "Reviewer").length > 0, `${s.key} recorded a verdict with no Reviewer steps behind it`);
    }
    evidence.reviewerIdentity = agentName(proj.reviewerAgentId);
    return `${ran.map((s) => `${s.key}:${s.reviewStatus}`).join(", ")} by ${agentName(proj.reviewerAgentId)}`;
  });

  /* ---------------- 5-9: who did the verifying ------------------------------- */

  await test("5 a normal Builder did not run an exhaustive duplicate QA pass", async () => {
    /*
     * Only `required` belongs here. Under `spot_check` the session itself owns
     * the substantive verification and the Reviewer audits it — a Builder doing
     * a lot of checking there is the design working, not failing.
     */
    const builds = work.filter((s) => (s.kind ?? "build") === "build" && s.reviewPolicy === "required" && s.status === "completed");
    if (!builds.length) return "no required-review build session this run";
    const rows = builds.map((s) => `${s.key} builder ${browserSteps(s, "Builder").length} vs reviewer ${browserSteps(s, "Reviewer").length} browser steps`);
    evidence.buildSplit = rows;
    // the previous behaviour had the Builder proving the whole request itself,
    // 136 steps on M1.1 before a Reviewer did 152 more
    for (const s of builds) {
      assert(steps(s, "Builder").length < 100, `${s.key}'s Builder took ${steps(s, "Builder").length} steps — that is the exhaustive pass it was told not to do`);
    }
    return rows.join(" · ");
  });

  await test("6 the Reviewer performed the main verification for normal build work", async () => {
    const builds = work.filter((s) => (s.kind ?? "build") === "build" && s.reviewPolicy === "required" && s.reviewsConsumed > 0);
    if (!builds.length) return "no required-review build session this run";
    for (const s of builds) assert(steps(s, "Reviewer").length > 0, `${s.key}'s verdict has no reviewer work behind it`);
    const withBrowser = builds.filter((s) => browserSteps(s, "Reviewer").length > 0);
    return `${builds.map((s) => `${s.key}:${steps(s, "Reviewer").length} steps`).join(", ")}${withBrowser.length ? ` · ${withBrowser.length} used the browser` : ""}`;
  });

  await test("7-8 a QA session tests once, and its Reviewer audits rather than replaying", async () => {
    const qa = work.filter((s) => s.kind === "qa" && s.status === "completed");
    if (!qa.length) return "the Director created no QA session this run — nothing to check";
    const rows = [];
    for (const s of qa) {
      const w = steps(s, "Builder").length;
      const r = steps(s, "Reviewer").length;
      rows.push(`${s.key} worker ${w} / reviewer ${r}`);
      if (s.reviewPolicy === "none") continue;
      assert(s.reviewStatus !== "incomplete", `${s.key}'s reviewer ran out of budget — the audit scope did not hold`);
      assert(r < w, `${s.key}'s reviewer took ${r} steps against the worker's ${w}: it replayed the matrix instead of auditing it`);
    }
    evidence.qaSplit = rows;
    return rows.join(" · ");
  });

  await test("9 integration validated the integration instead of repeating the matrix", async () => {
    if (!ints.length) return "no integration session this run";
    const biggest = Math.max(...work.map((s) => browserSteps(s).length), 0);
    const rows = ints.map((s) => `${s.key} ${browserSteps(s).length} browser steps`);
    evidence.integrationSplit = rows;
    for (const s of ints) {
      assert(/already established/.test(s.prompt), `${s.key} was not told what earlier sessions proved`);
      assert(browserSteps(s).length <= Math.max(biggest, 20), `${s.key} spent ${browserSteps(s).length} browser steps against the busiest work session's ${biggest} — it re-ran the matrix`);
    }
    return `${rows.join(" · ")} (busiest work session: ${biggest})`;
  });

  /* ---------------- 10-17: honesty, identity, topology, delivery ------------- */

  await test("10 browser-backed claims rest on real browser calls", async () => {
    const all = sessions.flatMap((s) => browserSteps(s));
    assert(all.length > 0, "not one browser call in the whole run — visual and behavioural claims cannot be true");
    const acted = [...new Set(all.map((e) => e.browser?.action).filter(Boolean))];
    evidence.browser = { calls: all.length, actions: acted, bySession: sessions.filter((s) => browserSteps(s).length).map((s) => `${s.key}:${browserSteps(s).length}`) };
    const claimed = sessions.filter((s) => /\b(at (375|768|1440|1280)|mobile width|phone viewport|in the browser|on screen)\b/i.test(s.resultSummary ?? ""));
    for (const s of claimed) assert(browserSteps(s).length > 0, `${s.key} claims a browser observation with no browser call recorded`);
    return `${all.length} calls · ${acted.join(", ")}`;
  });

  await test("11 the agent named to the owner is the agent that ran the work", async () => {
    const names = db.agents.map((a) => a.name).filter((n) => /^RP /.test(n));
    const said = db.projectMessages.filter((m) => m.projectId === projectId && m.role === "assistant");
    const blame = [];
    for (const s of sessions) {
      const actual = agentName(s.agentId ?? proj.builderAgentId);
      const others = names.filter((n) => n !== actual);
      for (const m of said) {
        for (const line of (m.content ?? "").split("\n")) {
          if (!line.includes(s.key)) continue;
          for (const o of others) if (line.includes(o)) blame.push(`${s.key} ran on ${actual} but the owner was told "${line.trim().slice(0, 110)}"`);
        }
      }
      // the record itself must never name the project's Reviewer as a builder
      assert(s.agentId !== proj.reviewerAgentId, `${s.key} was assigned to the project's own Reviewer`);
    }
    assert(!blame.length, blame.join(" | "));
    return `${sessions.length} sessions, no owner-facing line names a different agent`;
  });

  await test("12 a non-isolated integration never receives a merge-the-session-branch instruction", async () => {
    // the engine refuses a contradictory instruction before it can reach a
    // session, so what is checked here is the outcome; the exact wording rule
    // is exercised against the real corpus in scripts/test-review-units.mjs
    const orders = (text) => [...text.matchAll(/\bmerg(?:e|ing)\b/gi)]
      .filter((m) => !/\b(no|not|never|nothing|none|don'?t|cannot|can'?t|without|avoid|skip)\b[^.?!]{0,24}$/i.test(text.slice(Math.max(0, m.index - 40), m.index)))
      .filter((m) => !/^\s*(commit|conflict|marker|base|request|strategy|point|history)/i.test(text.slice(m.index + m[0].length)))
      .filter((m) => /\bbranch(es)?\b|\bworktree(s)?\b/i.test(text.slice(Math.max(0, m.index - 40), m.index + 90)))
      .map((m) => text.slice(Math.max(0, m.index - 30), m.index + 110).trim());
    for (const s of ints) {
      const isolatedSiblings = sessions.filter((x) => x.milestoneId === s.milestoneId && x.key !== s.key && x.branch);
      if (isolatedSiblings.length) {
        assert(/session branches/.test(s.prompt), `${s.key} had isolated siblings but was not given their branches`);
        continue;
      }
      assert(/there is no session branch to merge/.test(s.prompt), `${s.key} was not told the in-place topology`);
      const hits = orders(s.prompt.slice(s.prompt.indexOf("already established")));
      assert(!hits.length, `${s.key} was told to merge a branch that does not exist: ${hits[0]}`);
    }
    return `${ints.length} integration session(s), topology consistent`;
  });

  await test("13 a Reviewer that hit its ceiling is recorded as incomplete, never as a pass", async () => {
    const hit = sessions.filter((s) => s.reviewStatus === "incomplete");
    if (!hit.length) return "no reviewer exhausted its budget this run";
    const md = await (await fetch(`${BASE}/api/projects/${projectId}/export?format=markdown`, { headers: { cookie } })).text();
    for (const s of hit) {
      assert(s.lastVerdict !== "pass", `${s.key} is incomplete yet carries a pass verdict`);
      assert(md.includes("INCOMPLETE — the reviewer could not finish"), `${s.key}'s incomplete review is not stated in the export`);
    }
    return `${hit.map((s) => s.key).join(", ")} recorded incomplete`;
  });

  await test("14 no scratch, log or note file entered a checkpoint or the delivery", async () => {
    const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
    evidence.deliveredFiles = tracked;
    const junk = tracked.filter((f) => /\.(log|tmp|pid)$|(^|\/)(server\.log|nohup\.out|\.DS_Store)$/i.test(f));
    assert(!junk.length, `these were delivered: ${junk.join(", ")}`);
    return `${tracked.length} files, none of them run artifacts`;
  });

  await test("15 the delivery cleanliness guard is still in force", async () => {
    // plant a file no agent wrote, commit it as the engine would, and ask to deliver
    const probe = path.join(root, "leftover.log");
    fs.writeFileSync(probe, "planted by the acceptance run\n");
    execFileSync("git", ["add", "leftover.log"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Nexora OS", "-c", "user.email=nexora@agent24.io", "commit", "-qm", "nexora: checkpoint probe"], { cwd: root });
    const token = fs.readFileSync(path.join(DATA_DIR, "internal-token"), "utf8").trim();
    const r = await (await fetch(`${BASE}/api/internal/director`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, projectId, op: "deliver", args: {} }) })).json();
    execFileSync("git", ["reset", "-q", "--hard", "HEAD~1"], { cwd: root });
    assert(!r.ok, "delivery accepted a file nobody intentionally committed");
    assert(/leftover\.log/.test(r.error ?? ""), `the guard did not name the file: ${String(r.error).slice(0, 200)}`);
    return "an unintended file still blocks delivery, and is named";
  });

  await test("16 the final repository state is clean and delivered", async () => {
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const same = execFileSync("git", ["rev-parse", branch, proj.integrationBranch], { cwd: root, encoding: "utf8" }).trim().split("\n");
    evidence.git = { branch, base: proj.baseBranch, integration: proj.integrationBranch, dirty: status || "(clean)" };
    assert(!status, `the working tree is dirty: ${status.slice(0, 200)}`);
    assert(same[0] === same[1], `${branch} does not equal ${proj.integrationBranch}`);
    return `${branch} == ${proj.integrationBranch}, tree clean`;
  });

  await test("17 the project completed", async () => {
    assert(proj.state === "COMPLETED", `project state is ${proj.state}`);
    return `COMPLETED in ${Math.round(elapsed / 60)}m`;
  });

  const tok = sessions.reduce((a, s) => ({ i: a.i + (s.tokens?.input ?? 0), o: a.o + (s.tokens?.output ?? 0), t: a.t + (s.tokens?.turns ?? 0) }), { i: 0, o: 0, t: 0 });
  const msgs = db.projectMessages.filter((m) => m.projectId === projectId && m.usage);
  evidence.cost = {
    runtime: `${runtime.runtimeType}/${runtime.model}`,
    sessionTurns: tok.t, sessionInput: tok.i, sessionOutput: tok.o,
    directorTurns: msgs.length,
    directorInput: msgs.reduce((n, m) => n + (m.usage.inputTokens ?? 0), 0),
    directorOutput: msgs.reduce((n, m) => n + (m.usage.outputTokens ?? 0), 0),
    totalSteps: sessions.reduce((n, s) => n + (s.steps ?? []).length, 0),
    browserCalls: sessions.reduce((n, s) => n + browserSteps(s).length, 0),
    seconds: elapsed,
  };

  console.log("\n--- evidence ---");
  console.log(JSON.stringify(evidence, null, 1));
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} acceptance checks passed`);
  if (passed < results.length) console.log(`failed: ${results.filter((r) => !r.ok).map((r) => r.name).join(" | ")}`);
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
