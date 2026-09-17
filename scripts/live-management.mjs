#!/usr/bin/env node
/* ------------------------------------------------------------------
   The management loop, with a real model.

   One owner message to a manager has to end with the owner holding the
   finished result — without ever asking "did it finish?". This script
   proves the whole chain, not the first link:

     owner → manager inspects its team → creates and assigns a real task
           → the employee wakes by itself → does the work → completes it
           → the manager is told → the manager reports back in the SAME
             conversation the owner used.

   It uses throwaway agents ("LIVE …") and a read-only errand, so nothing
   the company owns is touched.

   Usage: node scripts/live-management.mjs [baseUrl] [--keep]
   ------------------------------------------------------------------ */
import { api, login, sleep, banner, pass, summary, findRuntime } from "./live-lib.mjs";

const BASE = process.argv[2] || "http://localhost:3111";
const KEEP = process.argv.includes("--keep");
const tag = Date.now().toString(36).slice(-5);

await login(BASE);
const runtime = await findRuntime();
banner(`live management cycle · ${BASE} · runtime ${runtime.runtimeType}/${runtime.model}`);

const made = [];
const mk = async (name, role, perms, instructions) => {
  const { agent } = await api("/api/agents", { name, role, dept: "engineering", toolPermissions: perms, instructions, runtime });
  made.push(agent.id);
  return agent;
};

const manager = await mk(
  `LIVE Manager ${tag}`, "Engineering Manager", [],
  "You run a small engineering team. You are being tested for one thing: turning what the owner wants into work your team actually does, and coming back with the answer."
);
const employee = await mk(
  `LIVE Analyst ${tag}`, "Operations Analyst", ["company_profile"],
  "You do the work you are given, with the tools you have, and you report exactly what you found — never what you assume."
);
await api(`/api/agents/${employee.id}`, { managerAgentId: manager.id }, "PATCH");

/* ---------------------------------------------------------------- the ask */

const OBJECTIVE =
  "Review the company information available in Nexora and prepare a concise report of which signup-relevant fields are present and which are missing. Do not change company information.";

const t0 = Date.now();
const sent = await api(`/api/agents/${manager.id}/messages`, { message: OBJECTIVE });
const ownerChatId = sent.assistant.chatId;
console.log(`\nowner → ${manager.name} (chat ${ownerChatId})`);
console.log(`${manager.name}: ${sent.assistant.content.trim().slice(0, 400)}\n`);

const evidence = { ownerChatId, managerId: manager.id, employeeId: employee.id };

/* ---------------------------------------------------------------- 1. the manager looked at its team */

// CLI runtimes report their tool use as activity, not as toolCalls — read both
const toolsUsed = (m) => [
  ...((m?.toolCalls ?? []).map((c) => c.name)),
  ...((m?.activity ?? []).filter((e) => e.kind === "tool").map((e) => e.title)),
];
const mgrCalls = toolsUsed(sent.assistant);
pass("manager inspected its team before deciding", mgrCalls.some((n) => /list_team/.test(n)), mgrCalls.join(", ") || "no tool calls");

/* ---------------------------------------------------------------- 2. a real task exists, assigned to the employee */

const mine = async () => (await api("/api/tasks")).tasks.filter((t) => t.createdBy?.id === manager.id || t.assignedTo?.id === employee.id);
let task = (await mine())[0];
for (let i = 0; i < 20 && !task; i++) { await sleep(500); task = (await mine())[0]; }
pass("the manager created a real persistent task", !!task, task ? `${task.id} — “${task.title}”` : "no task was created");
if (!task) { await cleanup(); summary(); process.exit(1); }
evidence.taskId = task.id;
pass("it was assigned to the employee, chosen from the team", task.assignedTo?.id === employee.id, `assigned to ${task.assignedTo?.name ?? "nobody"}`);
pass("priority was reasoned about, not defaulted to CRITICAL", task.priority !== "CRITICAL", `priority ${task.priority}`);

/* ---------------------------------------------------------------- 3. the employee started on its own */

