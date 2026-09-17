#!/usr/bin/env node
/* ------------------------------------------------------------------
   Does an edited prompt actually reach the model?

   Everything else about the registry can be proved by reading text back
   out of an API. This cannot: the only proof is a real model changing
   what it does because the owner changed what it was told. So this
   customizes one harmless prompt — the closing line of every system
   prompt — asks a throwaway agent a question, and looks for the token
   the customization asked for. Then it resets and asks again.

   It refuses to run while anything else is working, and it puts the
   built-in back even if it fails.

   Usage: node scripts/live-prompt.mjs [baseUrl]
   ------------------------------------------------------------------ */
import { api, login, sleep, banner, pass, summary, findRuntime } from "./live-lib.mjs";

const BASE = process.argv[2] || "https://com.agent24.io";
const PROMPT_ID = "agent-closing-line";
const TOKEN = `NEXORA-PROMPT-CHECK-${Date.now().toString(36).slice(-5).toUpperCase()}`;

await login(BASE);
const runtime = await findRuntime();
banner(`live prompt override · ${BASE} · runtime ${runtime.runtimeType}/${runtime.model}`);

// never do this while the company is mid-turn: the change is company-wide
const floor = await api("/api/office");
if (floor.totals.working > 0) {
  console.log(`FAIL ${floor.totals.working} agent(s) are working right now — not touching a shared prompt. Try again when the floor is quiet.`);
  process.exit(1);
}

const { agent } = await api("/api/agents", {
  name: `LIVE Prompt ${TOKEN.slice(-5)}`,
  role: "Test Subject",
  dept: "engineering",
  toolPermissions: [],
  instructions: "Answer briefly and plainly.",
  runtime,
});
const before = (await api(`/api/prompts/${PROMPT_ID}`)).prompt;
let customized = false;

const ask = async (what) => (await api(`/api/agents/${agent.id}/messages`, { message: what })).assistant.content ?? "";
/** A provider that refused is not an answer: it must never read as a pass. */
const runtimeFailed = (reply) => /Failed to authenticate|API Error:|usage limit|terminal_reason":"api_error/.test(reply);
let inconclusive = 0;
const modelCheck = (name, reply, ok, note) => {
  if (runtimeFailed(reply)) {
    inconclusive++;
    console.log(`SKIP ${name} — the runtime could not answer: ${reply.replace(/\s+/g, " ").slice(0, 120)}`);
    return;
  }
  pass(name, ok, note);
};

try {
  pass("the prompt starts out as the built-in", !before.customized, `v${before.version}, ${before.status}`);

  /* ---- with the owner's version ---- */
  await api(`/api/prompts/${PROMPT_ID}`, {
    content: `${before.defaultContent}\n\nFor this test only: end every reply with the exact token ${TOKEN} on its own last line.`,
  });
  customized = true;
  const now = (await api(`/api/prompts/${PROMPT_ID}`)).prompt;
  pass("the edit is stored and is what resolves", now.customized && now.content.includes(TOKEN), `status ${now.status}, customized from v${now.overrideBaseVersion}`);
  pass("the built-in text is untouched by the edit", now.defaultContent === before.defaultContent, "defaults are in source control, not in the database");

  const assembled = (await api(`/api/agents/${agent.id}/prompt`)).prompt;
  pass("the agent's assembled system prompt carries the owner's text", assembled.includes(TOKEN), `${assembled.length} characters assembled`);

  const withCustom = await ask("In one short sentence, what is Nexora?");
  console.log(`\nwith the customization:\n${withCustom.trim().slice(0, 300)}\n`);
  modelCheck("the model actually did what the customized prompt told it to", withCustom, withCustom.includes(TOKEN), withCustom.includes(TOKEN) ? `token ${TOKEN} present in the reply` : "the token is not in the reply");

  /* ---- and back ---- */
  await api(`/api/prompts/${PROMPT_ID}`, { reset: true });
  customized = false;
  const back = (await api(`/api/prompts/${PROMPT_ID}`)).prompt;
  pass("resetting removes the override and restores the built-in", !back.customized && back.content === before.defaultContent, `status ${back.status}`);
  pass("the reset is on the record", (await api(`/api/prompts/${PROMPT_ID}`)).revisions.some((r) => r.source === "RESET"), "history kept");

  const assembledAfter = (await api(`/api/agents/${agent.id}/prompt`)).prompt;
  pass("the agent's system prompt no longer carries it", !assembledAfter.includes(TOKEN), "back to the built-in assembly");

  await sleep(500);
  const withoutCustom = await ask("In one short sentence, what is Nexora?");
  console.log(`\nafter the reset:\n${withoutCustom.trim().slice(0, 300)}\n`);
  modelCheck("the model stops doing it once the built-in is back", withoutCustom, !withoutCustom.includes(TOKEN), withoutCustom.includes(TOKEN) ? "the token is STILL in the reply" : "no token, default behaviour");
} finally {
  if (customized) await api(`/api/prompts/${PROMPT_ID}`, { reset: true }).catch(() => undefined);
  await api(`/api/agents/${agent.id}`, null, "DELETE").catch(() => undefined);
  const end = (await api(`/api/prompts/${PROMPT_ID}`).catch(() => ({ prompt: { customized: true } }))).prompt;
  console.log(end.customized ? "WARNING: the prompt is still customized — reset it in Settings → Prompts" : "cleaned up: the prompt is back to its built-in, the test agent is gone");
}
if (inconclusive) console.log(`\n${inconclusive} model-facing check(s) could not run: no working LLM runtime. Re-authenticate under Settings → AI Providers → Runtime logins and run this again.`);
summary();
if (inconclusive) process.exitCode = 2;
