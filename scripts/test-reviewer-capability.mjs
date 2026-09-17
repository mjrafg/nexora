#!/usr/bin/env node
/* ------------------------------------------------------------------
   What a Reviewer is given, and what happens when it is not given it.

   In the Mini Notes run a Reviewer was asked to judge work whose
   definition of done was `npm install && npm run build && npm test`,
   and handed Read, Glob and Grep. It asked for command execution, said
   so plainly, and the engine turned that sentence into
   "[major] Reviewer reported issues (unstructured output)", spent one of
   two review rounds on it, and sent the Builder to repair nothing.

   A second Reviewer said: "This session gave me the changed-file list
   but not the builder's written evidence block, and I have no shell
   here." The report existed; the engine never passed it on.

     node --experimental-strip-types scripts/test-reviewer-capability.mjs
   ------------------------------------------------------------------ */

const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push(true); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push(false); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 300)}`); }
}

const { isUnstructuredGuess, parseVerdict, UNSTRUCTURED_TITLE } = await import("../src/lib/projects/verdict.ts");

/* ---------------- capability: the verdict boundary ---------------- */

const YIELD = "I've requested command-execution access and will resume the build/test verification when it lands. Static review so far: source is clean, no `any`, tree has no stray or sample data, three well-described commits.";

await test("the real capability-wait yield is recognised as the parser guessing, not as a finding", async () => {
  const p = parseVerdict(YIELD);
  assert(p.verdict === "findings", "the parser no longer produces its fallback — this test is stale");
  assert(isUnstructuredGuess(p.items), `the engine cannot tell its own guess apart: ${JSON.stringify(p.items.map((i) => i.title))}`);
  assert(p.items[0].title === UNSTRUCTURED_TITLE, "the guess is not the named one");
  return "recognised";
});

await test("a real review is never mistaken for the parser's guess", async () => {
  const real = parseVerdict([
    "FINDINGS",
    "1. [major] getById hands out live internal note objects — src/store.ts:41",
    "   The stored object is returned by reference, so callers mutate state in place.",
    "   Recommendation: return a copy.",
    "2. [minor] Unused dump() helper in the store tests",
    "   Dead scaffolding a later reader will assume is load-bearing.",
  ].join("\n"));
  assert(real.verdict === "findings" && real.items.length === 2, `parsed ${real.items.length} findings`);
  assert(!isUnstructuredGuess(real.items), "two real findings were treated as the parser's guess");
  const pass = parseVerdict("PASS");
  assert(pass.verdict === "pass" && !isUnstructuredGuess(pass.items), "a pass was treated as a guess");
  return "2 real findings and a PASS all survive";
});

await test("a Reviewer blocked AFTER finding real defects keeps them", async () => {
  // the engine only overrides its own guess; a reply with structured findings
  // is a real review whether or not the session also asked for a capability
  const mixed = parseVerdict([
    "FINDINGS",
    "1. [major] Store mutates callers' objects — src/store.ts:41",
    "   Returned by reference.",
    "I have also requested command execution so I can run the build; that part is unverified.",
  ].join("\n"));
  assert(mixed.items.length === 1 && !isUnstructuredGuess(mixed.items), "a genuine finding was discarded as unstructured");
  return "findings preserved alongside the blocker";
});

/* ---------------- capability: the narrowing ---------------- */

const { scopePermissions } = await import("../src/lib/projects/capability-scope.ts");
const turnCapabilities = (a, role, granted) => ({ permissions: scopePermissions(a.toolPermissions, role, granted) });
const agent = (perms) => ({ toolPermissions: perms });

await test("an authorized Reviewer keeps command execution; an unauthorized one does not", async () => {
  const withIt = turnCapabilities(agent(["read_files", "browser", "run_commands"]), "reviewer");
  assert(withIt.permissions.includes("run_commands"), `stripped from an agent that holds it: ${withIt.permissions}`);
  const without = turnCapabilities(agent(["read_files", "browser"]), "reviewer");
  assert(!without.permissions.includes("run_commands"), "invented for an agent that does not hold it");
  return `held → ${withIt.permissions.join("|")}, not held → ${without.permissions.join("|")}`;
});

await test("a Reviewer still cannot write, spend, or use company logins", async () => {
  const c = turnCapabilities(agent(["read_files", "browser", "run_commands", "write_files", "payments", "credentials", "company_profile_manage"]), "reviewer");
  for (const banned of ["write_files", "payments", "credentials", "company_profile_manage"]) {
    assert(!c.permissions.includes(banned), `${banned} survived the reviewer narrowing`);
  }
  return `kept only ${c.permissions.join(", ")}`;
});

await test("a session grant reaches the Reviewer, and a Builder is unaffected", async () => {
  // the live run caught this: the narrowing kept run_commands when the AGENT
  // held it, but session grants were passed to the Builder only, so a Director
  // granting commands to a session left its Reviewer with Read/Glob/Grep
  const granted = turnCapabilities(agent(["read_files", "browser"]), "reviewer", ["run_commands"]);
  assert(granted.permissions.includes("run_commands"), "a Director grant did not reach the Reviewer");
  const overreach = turnCapabilities(agent(["read_files"]), "reviewer", ["write_files", "payments", "credentials"]);
  for (const b of ["write_files", "payments", "credentials"]) assert(!overreach.permissions.includes(b), `${b} reached the Reviewer through a session grant`);
  const b = turnCapabilities(agent(["read_files", "write_files", "run_commands", "browser"]), "builder");
  for (const p of ["read_files", "write_files", "run_commands", "browser"]) assert(b.permissions.includes(p), `builder lost ${p}`);
  return "grant honoured, builder untouched";
});

/* ---------------- environment ---------------- */

const { scrubAgentEnv } = await import("../src/lib/runtime/child-env.ts");
const childEnv = (extra = {}) => scrubAgentEnv({ ...process.env, ...extra });

await test("an agent's workspace does not inherit Nexora's own NODE_ENV", async () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const env = childEnv();
    assert(env.NODE_ENV === undefined, `NODE_ENV=${env.NODE_ENV} leaked into the child — npm install would skip devDependencies`);
    assert(childEnv({ NODE_ENV: "production" }).NODE_ENV === undefined || childEnv({ NODE_ENV: "production" }).NODE_ENV === "production", "explicit callers are handled consistently");
    assert(env.PATH !== undefined, "the rest of the environment was lost with it");
  } finally {
    if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before;
  }
  return "scrubbed at the child boundary, PATH intact";
});

/* ---------------- evidence handoff ---------------- */

const { evidenceFields } = await import("../src/lib/projects/evidence.ts");
const fs = await import("node:fs");

await test("the Reviewer is handed the worker's report and the engine's own execution records", async () => {
  const f = evidenceFields({
    snapshot: "commit abc1234",
    report: "I ran the suite and everything passes.",
    executions: [{ command: "npm test", cwd: "/w", status: "done", exitCode: 0, durationMs: 4200, output: "12 passed" }],
  }, "S2.2");
  assert(/commit abc1234/.test(f.snapshot), `snapshot not identified: ${f.snapshot}`);
  assert(/S2\.2/.test(f.snapshot), "the session is not named");
  assert(/I ran the suite and everything passes/.test(f.report), "the worker's report was dropped — the exact S2.2 complaint");
  assert(/npm test/.test(f.executions) && /exit 0/.test(f.executions), `the engine's execution record was dropped: ${f.executions}`);
  assert(/12 passed/.test(f.executions), "command output was dropped");
  return "snapshot, report and executions all present";
});

