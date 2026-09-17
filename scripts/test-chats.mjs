#!/usr/bin/env node
/* ------------------------------------------------------------------
   Chat threads, stopping a turn, context management and logs.

   Four things the owner asked for, verified end to end:
     - a Stop button that ends a running turn as stopped, not failed
     - several conversations per agent, each with its own transcript,
       provider session and execution scope
     - a context meter per chat that never invents a number, and
       compaction that is either provider-native or honestly refused
     - a complete log of everything, copyable and downloadable

   Usage: node scripts/test-chats.mjs [baseUrl] [--keep]
   ------------------------------------------------------------------ */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

/** The owner password for the instance under test. Never hardcoded: a real
  * deployment's login must not live in source control. */
function requirePassword() {
  const p = process.env.NEXORA_PASS;
  if (!p) throw new Error("Set NEXORA_PASS (the owner password for the Nexora instance you are testing).");
  return p;
}


const BASE = process.argv[2] || "http://localhost:3111";
const KEEP = process.argv.includes("--keep");
const USER = process.env.NEXORA_USER || "mjrafg";
const PASS = requirePassword();
const DATA_DIR = process.env.NEXORA_DATA_DIR || path.join(process.cwd(), "data");
let cookie = "";

async function api(url, body, method = body ? "POST" : "GET") {
  const r = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error ?? ""} ${j.detail ?? ""}`);
  return j;
}
async function raw(url) {
  const r = await fetch(`${BASE}${url}`, { headers: { cookie } });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
const results = [];
async function test(name, fn) {
  try { const note = await fn(); results.push({ name, ok: true }); console.log(`OK   ${name}${note ? ` - ${note}` : ""}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`FAIL ${name} - ${String(err.message || err).slice(0, 500)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const store = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) });
cookie = (login.headers.get("set-cookie") || "").split(";")[0];

/* A runtime that accepts the request and never answers: the only honest way to
   test Stop is to stop something that is genuinely still running. */
const hanging = http.createServer(() => { /* never respond */ });
await new Promise((res) => hanging.listen(0, "127.0.0.1", res));
const hangingUrl = `http://127.0.0.1:${hanging.address().port}`;

const conn = (await api("/api/providers", { name: `Test hang ${Date.now()}`, providerType: "custom", baseUrl: hangingUrl, auth: { kind: "none" } })).connection;
const runtime = { runtimeType: "api", providerConnectionId: conn.id, model: "test-model" };
const agent = (await api("/api/agents", { name: "Chat Threads Test", role: "Test", dept: "engineering", toolPermissions: [], runtime })).agent;
const A = agent.id;
const SECRET = `pw-${Math.random().toString(36).slice(2)}-never-in-a-log`;
let credentialId = null;
// the two threads the suite works with, held by id so an order change never
// makes a test assert against the wrong conversation
let hiring = null;
let lease = null;