const taskOf = async (id) => (await api(`/api/tasks/${id}`)).task;
const waitTask = async (id, pred, ms) => {
  for (let i = 0; i < ms / 1000; i++) { const t = await taskOf(id); if (pred(t)) return t; await sleep(1000); }
  return taskOf(id);
};
const started = await waitTask(task.id, (t) => t.status !== "TODO", 60_000);
pass("the employee started without being told to", started.status !== "TODO" && !!started.startedAt, `status ${started.status}`);
pass("the work has its own conversation", !!started.chatId, started.chatId ?? "none");

/* ---------------------------------------------------------------- 4. it finished, honestly */

const done = await waitTask(task.id, (t) => t.status === "DONE" || t.status === "BLOCKED" || t.status === "CANCELLED", 300_000);
evidence.finalStatus = done.status;
pass("the employee carried it through to a result", done.status === "DONE", `status ${done.status}${done.blockedReason ? ` — ${done.blockedReason}` : ""}`);
pass("the result says what was actually found", (done.resultSummary ?? "").length > 60, (done.resultSummary ?? "").slice(0, 300));
evidence.resultSummary = done.resultSummary;
evidence.result = done.result;

// the task flips to DONE the moment complete_task runs; the turn's own record
// (and with it the list of tools it used) is written when the turn ends
let work = [];
for (let i = 0; i < 90; i++) {
  work = (await api(`/api/agents/${employee.id}/messages?chat=${done.chatId}`)).messages;
  if (work.some((m) => m.role === "assistant")) break;
  await sleep(1000);
}
const workCalls = work.flatMap((m) => toolsUsed(m));
pass("it read the real Company Profile rather than inventing one", workCalls.some((n) => /company/i.test(n)), workCalls.join(", ").slice(0, 300) || "no tool calls");

/* ---------------------------------------------------------------- 5. the manager heard, and told the owner */

const history = (await api(`/api/tasks/${task.id}`)).history;
evidence.statusHistory = history.map((e) => `${e.at} ${e.kind}: ${e.text}`.slice(0, 160));

let ownerMsgs = [];
let reported = null;
for (let i = 0; i < 180; i++) {
  ownerMsgs = (await api(`/api/agents/${manager.id}/messages?chat=${ownerChatId}`)).messages;
  reported = ownerMsgs.filter((m) => m.role === "assistant" && new Date(m.createdAt).getTime() > t0).at(-1);
  if (reported && ownerMsgs.indexOf(reported) > 1) break;
  await sleep(1000);
}
const notified = (await api(`/api/agents/${manager.id}/chats`)).chats ?? [];
evidence.managerChats = notified.map((c) => `${c.id} — ${c.title}`);

const late = ownerMsgs.filter((m) => new Date(m.createdAt).getTime() > new Date(started.startedAt).getTime());
const told = late.find((m) => m.role === "user" && m.origin === "system" && (m.content ?? "").includes(task.id));
pass("the manager was woken with the completion, in the owner's conversation", !!told, told ? "system message delivered to the owner thread" : "no completion wake found in the owner thread");

const final = late.filter((m) => m.role === "assistant").at(-1);
evidence.managerFinalMessage = final?.content?.slice(0, 1200);
const isReport = !!final && final !== sent.assistant && (final.content ?? "").length > 80;
pass("the manager reported the outcome back to the owner, unprompted", isReport, final ? final.content.trim().slice(0, 400) : "the manager never spoke again");
pass("the owner never had to ask whether it finished", isReport && !late.some((m) => m.role === "user" && m.origin !== "system"), "no owner follow-up was sent by this test");

/* ---------------------------------------------------------------- evidence */

console.log("\n--- evidence -------------------------------------------------");
console.log(JSON.stringify(evidence, null, 2));

await cleanup();
summary();

async function cleanup() {
  if (KEEP) { console.log(`\nkept: ${made.join(", ")}`); return; }
  // cancel this run's work first, so nothing is left running, then remove the
  // agents — which also closes anything they left waiting on the owner
  const mineNow = (await api("/api/tasks").catch(() => ({ tasks: [] }))).tasks.filter((t) => made.includes(t.assignedTo?.id) || made.includes(t.createdBy?.id));
  for (const t of mineNow) await api(`/api/tasks/${t.id}`, { cancel: { reason: "live management check cleanup" } }, "PATCH").catch(() => undefined);
  for (const id of made) await api(`/api/agents/${id}`, null, "DELETE").catch(() => undefined);
  console.log(`\ncleaned up ${made.length} test agents and ${mineNow.length} task(s)`);
}