await test("absence is stated, never left blank", async () => {
  const f = evidenceFields({ report: "", executions: [] }, "S1");
  assert(/left no written report/.test(f.report), `a missing report is silently blank: ${f.report}`);
  assert(/no command executions/.test(f.executions), "an absent execution record is silently blank");
  assert(/nothing here has been observed running/.test(f.executions), "the reviewer is not told the claims are unobserved");
  return "absence explicit";
});

await test("a huge log is summarised, not dropped, and says where the rest is", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ command: `step-${i}`, status: "done", exitCode: 0, output: "x".repeat(2000) }));
  const f = evidenceFields({ executions: many }, "S3");
  assert(/step-39/.test(f.executions), "the most recent command was cut");
  assert(!/step-0\b/.test(f.executions), "every command was included — reports will not stay manageable");
  assert(/earlier command\(s\) omitted/.test(f.executions), "omission is silent");
  assert(/step record holds/.test(f.executions), "no pointer to the retrievable full record");
  assert(/truncated/.test(f.executions), "long output was cut without saying so");
  return `${f.executions.length} chars, newest kept, omission stated`;
});

await test("the delivered section separates a claim from an observation", async () => {
  // the wording lives in the Prompt Registry, so check the registered default
  const defs = fs.readFileSync("src/lib/prompts/defs/project.ts", "utf8");
  const i = defs.indexOf("project-reviewer-evidence-section");
  assert(i > 0, "the evidence section is not registered as a prompt");
  const block = defs.slice(i, i + 2000);
  const claims = block.indexOf("claims, not established fact");
  const observed = block.indexOf("recorded by the engine, not written by the worker");
  assert(claims > 0, "the worker's report is not labelled as a claim");
  assert(observed > claims, "engine-observed executions are not distinguished from the worker's prose");
  return "provenance labelled in the registered prompt";
});

await test("a nonzero exit is surfaced even when only the output carries it", async () => {
  const f = evidenceFields({ executions: [{ command: "npm test", status: "failed", output: "Exit code 2\nls: cannot access 'node_modules/.bin'" }] }, "S1");
  assert(/failed/.test(f.executions), "a failed command does not say so");
  assert(/exit 2/.test(f.executions), `the exit code in the output was not surfaced: ${f.executions}`);
  return "status and exit code both shown";
});

await test("a wrapped command cannot pass its pipeline's success off as its own", async () => {
  for (const cmd of ["npm test | tee /tmp/out.log", "npm run build | tail -5", "vitest run || true", "npm test; true"]) {
    const f = evidenceFields({ executions: [{ command: cmd, status: "done", exitCode: 0 }] }, "S1");
    assert(/status above is the pipeline's/.test(f.executions), `no caveat on: ${cmd}`);
  }
  const plain = evidenceFields({ executions: [{ command: "npm test", status: "done", exitCode: 0 }] }, "S1");
  assert(!/status above is the pipeline's/.test(plain.executions), "a plain command was wrongly caveated");
  return "4 wrapped commands caveated, a plain one left alone";
});

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
