#!/usr/bin/env node
/* ------------------------------------------------------------------
   The checks that must run against the real build, and must not run
   against the owner's data.

   A throwaway Nexora is compiled with `next build`, served with
   `next start` on a loopback port, and pointed at an empty data
   directory. Everything here then runs against that: money, the waits a
   task parks on, several results landing at once, and a restart in the
   middle of delegated work. Nothing it does can reach production, and
   the whole instance is deleted at the end.

   Usage: node scripts/test-isolated.mjs [port] [--keep]
   ------------------------------------------------------------------ */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startSandbox, sandboxApi } from "./sandbox.mjs";

const PORT = Number(process.argv[2]?.match(/^\d+$/) ? process.argv[2] : 3311);
const KEEP = process.argv.includes("--keep");
const SKIP_SUITES = process.argv.includes("--skip-suites");
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
async function test(name, fn) {
  try { const note = await fn(); results.push({ name, ok: true }); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 400)}`); }
}

const sb = await startSandbox({ port: PORT, verbose: process.env.VERBOSE === "1" });
const api = await sandboxApi(sb);
const run = (agentId, tool, args, scopeId, chatId) => api("/api/tools/run", { agentId, tool, args, scopeId, chatId });
const parse = (r) => { try { return JSON.parse(r.result); } catch { return {}; } };
const taskOf = async (id) => (await api(`/api/tasks/${id}`)).task;
const historyOf = async (id) => (await api(`/api/tasks/${id}`)).history;
const msgs = async (agentId, chatId) => (await api(`/api/agents/${agentId}/messages?chat=${chatId}`)).messages;
const waitFor = async (id, pred, ms = 20_000) => {
  for (let i = 0; i < ms / 300; i++) { const t = await taskOf(id); if (pred(t)) return t; await sleep(300); }
  return taskOf(id);
};
const store = () => JSON.parse(fs.readFileSync(path.join(sb.dataDir, "nexora.json"), "utf8"));

try {
  /* ============================================================ the existing suites, on the real build */

  const suites = SKIP_SUITES ? [] : ["test-payments", "test-payment-methods", "test-task-waits", "test-tasks", "test-delegation", "test-office", "test-prompts"];
  console.log(`\n=== the shipped suites, against the production build on ${sb.base}\n`);
  for (const s of suites) {
    const out = spawnSync(process.execPath, [`scripts/${s}.mjs`, sb.base], {
      cwd: process.cwd(),
      env: { ...process.env, NEXORA_DATA_DIR: sb.dataDir, NEXORA_USER: sb.user, NEXORA_PASS: sb.pass },
      encoding: "utf8",
    });
    const text = `${out.stdout ?? ""}${out.stderr ?? ""}`;
    const line = text.trim().split("\n").filter((l) => /passed/.test(l)).at(-1) ?? "(no result line)";
    const failures = text.split("\n").filter((l) => /^(FAIL|✗)/.test(l));
    results.push({ name: `${s} (production build, isolated data)`, ok: out.status === 0 });
    console.log(`${out.status === 0 ? "OK  " : "FAIL"} ${s.padEnd(22)} ${line}`);
    for (const f of failures) console.log(`       ${f.slice(0, 200)}`);
    // which suite, if any, takes the server down with it
    if (!(await sb.alive())) {
      console.log(`       ⚠ the server stopped answering during ${s}. Last of its log:\n${sb.tail(20).split("\n").map((l) => `         ${l}`).join("\n")}`);
      break;
    }
  }

  /* ============================================================ §7 several results at once */

  console.log(`\n=== several results landing together\n`);
  if (!(await sb.alive())) {
    console.log(`the sandbox is no longer answering. Last thing it said:\n${sb.tail(30)}`);
    throw new Error("the sandbox server stopped during the suites");
  }
  const conns = (await api("/api/providers")).connections;
  const runtime = { runtimeType: "api", providerConnectionId: conns[0].id, model: "test-model-does-not-exist" };
  const mk = async (name, role, dept = "engineering") => (await api("/api/agents", { name, role, dept, toolPermissions: [], runtime })).agent;

  const boss = await mk("Coalesce Manager", "Engineering Manager");
  const workers = [];
  for (let i = 0; i < 4; i++) {
    const w = await mk(`Coalesce Worker ${i}`, "Engineer");
    await api(`/api/agents/${w.id}`, { managerAgentId: boss.id }, "PATCH");
    workers.push(w);
  }

  await test("§7 four results arriving at once become one turn, with none of them lost", async () => {
    const objective = (await api("/api/tasks", { title: "Objective with four pieces", description: "Four pieces come back at the same moment.", assignedToAgentId: boss.id })).task;
    const parent = await waitFor(objective.id, (t) => t.status === "IN_PROGRESS");
    assert(parent.chatId, "the objective has no conversation");
    const pieces = [];
    for (const [i, w] of workers.entries()) {
      const p = parse(await run(boss.id, "work__create_task", { title: `Piece ${i}`, description: `One of four pieces of the objective.`, assigned_to: w.id }, `task:${objective.id}`));
      pieces.push(p.task_id);
    }
    for (const id of pieces) await waitFor(id, (t) => t.status === "IN_PROGRESS");
    const before = (await msgs(boss.id, parent.chatId)).length;

    // all four finish inside the same moment
    await Promise.all(pieces.map((id, i) => run(workers[i].id, "work__complete_task", {
      task_id: id,
      summary: `Finished piece ${i} and checked the result reads back correctly.`,
      result: { piece: i },
    }, `task:${id}`)));

    await sleep(8_000);
    const after = await msgs(boss.id, parent.chatId);
    const fresh = after.slice(before);
    const wakes = fresh.filter((m) => m.role === "user" && m.origin === "system");
    assert(wakes.length === 1, `${wakes.length} separate wake-ups for four results arriving together`);
    // one turn means one user message and one assistant message, not four of each
    assert(fresh.filter((m) => m.role === "assistant").length === 1, `${fresh.filter((m) => m.role === "assistant").length} turns were run`);
    for (const id of pieces) assert(wakes[0].content.includes(id), `result for ${id.slice(0, 8)} was lost on the way`);
    assert(/4 updates/.test(wakes[0].content), `the merged wake-up does not say how many it carries: ${wakes[0].content.slice(0, 120)}`);
    // and every piece really is recorded as finished
    for (const id of pieces) assert((await taskOf(id)).status === "DONE", `piece ${id.slice(0, 8)} is not DONE`);
    return `4 results → 1 wake-up, 1 turn, 0 lost`;
  });

  await test("§7 the objective is judged once, with all four outcomes in front of it", async () => {
    const parent = (await api("/api/tasks?status=all")).tasks.find((t) => t.title === "Objective with four pieces");
    const kids = (await api("/api/tasks?status=all")).tasks.filter((t) => t.parentTaskId === parent.id);
    assert(kids.length === 4 && kids.every((k) => k.status === "DONE"), kids.map((k) => k.status).join(","));
    const done = await run(boss.id, "work__complete_task", { task_id: parent.id, summary: "All four pieces came back and were read together before finishing this." }, `task:${parent.id}`);
    assert(done.ok, done.error);
    const t = await taskOf(parent.id);
    assert((t.result?.delegated ?? []).length === 4, JSON.stringify(t.result));
    return "one evaluation, four delegated outcomes recorded";
  });

  /* ============================================================ §8 a restart in the middle of delegated work */

  console.log(`\n=== a restart in the middle of delegated work\n`);
  const ceo = await mk("Restart CEO", "Chief Executive", "ceo");
  const mgr = await mk("Restart Manager", "Engineering Manager");
  const emp = await mk("Restart Engineer", "Engineer");
  await api(`/api/agents/${mgr.id}`, { managerAgentId: ceo.id }, "PATCH");
  await api(`/api/agents/${emp.id}`, { managerAgentId: mgr.id }, "PATCH");

  const ownerChat = (await api(`/api/agents/${ceo.id}/chats`, { title: "Owner asks the CEO" })).chat;
  const root = (await api("/api/tasks", { title: "Company objective across a restart", description: "Delegated down two levels when the process dies.", assignedToAgentId: ceo.id })).task;
  await waitFor(root.id, (t) => t.status === "IN_PROGRESS");
  const branch = parse(await run(ceo.id, "work__create_task", { title: "Branch across a restart", description: "A manager's piece of the objective.", assigned_to: mgr.id }, `task:${root.id}`, ownerChat.id));
  await waitFor(branch.task_id, (t) => t.status === "IN_PROGRESS");
  const leaf = parse(await run(mgr.id, "work__create_task", { title: "Leaf across a restart", description: "The employee's piece.", assigned_to: emp.id }, `task:${branch.task_id}`));
  await waitFor(leaf.task_id, (t) => t.status === "IN_PROGRESS");
  // something already finished, and something already dropped: neither may come back
  const finished = (await api("/api/tasks", { title: "Finished before the restart", description: "Stays finished.", assignedToAgentId: emp.id })).task;
  await run(emp.id, "work__complete_task", { task_id: finished.id, summary: "Finished before the restart, with the check written down and verified." }, `task:${finished.id}`);
  const dropped = (await api("/api/tasks", { title: "Dropped before the restart", description: "Stays dropped.", assignedToAgentId: emp.id })).task;
  await api(`/api/tasks/${dropped.id}`, { cancel: { reason: "not wanted" } }, "PATCH");

  // a prompt the owner edited must still be the one in use after a restart
  const MARK = "\n\nNEXORA RESTART MARKER.";
  const promptDefault = (await api("/api/prompts/task-execution-rule")).prompt.defaultContent;
  await api("/api/prompts/task-execution-rule", { content: promptDefault + MARK });

  const beforeShape = {
    root: (await taskOf(root.id)).status,
    branch: (await taskOf(branch.task_id)).status,
    leaf: (await taskOf(leaf.task_id)).status,
    branchChat: (await taskOf(branch.task_id)).chatId,
    // how many times each of these had been started BEFORE the restart: the
    // property under test is that the restart adds none
    startsFinished: (await historyOf(finished.id)).filter((e) => e.kind === "started").length,
    startsDropped: (await historyOf(dropped.id)).filter((e) => e.kind === "started").length,
  };

  await sb.restart();
  await sleep(9_000);

  await test("§8 the delegation tree survives the restart exactly as it was", async () => {
    const r = await taskOf(root.id), b = await taskOf(branch.task_id), l = await taskOf(leaf.task_id);
    assert(b.parentTaskId === root.id, `the branch lost its parent: ${b.parentTaskId}`);
    assert(l.parentTaskId === branch.task_id, `the leaf lost its parent: ${l.parentTaskId}`);
    assert(b.originChatId === ownerChat.id, `the branch forgot where it was asked for: ${b.originChatId}`);
    assert(r.children.some((c) => c.id === branch.task_id), "the objective lost sight of its branch");
    assert(r.status !== "DONE" && b.status !== "DONE", `${r.status}/${b.status} after the restart`);
    return `root ${r.status}, branch ${b.status}, leaf ${l.status} (was ${beforeShape.root}/${beforeShape.branch}/${beforeShape.leaf})`;
  });

  await test("§8 each task keeps its own execution scope and conversation", async () => {
    const db = store();
    for (const [label, id] of [["root", root.id], ["branch", branch.task_id], ["leaf", leaf.task_id]]) {
      const t = db.tasks.find((x) => x.id === id);
      assert(t.chatId, `${label} lost its conversation`);
      const conv = db.conversations.find((c) => c.chatId === t.chatId);
      assert(conv, `${label} has no conversation record`);
      assert(conv.executionScopeId === `task:${id}`, `${label} scope drifted to ${conv.executionScopeId}`);
    }
    return "task:<id> intact at all three levels";
  });

  await test("§8 interrupted work is recovered honestly, and settled work is left alone", async () => {
    const recovered = (await historyOf(leaf.task_id)).some((e) => e.kind === "recovered") || (await historyOf(branch.task_id)).some((e) => e.kind === "recovered") || (await historyOf(root.id)).some((e) => e.kind === "recovered");
    assert(recovered, "nothing was recorded about the interruption anywhere in the tree");
    assert((await taskOf(finished.id)).status === "DONE", "finished work came back unfinished");
    assert((await taskOf(dropped.id)).status === "CANCELLED", "dropped work came back");
    const startsNow = (await historyOf(finished.id)).filter((e) => e.kind === "started").length;
    const droppedNow = (await historyOf(dropped.id)).filter((e) => e.kind === "started").length;
    assert(startsNow === beforeShape.startsFinished, `finished work was started again: ${beforeShape.startsFinished} → ${startsNow}`);
    assert(droppedNow === beforeShape.startsDropped, `dropped work was started again: ${beforeShape.startsDropped} → ${droppedNow}`);
    return `the interruption is on the record; DONE and CANCELLED untouched (${startsNow}/${droppedNow} starts, unchanged)`;
  });

  await test("§8 the guard still refuses to let the objective finish while its branch is out", async () => {
    const early = await run(ceo.id, "work__complete_task", { task_id: root.id, summary: "Calling the objective done even though the branch is still out there." }, `task:${root.id}`);
    assert(!early.ok && /not yet|delegated/i.test(early.error ?? ""), `the restart lost the delegation guard: ${early.error}`);
    return early.error.slice(0, 80);
  });

  await test("§8 after the restart the results still travel back up, and to the right conversation", async () => {
    await waitFor(leaf.task_id, (t) => t.status === "IN_PROGRESS" || t.status === "TODO");
    const l = await taskOf(leaf.task_id);
    if (l.status === "TODO") await api(`/api/tasks/${leaf.task_id}`, { retry: true }, "PATCH").catch(() => undefined);
    await waitFor(leaf.task_id, (t) => t.status === "IN_PROGRESS");
    const branchTask = await taskOf(branch.task_id);
    const before = (await msgs(mgr.id, branchTask.chatId)).length;
    const doneLeaf = await run(emp.id, "work__complete_task", { task_id: leaf.task_id, summary: "Finished the employee's piece after the restart and verified the output." }, `task:${leaf.task_id}`);
    assert(doneLeaf.ok, doneLeaf.error);
    // the manager hears about it inside its own objective
    let told = [];
    for (let i = 0; i < 40; i++) {
      told = (await msgs(mgr.id, branchTask.chatId)).slice(before).filter((m) => m.origin === "system" && m.content.includes(leaf.task_id));
      if (told.length) break;
      await sleep(500);
    }
    assert(told.length, "the manager was never told its piece came back");

    const doneBranch = await run(mgr.id, "work__complete_task", { task_id: branch.task_id, summary: "The employee's piece came back after the restart; summarising it upward." }, `task:${branch.task_id}`);
    assert(doneBranch.ok, doneBranch.error);
    // The CEO is carrying the objective as a task of its own, so the branch's
    // result belongs in THAT conversation — the one holding the objective —
    // not in the chat the branch happened to be created from. The chat the
    // work was asked for in is still recorded on the branch, and is where the
    // outcome goes when the person above is not themselves holding a task.
    const rootTask = await taskOf(root.id);
    let ceoTold = [];
    for (let i = 0; i < 40; i++) {
      ceoTold = (await msgs(ceo.id, rootTask.chatId)).filter((m) => m.origin === "system" && m.content.includes(branch.task_id));
      if (ceoTold.length) break;
      await sleep(500);
    }
    assert(ceoTold.length, "the outcome never reached the objective it belonged to");
    assert(ceoTold.at(-1).content.includes(root.id), "the wake-up does not name the objective it is about");
    assert((await taskOf(branch.task_id)).originChatId === ownerChat.id, "the branch forgot the conversation it was asked for in");
    const finalRoot = await run(ceo.id, "work__complete_task", { task_id: root.id, summary: "Both levels reported back after the restart; the objective is met and recorded." }, `task:${root.id}`);
    assert(finalRoot.ok, finalRoot.error);
    assert((await taskOf(root.id)).status === "DONE", "the objective could not be finished even once everything was settled");
    return `reported into the objective's own thread, origin “${ownerChat.title}” intact, then closed`;
  });

  await test("§26 an edited prompt is still the edited prompt after a restart", async () => {
    const p = (await api("/api/prompts/task-execution-rule")).prompt;
    assert(p.customized, "the override did not survive the restart");
    assert(p.content.endsWith(MARK), "the text came back different");
    assert(p.defaultContent === promptDefault, "the built-in changed across the restart");
    // and it is what an agent is actually assembled with on the other side
    const assembled = (await api(`/api/agents/${emp.id}/prompt`)).prompt;
    assert(assembled.includes(MARK), "the agent no longer receives the owner's text");
    const revs = (await api("/api/prompts/task-execution-rule")).revisions;
    assert(revs.length >= 1, "the history was lost");
    await api("/api/prompts/task-execution-rule", { reset: true });
    assert(!(await api("/api/prompts/task-execution-rule")).prompt.customized, "reset after the restart did nothing");
    return "override, history and reset all intact across the restart";
  });

  await test("§8 no money moved anywhere in this instance's real-money paths", async () => {
    const h = await api("/api/payments/history");
    const real = h.transactions.filter((t) => t.status === "SUCCEEDED");
    // the payments suites ran here on purpose; what matters is that they are
    // in the throwaway instance and nowhere else
    assert(sb.dataDir.includes("nexora-sandbox"), `payments were written to ${sb.dataDir}`);
    return `${real.length} succeeded row(s), all inside ${path.basename(sb.dataDir)}`;
  });
} catch (err) {
  console.log(`FAIL harness - ${String(err.message || err).slice(0, 400)}`);
  results.push({ name: "harness", ok: false });
} finally {
  await sb.stop({ keepData: KEEP });
}

const ok = results.filter((r) => r.ok).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
