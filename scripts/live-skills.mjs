#!/usr/bin/env node
/* ------------------------------------------------------------------
   One real project, on a repository that exists only for this test.

   The question is not whether the catalog renders. It is whether a
   Director, given a goal and a list of methods, picks the few that fit
   the work; whether the Builder and the Reviewer each get their own;
   whether a session that has nothing to do with any of them gets none;
   and what all that costs in tokens.

   Nothing here touches the owner's repositories: the project root is a
   fresh git repository in a temp directory, deleted at the end.

   Usage: node scripts/live-skills.mjs [baseUrl] [--keep]
   ------------------------------------------------------------------ */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { api, login, sleep, banner, pass, summary } from "./live-lib.mjs";

/** The first runtime that actually answers right now — a CLI one for the Builder. */
async function workingRuntime() {
  const wanted = process.env.NEXORA_RUNTIME;
  const conns = (await api("/api/providers")).connections;
  const cat = await api("/api/catalog");
  const options = [
    { runtimeType: "claude-code", providerConnectionId: "conn-anthropic", model: cat.defaults?.model ?? "claude-haiku-4-5" },
    { runtimeType: "codex", providerConnectionId: "conn-openai", model: cat.defaults?.codexModel ?? "gpt-5-codex" },
  ].filter((o) => conns.some((c) => c.id === o.providerConnectionId) && (!wanted || o.runtimeType === wanted));
  for (const o of options) {
    const { agent } = await api("/api/agents", { name: `RT probe ${Date.now().toString(36).slice(-5)}`, role: "Analyst", dept: "operations", toolPermissions: [], instructions: "Answer briefly.", runtime: o });
    const t = await api(`/api/agents/${agent.id}/test`, { message: "Reply with the single word ready." }).catch((e) => ({ ok: false, message: String(e.message) }));
    await api(`/api/agents/${agent.id}`, null, "DELETE").catch(() => {});
    console.log(`  ${o.runtimeType}/${o.model}: ${t.ok ? "available" : `unavailable — ${String(t.message).slice(0, 90)}`}`);
    if (t.ok) return o;
  }
  throw new Error("no CLI runtime is available — a Builder cannot run on the API runtime, so this test cannot run here");
}

const BASE = process.argv[2] || "http://localhost:3111";
const KEEP = process.argv.includes("--keep");
const DATA_DIR = process.env.NEXORA_DATA_DIR || path.join(process.cwd(), "data");
const tag = Date.now().toString(36).slice(-5);
const store = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, "nexora.json"), "utf8"));

/* ---------------------------------------------------------------- a repository that matters to nobody */
const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexora-skills-${tag}-`));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
fs.writeFileSync(path.join(root, "README.md"), `# Status board ${tag}\n\nA tiny page that shows whether each service is up.\n`);
fs.writeFileSync(path.join(root, "index.html"), `<!doctype html>\n<title>Status</title>\n<div id="board"></div>\n`);
git("init", "-q", "-b", "main");
git("config", "user.email", "skills-test@nexora.local");
git("config", "user.name", "Nexora skills test");
git("add", "-A");
git("commit", "-qm", "the page as it stands");

await login(BASE);
console.log("checking which runtimes answer right now:");
const runtime = await workingRuntime();
banner(`live selective skills · ${BASE} · runtime ${runtime.runtimeType}/${runtime.model} · repo ${root}`);

const made = [];
const mk = async (name, role, perms, instructions) => {
  const { agent } = await api("/api/agents", { name, role, dept: "engineering", toolPermissions: perms, instructions, runtime });
  made.push(agent.id);
  return agent;
};

const before = (await api("/api/skills")).deliveries.length;
const library = (await api("/api/skills")).skills;

const director = await mk(`SK Director ${tag}`, "Project Director", ["read_files"],
  "You plan and supervise engineering projects. You decompose a goal into milestones and sessions and let the people doing the work do it.");