try {
  await test("A - every stored message belongs to a thread, and every thread to a real agent", async () => {
    const db = store();
    const orphanMessages = db.messages.filter((m) => !m.chatId);
    assert(orphanMessages.length === 0, `${orphanMessages.length} messages have no chatId`);
    const agentIds = new Set(db.agents.map((a) => a.id));
    const orphanChats = (db.chats ?? []).filter((c) => !agentIds.has(c.agentId));
    assert(orphanChats.length === 0, `${orphanChats.length} threads have no agent`);
    const conv = db.conversations.filter((c) => !c.chatId);
    assert(conv.length === 0, `${conv.length} provider sessions are not attached to a thread`);
    return `${(db.chats ?? []).length} threads, ${db.messages.length} messages`;
  });

  await test("B - a first message creates a thread and titles it from what was said", async () => {
    // the runtime hangs, so stop the turn; the thread and its messages persist either way
    const send = api(`/api/agents/${A}/messages`, { message: "Draft the Q3 hiring plan" }).catch((e) => ({ error: String(e) }));
    await sleep(900);
    await api(`/api/agents/${A}/stop`, {});
    await send;
    const { chats } = await api(`/api/agents/${A}/chats`);
    assert(chats.length === 1, `expected one thread, got ${chats.length}`);
    hiring = chats[0].id;
    assert(chats[0].title === "Draft the Q3 hiring plan", `title is "${chats[0].title}"`);
    assert(chats[0].messageCount === 2, `thread holds ${chats[0].messageCount} messages`);
    return chats[0].title;
  });

  await test("C - Stop ends the turn as stopped, not as a failure", async () => {
    const { chats } = await api(`/api/agents/${A}/chats`);
    const { messages } = await api(`/api/agents/${A}/messages?chat=${hiring}`);
    const reply = messages.at(-1);
    assert(reply.role === "assistant", "last message is not the reply");
    assert(reply.stopped === true, `reply is not marked stopped: ${JSON.stringify(reply).slice(0, 200)}`);
    assert(!reply.error, `reply was recorded as an error: ${reply.error}`);
    assert(/stopped by you/i.test(reply.content), `reply reads: ${reply.content.slice(0, 120)}`);
    assert(chats.find((c) => c.id === hiring).lastStopped === true, "the chat list does not show the stop");
    return reply.content.slice(0, 60);
  });

  await test("D - stopping when nothing is running says so instead of pretending", async () => {
    const before = await api(`/api/agents/${A}/stop`);
    assert(before.running === false, "an agent with no turn reports as running");
    const r = await api(`/api/agents/${A}/stop`, {});
    assert(r.stopped === false, "stopping an idle agent claimed to stop something");
  });

  await test("E - a new chat is a separate conversation, not a continuation", async () => {
    const created = (await api(`/api/agents/${A}/chats`, {})).chat;
    lease = created.id;
    const send = api(`/api/agents/${A}/messages`, { message: "Unrelated: renew the office lease", chatId: created.id }).catch(() => null);
    await sleep(900);
    await api(`/api/agents/${A}/stop`, {});
    await send;
    const { chats } = await api(`/api/agents/${A}/chats`);
    assert(chats.length === 2, `expected two threads, got ${chats.length}`);
    const first = chats.find((c) => c.id === hiring);
    const second = chats.find((c) => c.id === lease);
    assert(first.messageCount === 2, `the first thread now holds ${first.messageCount} messages`);
    assert(second.title === "Unrelated: renew the office lease", `second title is "${second.title}"`);
    const a = await api(`/api/agents/${A}/messages?chat=${first.id}`);
    const b = await api(`/api/agents/${A}/messages?chat=${second.id}`);
    assert(!a.messages.some((m) => /office lease/.test(m.content)), "the second chat's message leaked into the first");
    assert(!b.messages.some((m) => /hiring plan/.test(m.content)), "the first chat's message leaked into the second");
    return `${chats.length} threads, isolated`;
  });

  await test("F - each thread carries its own provider session and execution scope", async () => {
    const { chats } = await api(`/api/agents/${A}/chats`);
    const convs = store().conversations.filter((c) => c.agentId === A);
    assert(convs.length === chats.length, `${convs.length} sessions for ${chats.length} threads`);
    const scopes = new Set(convs.map((c) => c.executionScopeId));
    assert(scopes.size === convs.length, "two threads share one execution scope");
    for (const c of convs) assert(chats.some((x) => x.id === c.chatId), `session ${c.chatId} points at no thread`);
    return `${convs.length} independent sessions`;
  });

  await test("G - renaming a thread pins the title against later auto-titling", async () => {
    const renamed = (await api(`/api/agents/${A}/chats/${hiring}`, { title: "Hiring · Q3" }, "PATCH")).chat;
    assert(renamed.title === "Hiring · Q3", `title is "${renamed.title}"`);
    assert(renamed.autoTitle === false, "the title is still Nexora's to change");
  });

  await test("H - archiving hides a thread without losing it", async () => {
    const victim = { id: lease };
    await api(`/api/agents/${A}/chats/${victim.id}`, { archived: true }, "PATCH");
    const open = (await api(`/api/agents/${A}/chats`)).chats;
    assert(!open.some((c) => c.id === victim.id), "an archived thread is still in the default list");
    const all = (await api(`/api/agents/${A}/chats?archived=1`)).chats;
    assert(all.some((c) => c.id === victim.id), "an archived thread disappeared entirely");
    const still = await api(`/api/agents/${A}/messages?chat=${victim.id}`);
    assert(still.messages.length === 2, "the archived thread lost its transcript");
    await api(`/api/agents/${A}/chats/${victim.id}`, { archived: false }, "PATCH");
  });

  await test("I - the context meter reports a real number and labels where it came from", async () => {
    const { usage } = await api(`/api/agents/${A}/messages?chat=${hiring}`);
    assert(usage, "no context usage returned with the transcript");
    assert(["provider", "estimated"].includes(usage.source), `source is ${usage.source}`);
    assert(typeof usage.total === "number" && usage.total > 0, `total is ${usage.total}`);
    // nothing reported a window for a made-up model: it must stay unknown, not be invented
    assert(usage.windowTokens === null || usage.windowTokens > 0, `window is ${usage.windowTokens}`);
    if (usage.windowTokens === null) assert(usage.pct === null, "a percentage was produced without a window");
    assert(usage.compact.available === false && usage.compact.reason, "an API runtime claims it can compact its own session");
    assert(usage.compact.worthwhile === false, "compaction is offered on a runtime that cannot do it");
    return `${usage.source}, ${usage.total} tokens, window ${usage.windowTokens ?? "unknown"}`;
  });

  await test("J - compaction a runtime cannot do is refused with the reason, never faked", async () => {
    const r = await fetch(`${BASE}/api/agents/${A}/chats/${hiring}/compact`, { method: "POST", headers: { cookie } });
    const j = await r.json();
    assert(r.status === 422, `status ${r.status}`);
    assert(j.outcome.ok === false, "a compaction that cannot happen reported success");
    assert(/no provider-side session|compact/i.test(j.outcome.error), `reason reads: ${j.outcome.error}`);
    const db = store();
    assert(!(db.chatCompactions ?? []).some((c) => c.chatId === hiring), "a failed compaction was recorded as one");
    return j.outcome.error.slice(0, 70);
  });

  await test("K - the log holds every message and every step, in order", async () => {
    const { messages } = await api(`/api/agents/${A}/messages?chat=${hiring}`);
    const { entries } = await api(`/api/agents/${A}/chats/${hiring}/logs`);
    assert(entries.length >= messages.length, `${entries.length} log entries for ${messages.length} messages`);
    for (const m of messages) assert(entries.some((e) => e.kind === "message" && e.messageId === m.id), `message ${m.id} is missing from the log`);
    const times = entries.map((e) => e.at);
    assert(times.every((t, i) => i === 0 || times[i - 1] <= t), "the log is not in chronological order");
    const stopped = entries.find((e) => e.stopped);
    assert(stopped, "the stop is not in the log");
    // a tool call must be findable as a tool whichever runtime recorded it
    assert(entries.every((e) => e.group), "a log entry has no group to filter by");
    return `${entries.length} entries`;
  });

  await test("L - the Markdown export is the whole conversation, as a file", async () => {
    const r = await raw(`/api/agents/${A}/chats/${hiring}/export?format=markdown`);
    assert(r.status === 200, `status ${r.status}`);
    assert(/attachment; filename=".+\.md"/.test(r.headers.get("content-disposition") ?? ""), `disposition: ${r.headers.get("content-disposition")}`);
    assert(r.text.includes("Hiring · Q3"), "the thread title is missing");
    assert(/hiring plan/i.test(r.text), "the owner's message is missing");
    assert(/Stopped by you/i.test(r.text), "the stopped reply is missing");
    assert(/Context at export/i.test(r.text), "the context reading is missing");
    return `${r.text.length} chars`;
  });

  await test("M - the JSON export is the same material, machine-readable", async () => {
    const r = await raw(`/api/agents/${A}/chats/${hiring}/export?format=json`);
    const b = JSON.parse(r.text);
    const { messages } = await api(`/api/agents/${A}/messages?chat=${hiring}`);
    assert(b.messages.length === messages.length, `${b.messages.length} exported vs ${messages.length} stored`);
    assert(b.agent.name === "Chat Threads Test", `agent is ${b.agent.name}`);
    assert(b.chat.id === hiring, "the export names another thread");
    assert(b.usage && b.exportedAt, "the export has no context reading or timestamp");
  });

  await test("N - the HTML export is a self-contained page that escapes what it shows", async () => {
    const injected = (await api(`/api/agents/${A}/chats`, { title: "<script>alert(1)</script>" })).chat;
    const send = api(`/api/agents/${A}/messages`, { message: "<img src=x onerror=alert(2)>", chatId: injected.id }).catch(() => null);
    await sleep(900);
    await api(`/api/agents/${A}/stop`, {});
    await send;
    const r = await raw(`/api/agents/${A}/chats/${injected.id}/export?format=html`);
    assert(r.status === 200 && /^<!doctype html>/i.test(r.text.trim()), "not a complete HTML document");
    assert(r.text.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the thread title was not escaped");
    assert(!/<img src=x onerror/.test(r.text), "the message was injected into the page as markup");
    await api(`/api/agents/${A}/chats/${injected.id}`, null, "DELETE");
  });

  await test("O - exports never carry a stored secret", async () => {
    credentialId = (await api("/api/credentials", { name: `test-chat-export-${Date.now()}`, values: { username: "tester", password: SECRET } })).credential.id;
    for (const format of ["markdown", "json", "html"]) {
      const r = await raw(`/api/agents/${A}/chats/${hiring}/export?format=${format}`);
      assert(!r.text.includes(SECRET), `the ${format} export contains a stored credential value`);
    }
    const { entries } = await api(`/api/agents/${A}/chats/${hiring}/logs`);
    assert(!JSON.stringify(entries).includes(SECRET), "the log contains a stored credential value");
  });

  await test("P - deleting a thread removes its transcript and nothing else", async () => {
    const { chats } = await api(`/api/agents/${A}/chats?archived=1`);
    const victim = chats.find((c) => c.id === lease);
    const before = store().messages.length;
    await api(`/api/agents/${A}/chats/${victim.id}`, null, "DELETE");
    const after = store();
    assert(!after.chats.some((c) => c.id === victim.id), "the thread is still there");
    assert(!after.messages.some((m) => m.chatId === victim.id), "its messages outlived it");
    assert(after.messages.length === before - victim.messageCount, "the wrong number of messages was removed");
    assert(!after.conversations.some((c) => c.chatId === victim.id), "its provider session outlived it");
    const kept = await api(`/api/agents/${A}/messages?chat=${hiring}`);
    assert(kept.messages.length === 2, "the other thread was disturbed");
  });

  await test("Q - removing the agent takes its threads with it", async () => {
    const throwaway = (await api("/api/agents", { name: "Chat Threads Throwaway", role: "Test", dept: "engineering", toolPermissions: [], runtime })).agent;
    const chat = (await api(`/api/agents/${throwaway.id}/chats`, {})).chat;
    await api(`/api/agents/${throwaway.id}`, null, "DELETE");
    const db = store();
    assert(!db.chats.some((c) => c.id === chat.id), "a deleted agent left a thread behind");
    assert(!db.messages.some((m) => m.agentId === throwaway.id), "a deleted agent left messages behind");
  });
} finally {
  hanging.close();
  if (!KEEP) {
    await api(`/api/agents/${A}`, null, "DELETE").catch(() => undefined);
    if (credentialId) await api(`/api/credentials/${credentialId}`, null, "DELETE").catch(() => undefined);
    await api(`/api/providers/${conn.id}`, null, "DELETE").catch(() => undefined);
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
