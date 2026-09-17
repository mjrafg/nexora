#!/usr/bin/env node
/* ------------------------------------------------------------------
   The parts of the review split that are pure functions: what a
   checkpoint is willing to commit, and whether an integration
   instruction contradicts the topology the engine itself created.

   No server and no model — these run against the source directly.

     node --experimental-strip-types scripts/test-review-units.mjs
   ------------------------------------------------------------------ */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push(true); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push(false); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 300)}`); }
}

// Node strips the types; both modules import nothing but node builtins, which
// is why the topology check lives in its own file rather than inside director.ts
const { checkpoint } = await import("../src/lib/projects/git.ts");
const { contradictsInPlaceTopology } = await import("../src/lib/projects/topology.ts");
const { reviewOutcome, reviewCoverageNote, sessionVerification } = await import("../src/lib/projects/review-status.ts");

// the registry is server-side; these stand in for it so the rule can be checked alone
const FAKE = {
  "project-builder-verify-light": "LIGHT: {{reviewer}} performs the acceptance verification after you.",
  "project-builder-verify-full": "FULL: you own the verification of this work.",
  "project-session-responsibility": "RESPONSIBILITY-START\n{{verification}}\nThis section decides who checks it.",
};
const fakePrompt = (id) => FAKE[id] ?? `<missing ${id}>`;
const fakeRender = (t, v) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? "");

const repos = [];
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-cp-"));
  repos.push(dir);
  const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "README.md"), "# base\n");
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@nexora.local"); g("config", "user.name", "cp test");
  g("add", "-A"); g("commit", "-qm", "start");
  return { dir, g, tracked: () => g("ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean) };
}

try {
  await test("a checkpoint commits the files the agent actually wrote", async () => {
    const { dir, tracked } = repo();
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>hi</h1>");
    const cp = await checkpoint(dir, "S1 build", [path.join(dir, "index.html")]);
    assert(cp, "nothing was checkpointed");
    assert(tracked().includes("index.html"), "the agent's own new file was not committed");
    return `committed ${cp.swept.join(", ")}`;
  });

  await test("a checkpoint leaves behind what no agent wrote", async () => {
    const { dir, tracked } = repo();
    fs.writeFileSync(path.join(dir, "app.js"), "console.log(1)");
    fs.writeFileSync(path.join(dir, "server.log"), "127.0.0.1 - - [x] GET /\n");
    const cp = await checkpoint(dir, "S1 build", [path.join(dir, "app.js")]);
    assert(cp, "nothing was checkpointed");
    assert(tracked().includes("app.js"), "real work was left out of the checkpoint");
    assert(!tracked().includes("server.log"), "a scratch log nobody wrote was swept into the commit");
    assert(cp.left.includes("server.log"), `the file left behind is not reported: ${JSON.stringify(cp.left)}`);
    assert(fs.existsSync(path.join(dir, "server.log")), "the file was deleted rather than left alone");
    return "app.js committed, server.log left in the tree";
  });

  await test("edits to tracked files are always committed, written or not", async () => {
    const { dir, g } = repo();
    fs.writeFileSync(path.join(dir, "README.md"), "# changed by a shell command\n");
    const cp = await checkpoint(dir, "S1 build", ["/nowhere/else.txt"]);
    assert(cp, "a tracked-file edit produced no checkpoint");
    assert(g("show", "--stat", "--oneline", "HEAD").includes("README.md"), "a tracked edit was not committed");
    return "tracked edits never depend on the step record";
  });

  await test("with no step record at all, the old sweep-everything behaviour stands", async () => {
    const { dir, tracked } = repo();
    fs.writeFileSync(path.join(dir, "whatever.txt"), "x");
    const cp = await checkpoint(dir, "S1 build");
    assert(cp && tracked().includes("whatever.txt"), "work was lost when no provenance was available");
    return "missing provenance never silently drops work";
  });

  await test("every merge-the-session-branch instruction from the real run is caught", async () => {
    // verbatim from the Mini Habit Tracker integration sessions, each of which
    // was handed these straight after being told no session branch existed
    const real = [
      "Merge the M1.1 session branch into the integration branch. Resolve any trivial conflicts honestly (there should be none since this is the first milestone).",
      "Merge the M2.1 session branch into the integration branch (on top of the already-merged M1 work). Resolve any conflicts honestly.",
      "Merge the M3.1 session branch (QA report + any bug fixes) into the integration branch on top of the already-merged M1/M2 work.",
      "First, merge the session worktree branch, then validate.",
      "Merging the S1.1 branch into integration is the first step.",
    ];
    for (const r of real) assert(contradictsInPlaceTopology(r), `not caught: ${r.slice(0, 70)}`);
    return `${real.length} caught`;
  });

  await test("instructions that merely mention merging are not refused", async () => {
    const fine = [
      "The sessions committed directly onto the integration branch, so nothing needs merging.",
      "Validate in place. Confirm index.html exists and the build passes.",
      "Check that no merge conflict markers remain in any file.",
      "Confirm the working tree is clean and the branch history is linear.",
      "There is no session branch to merge; the work is already here.",
      "Do not merge any branch \u2014 validate in place.",
      "The work was already merged onto the integration branch by the sessions themselves.",
      "Run npm test and report the results.",
      "Verify the merge commit for M1 is present on the branch.",
      "Inspect git log on the integration branch and confirm the expected commits.",
      "Resolve any merge conflicts honestly if you find them.",
    ];
    for (const r of fine) {
      const hit = contradictsInPlaceTopology(r);
      assert(!hit, `false positive on "${r.slice(0, 60)}" -> ${hit}`);
    }
    return `${fine.length} accepted`;
  });

  await test("the policy answers the review question before the session has run", async () => {
    assert(reviewOutcome({ reviewPolicy: "none" }) === "skipped", "a session excused from review reads as 'nothing to review' before it runs");
    assert(reviewOutcome({ reviewPolicy: "required" }) === "not_applicable", "an unrun required session already claims an outcome");
    assert(reviewOutcome({ reviewPolicy: "required", lastVerdict: "pass" }) === "passed", "a pass is not reported");
    assert(reviewOutcome({ reviewPolicy: "none", reviewStatus: "incomplete" }) === "incomplete", "what actually happened must outrank the policy");
    return "policy first, then what happened";
  });

  await test("delivery names what it is shipping unreviewed, and nothing else", async () => {
    const note = reviewCoverageNote([
      { key: "D1", status: "completed", reviewStatus: "incomplete", reviewPolicy: "required" },
      { key: "D2", status: "completed", reviewStatus: null, reviewPolicy: "none" },
      { key: "D3", status: "completed", reviewStatus: "passed", reviewPolicy: "required" },
      { key: "D4", status: "abandoned", reviewStatus: null, reviewPolicy: "none" },
    ]);
    assert(/NOT REVIEWED/.test(note), `an unfinished review is not called out: ${note}`);
    assert(/\bD1\b/.test(note), "the session whose reviewer never finished is not named");
    assert(/No independent review by your own decision on: D2/.test(note), `the excused session is not named as the Director's own choice: ${note}`);
    assert(!/\bD3\b/.test(note), "a session that passed review was listed as unreviewed");
    assert(!/\bD4\b/.test(note), "a session that was never delivered was listed");
    assert(reviewCoverageNote([{ key: "X", status: "completed", reviewStatus: "passed", reviewPolicy: "required" }]) === "", "a fully reviewed delivery still says something");
    return note.slice(0, 96);
  });

  await test("a required review on a build session hands acceptance to the Reviewer", async () => {
    const r = sessionVerification({ policy: "required", kind: "build", reviewerName: "Pixel", prompt: fakePrompt, render: fakeRender });
    assert(r.owner === "reviewer", `owner is ${r.owner}`);
    assert(/LIGHT: Pixel performs/.test(r.responsibility), `the Builder was not pointed at the Reviewer by name: ${r.responsibility}`);
    assert(/This section decides who checks it/.test(r.responsibility), "the engine's closing word is missing");
    assert(/Pixel still performs the acceptance pass/.test(r.repairScope), `a repair turn loses the split: ${r.repairScope}`);
    return "reviewer owns acceptance, named to the Builder";
  });

  await test("the session owns its own verification when nobody else will do it", async () => {
    for (const [policy, kind] of [["none", "build"], ["spot_check", "build"], ["spot_check", "qa"], ["required", "qa"], ["none", "cleanup"]]) {
      const r = sessionVerification({ policy, kind, reviewerName: "Pixel", prompt: fakePrompt, render: fakeRender });
      assert(r.owner === "builder", `${policy}/${kind} handed acceptance to the reviewer`);
      assert(/FULL: you own the verification/.test(r.responsibility), `${policy}/${kind} got the light brief`);
    }
    // the one that caused the duplicate run: required + qa must NOT go light
    const qa = sessionVerification({ policy: "required", kind: "qa", reviewerName: "Pixel", prompt: fakePrompt, render: fakeRender });
    assert(qa.owner === "builder", "a QA session was told not to test");
    return "none, spot_check and qa all keep verification in the session";
  });

  await test("the engine's word on verification is wrapped so it can come last", async () => {
    const r = sessionVerification({ policy: "required", kind: "build", reviewerName: "Pixel", prompt: fakePrompt, render: fakeRender });
    const i = r.responsibility.indexOf("RESPONSIBILITY-START");
    const j = r.responsibility.indexOf("LIGHT:");
    const k = r.responsibility.indexOf("This section decides who checks it");
    assert(i === 0, "the responsibility block does not start with its own header");
    assert(i < j && j < k, `the verification text is not inside the wrapper: ${r.responsibility}`);
    return "wrapper opens, verification inside, engine closes";
  });

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
} finally {
  for (const d of repos) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
}
process.exit(results.every(Boolean) ? 0 : 1);