const builder = await mk(`SK Builder ${tag}`, "Engineer", ["read_files", "write_files", "run_commands"],
  "You build what a session brief asks for, in the repository you are given, and you say plainly what you did.");
const reviewer = await mk(`SK Reviewer ${tag}`, "Reviewer", ["read_files"],
  "You review work independently and report what is actually wrong, with evidence.");

let projectId = null;
try {
  const { project } = await api("/api/projects", {
    title: `Skills pilot ${tag}`,
    rootPath: root,
    goal: [
      "This repository holds a single static status page (index.html).",
      "Milestone one: make the page show three services (api, web, worker) as coloured rows, readable on a phone, with proper heading structure and labels a screen reader can use. Plain HTML and CSS in the existing file; no build step, no dependencies, no network calls.",
      "Milestone two: write CONTRIBUTORS.md listing the one commit author already in git history. This is a clerical task with no design or debugging in it.",
      "Do not install anything, do not run a package manager, and do not reach the network.",
    ].join("\n"),
    directorAgentId: director.id,
    builderAgentId: builder.id,
    reviewerAgentId: reviewer.id,
  });
  projectId = project.id;

  /* ---------------------------------------------------------------- watch it run */
  const started = Date.now();
  const LIMIT = 28 * 60_000;
  let last = "";
  while (Date.now() - started < LIMIT) {
    const p = (await api(`/api/projects/${projectId}`)).project;
    const line = `${p.state} · ${(p.milestones ?? []).map((m) => `${m.key}:${m.status}`).join(" ")}`;
    if (line !== last) { console.log(`${new Date().toTimeString().slice(0, 8)}  ${line}`); last = line; }
    if (["COMPLETED", "FAILED", "PAUSED", "DELIVERED", "STOPPED"].includes(p.state)) break;
    // once both sessions have been planned and at least one has run, there is
    // enough on the record to answer every question this test asks
    const sessions = store().projectSessions.filter((s) => s.projectId === projectId);
    if (sessions.filter((s) => ["COMPLETED", "FAILED", "TIMEOUT"].includes(s.status)).length >= 2) break;
    await sleep(10_000);
  }

  const db = store();
  const sessions = db.projectSessions.filter((s) => s.projectId === projectId);
  const deliveries = (db.skillDeliveries ?? []).filter((d) => d.scopeId.startsWith("session:") && sessions.some((s) => d.scopeId.startsWith(`session:${s.id}`)));
  const finalProject = (await api(`/api/projects/${projectId}`)).project;

  banner("what the Director chose");
  for (const s of sessions) {
    console.log(`  ${s.key} — ${s.name}`);
    console.log(`     builder skills : ${(s.skills?.skillIds ?? []).join(", ") || "(none)"}`);
    console.log(`     reviewer skills: ${(s.reviewerSkills?.skillIds ?? []).join(", ") || "(none)"}`);
    console.log(`     status: ${s.status}${s.lastVerdict ? ` · verdict ${s.lastVerdict}` : ""} · reviews ${s.reviewsConsumed}`);
  }

  /* ---------------------------------------------------------------- C */
  const ui = sessions.find((s) => /ui|status|page|frontend|design/i.test(`${s.key} ${s.name} ${s.purpose ?? ""} ${s.prompt}`));
  const clerical = sessions.find((s) => /contributor|clerical|readme|doc/i.test(`${s.key} ${s.name} ${s.purpose ?? ""} ${s.prompt}`));
  pass("C - the Director chose skills for at least one session from the work itself", sessions.some((s) => s.skills?.skillIds?.length),
    sessions.map((s) => `${s.key}:[${(s.skills?.skillIds ?? []).join("|") || "-"}]`).join(" "));
  pass("C - the session that builds a page got the UI skill",
    Boolean(ui?.skills?.skillIds?.includes("frontend-ui-engineering")),
    ui ? `${ui.key} → ${(ui.skills?.skillIds ?? []).join(", ") || "(none)"}` : "no UI session was planned");
  pass("C - the clerical session was not given the UI skill just because it exists",
    !clerical || !(clerical.skills?.skillIds ?? []).includes("frontend-ui-engineering"),
    clerical ? `${clerical.key} → ${(clerical.skills?.skillIds ?? []).join(", ") || "(none)"}` : "no clerical session was planned");

  /* ---------------------------------------------------------------- D */
  const withBoth = sessions.find((s) => s.skills?.skillIds?.length && s.reviewerSkills?.skillIds?.length);
  pass("D - the Builder and the Reviewer of a session were given different guidance",
    Boolean(withBoth) && JSON.stringify(withBoth.skills.skillIds) !== JSON.stringify(withBoth.reviewerSkills.skillIds),
    withBoth ? `${withBoth.key}: builder [${withBoth.skills.skillIds}] · reviewer [${withBoth.reviewerSkills.skillIds}]` : "no session had both");
  const reviewDeliveries = deliveries.filter((d) => /:review:/.test(d.scopeId));
  pass("D - the fresh Reviewer received its own skills in its own conversation",
    reviewDeliveries.length > 0,
    reviewDeliveries.map((d) => `${d.skillId}@${d.scopeId.split(":").slice(-2).join(":")}`).join(", ") || "no review round ran");

  /* ---------------------------------------------------------------- E */
  const leaked = [];
  for (const s of sessions) {
    const mine = new Set([...(s.skills?.skillIds ?? []), ...(s.reviewerSkills?.skillIds ?? [])]);
    for (const d of deliveries.filter((x) => x.scopeId.startsWith(`session:${s.id}`))) {
      // a skill the agent looked up itself is legitimate; a skill Nexora put in
      // a brief that was never selected for this session is not
      if (d.via === "brief" && !mine.has(d.skillId)) leaked.push(`${s.key} ← ${d.skillId}`);
    }
  }
  pass("E - no session was sent a skill that was not selected for it", leaked.length === 0, leaked.join(", ") || `${deliveries.length} deliveries, all accounted for`);
  const noSkills = sessions.filter((s) => !(s.skills?.skillIds ?? []).length);
  pass("E - a session with no selection received no skill text",
    noSkills.every((s) => !deliveries.some((d) => d.via === "brief" && d.scopeId === `session:${s.id}`)),
    noSkills.length ? noSkills.map((s) => s.key).join(", ") : "every session was given something (nothing to check)");

  /* ---------------------------------------------------------------- F */
  const repaired = sessions.filter((s) => s.reviewsConsumed > 0);
  pass("F - selection survived the review and repair rounds it went through",
    repaired.every((s) => s.skills && s.skills.revision && s.skills.skillIds.length),
    repaired.length ? repaired.map((s) => `${s.key}: ${s.reviewsConsumed} round(s), still ${(s.skills?.skillIds ?? []).join("|") || "none"} @ ${s.skills?.revision?.slice(0, 7)}`).join(" · ") : "no session needed a repair");
  const revs = new Set(deliveries.map((d) => d.revision));
  pass("F - everything delivered came from one pinned revision", revs.size <= 1, [...revs].map((r) => r.slice(0, 7)).join(", ") || "nothing delivered");

  /* ---------------------------------------------------------------- I */
  const reviewed = sessions.filter((s) => s.lastVerdict);
  pass("I - the review produced a verdict the existing parser understood",
    reviewed.length > 0 && reviewed.every((s) => ["pass", "findings"].includes(s.lastVerdict)),
    reviewed.map((s) => `${s.key}: ${s.lastVerdict}${s.lastFindings?.length ? ` (${s.lastFindings.length})` : ""}`).join(" · ") || "no review ran");
  pass("I - the review limit still held", sessions.every((s) => s.reviewsConsumed <= 2),
    sessions.map((s) => `${s.key}:${s.reviewsConsumed}`).join(" "));

  /* ---------------------------------------------------------------- what it cost */
  banner("what it cost");
  const evs = (await api(`/api/projects/${projectId}/activity`)).activity ?? [];
  const msgs = (db.projectMessages ?? []).filter((m) => m.projectId === projectId && m.usage);
  const dirIn = msgs.reduce((n, m) => n + (m.usage.inputTokens ?? 0), 0);
  const dirOut = msgs.reduce((n, m) => n + (m.usage.outputTokens ?? 0), 0);
  const sessIn = sessions.reduce((n, s) => n + (s.tokens?.input ?? 0), 0);
  const sessOut = sessions.reduce((n, s) => n + (s.tokens?.output ?? 0), 0);
  const sessTurns = sessions.reduce((n, s) => n + (s.tokens?.turns ?? 0), 0);
  const briefBytes = deliveries.filter((d) => d.via === "brief").reduce((n, d) => n + d.bytes, 0);
  const toolBytes = deliveries.filter((d) => d.via === "tool").reduce((n, d) => n + d.bytes, 0);
  const allBytes = library.filter((s) => s.enabled).reduce((n, s) => n + s.bytes, 0);
  console.log(`  Director turns: ${msgs.length} with usage · input ${dirIn.toLocaleString()} · output ${dirOut.toLocaleString()}`);
  console.log(`  Builder/Reviewer turns: ${sessTurns} with usage · input ${sessIn.toLocaleString()} · output ${sessOut.toLocaleString()}`);
  for (const s of sessions) if (s.tokens) console.log(`     ${s.key}: ${s.tokens.turns} turn(s) · in ${s.tokens.input.toLocaleString()} · out ${s.tokens.output.toLocaleString()} · skills [${(s.skills?.skillIds ?? []).join("|") || "-"}]`);
  console.log(`  skill text Nexora put into briefs: ${briefBytes.toLocaleString()} bytes (~${Math.round(briefBytes / 4).toLocaleString()} tokens) in ${deliveries.filter((d) => d.via === "brief").length} deliveries`);
  console.log(`  skill text agents fetched themselves: ${toolBytes.toLocaleString()} bytes (~${Math.round(toolBytes / 4).toLocaleString()} tokens)`);
  console.log(`  the whole enabled library, if it were appended to every agent: ${allBytes.toLocaleString()} bytes (~${Math.round(allBytes / 4).toLocaleString()} tokens) per system prompt`);
  console.log(`  duration: ${Math.round((Date.now() - started) / 1000)}s  ·  project state: ${finalProject.state}`);
  console.log(`  activity lines: ${evs.length}`);

  banner("what the work produced");
  const wt = path.join(path.dirname(root), ".nexora-worktrees");
  console.log(`  branches: ${git("branch", "--list").trim().split("\n").map((s) => s.trim()).join(", ")}`);
  console.log(`  worktrees present: ${fs.existsSync(wt) ? fs.readdirSync(wt).join(", ") : "(none)"}`);
  for (const s of sessions) console.log(`  ${s.key}: ${s.status}${s.resultSummary ? ` — ${String(s.resultSummary).replace(/\s+/g, " ").slice(0, 140)}` : ""}`);

  console.log(`\n  deliveries added by this run: ${(await api("/api/skills")).deliveries.length - before}`);
} finally {
  if (!KEEP) {
    if (projectId) await api(`/api/projects/${projectId}`, null, "DELETE").catch(() => {});
    for (const id of made) await api(`/api/agents/${id}`, null, "DELETE").catch(() => {});
    for (const dir of [root, path.join(path.dirname(root), ".nexora-worktrees")]) {
      try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }
    }
    console.log(`\ncleaned up the project, ${made.length} agents and ${root}`);
  } else {
    console.log(`\nkept: project ${projectId} · repo ${root}`);
  }
}
summary();
