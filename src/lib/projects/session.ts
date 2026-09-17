/* ------------------------------------------------------------------
   Build sessions (ported/adapted from Tandem's launchSession, startRun,
   runReviewPhase, finalRepair and monitorSession).

   launch → worktree/branch → Builder turn → independent review (≤2 rounds,
   one final repair) → checkpoint commit → classify → notify the Director.
   ------------------------------------------------------------------ */

import { asActor, recentActivity, turnEmitter } from "@/lib/activity";
import { dropEchoedReply, keepSteps } from "./steps";
import { turnCapabilities } from "./capabilities";
import { readDb } from "@/lib/store/db";
import { agentRuntimeType, buildSystemPrompt, runAgentTurn } from "@/lib/runtime";
import { TurnStopped } from "@/lib/runtime/types";
import { buildSystemPrompt as _unused } from "@/lib/runtime";
import {
  changedFiles,
  checkpoint,
  ensureIntegrationBranch,
  ensureWorktree,
  git,
  mergeDependencyBranches,
  snapshot,
  worktreeDir,
} from "./git";
import { MAX_REVIEW_ROUNDS, render } from "./prompts";
import { parseVerdict, reviewPrompt, subjectFor, type ReviewSubject } from "./review";
import {
  addActivity,
  depsSatisfied,
  dirBusyWithin,
  findingsAsText,
  getProject,
  getSession,
  milestoneDepsOpen,
  milestonesOf,
  patchProject,
  patchSession,
  projectChannel,
} from "./store";
import type { Finding, ReviewStatus, SessionRecord } from "./types";
import { getPrompt } from "@/lib/prompts";
import { skillBlock, skillReminder } from "@/lib/skills/deliver";
import { sessionVerification } from "./review-status";

void _unused;

export const DEFAULT_SESSION_TIMEOUT_MIN = 30;
export const MAX_SESSION_TIMEOUT_MIN = 90;

/** kill handles for running sessions, by session id */
const running = new Map<string, () => void>();
/**
 * Sessions the owner stopped on purpose. Killing the process looks exactly
 * like a crash from inside the runtime, so the intent has to be recorded
 * here — otherwise a deliberate stop is filed as a failure and the Director
 * is asked to recover from something that did not go wrong.
 */
const stoppedByOwner = new Set<string>();

/** Was this session stopped by hand, rather than failing? */
export function wasSessionStopped(sessionId: string): boolean {
  return stoppedByOwner.has(sessionId);
}

export function stopSession(sessionId: string): boolean {
  const kill = running.get(sessionId);
  if (!kill) return false;
  stoppedByOwner.add(sessionId);
  kill();
  return true;
}

export function stopAllSessions(projectId: string): number {
  let n = 0;
  for (const s of readDb().projectSessions.filter((x) => x.projectId === projectId)) if (stopSession(s.id)) n += 1;
  return n;
}

export type SessionOutcome = { status: "completed" | "failed" | "timeout" | "paused"; summary: string; verdict: "pass" | "findings" | null; review?: ReviewStatus; errorText?: string };

/**
 * Files this session's agent wrote, from its own recorded steps.
 *
 * Every runtime reports file work as a `file` event whose detail is the path
 * (Claude Code names the tool — Write, Edit; Codex reports a file_change). That
 * is real provenance for "did anyone decide this file should exist", which is
 * the question a checkpoint has to answer before it commits something.
 */
const WROTE = /^(write|edit|multiedit|notebookedit|update|create|file change)$/i;
function filesWritten(steps: { kind: string; title?: string; meta?: string; detail?: string }[]): string[] {
  const out = new Set<string>();
  for (const e of steps) {
    if (e.kind !== "file") continue;
    if (!WROTE.test((e.title ?? "").trim()) && !WROTE.test((e.meta ?? "").trim())) continue;
    const d = (e.detail ?? "").trim();
    if (!d || d.startsWith("{")) continue;
    out.add(d);
  }
  return [...out];
}

/** Say plainly what happened to the review, in the Director's own observations. */
const REVIEW_NOTE: Record<ReviewStatus, string> = {
  passed: "Reviewer verdict: pass.",
  findings: "Reviewer returned findings; the repair rounds allowed by policy were applied.",
  incomplete: "REVIEW INCOMPLETE — the Reviewer could not finish, so this result is UNREVIEWED. It has not passed review. Decide whether to re-review it, verify it during integration, or accept it knowingly.",
  skipped: "No independent review: you set this session's review policy to none. Do not describe this work as reviewed or verified by anyone but its Builder.",
  not_applicable: "No review: the session produced nothing to review.",
};

/**
 * Is this turn continuing a conversation the model can still see? CLI
 * runtimes resume their own transcript; the API runtime is handed only the
 * message it is given here, so for it every turn starts empty. It decides
 * whether a skill can be referred to or has to be sent again.
 */
function conversationContinues(agentId: string, sessionId: string | null | undefined): boolean {
  return Boolean(sessionId) && agentRuntimeType(agentId) !== "api";
}

/** Skills go in front of the message, never into the system prompt: a system
 *  prompt is fixed when a CLI session is created, and this session's skills
 *  are not every session's skills. */
function withSkills(text: string, lead: string | null): string {
  return lead ? `${lead}\n\n${text}` : text;
}

/** Add one turn's reported usage to the session's running total. */
function countTokens(projectId: string, key: string, usage: { inputTokens?: number; outputTokens?: number } | undefined): void {
  if (!usage) return;
  const prev = getSession(projectId, key)?.tokens ?? { input: 0, output: 0, turns: 0 };
  patchSession(projectId, key, {
    tokens: { input: prev.input + (usage.inputTokens ?? 0), output: prev.output + (usage.outputTokens ?? 0), turns: prev.turns + 1 },
  });
}

/** Name the person behind a role, so the timeline can say who ran what. */
function actorFor(agentId: string, role: string, sessionKey: string) {
  const agent = readDb().agents.find((a) => a.id === agentId);
  return { agentId, name: agent?.name ?? agentId.slice(0, 8), role, sessionKey };
}

/** The prompt describes exactly the capabilities the turn is given — no more. */
function agentPrompt(agentId: string, roleText: string, caps?: { permissions: string[] }): string {
  const agent = readDb().agents.find((a) => a.id === agentId);
  if (!agent) return roleText;
  const forTurn = caps ? { ...agent, toolPermissions: caps.permissions } : agent;
  return `${roleText}\n\n# Your identity\n${buildSystemPrompt(forTurn)}`;
}

/**
 * Launch a planned session. Resolves the Builder, prepares the checkout, then
 * runs the build + review loop in the background. `observe` receives the
 * Director-facing observation when the session settles.
 */
export async function launchSession(projectId: string, key: string, opts: { timeoutMin?: number; continuation?: string; observe: (text: string) => void }): Promise<void> {
  const project = getProject(projectId);
  if (!project) throw new Error("Unknown project.");
  if (!["RUNNING", "RESUMING", "PLANNING"].includes(project.state)) throw new Error(`Sessions cannot start while the project is ${project.state}.`);
  const session = getSession(projectId, key);
  if (!session) throw new Error(`Unknown session: ${key}`);
  if (session.status === "running") throw new Error(`Session ${key} is already running.`);
  if (session.status === "completed") throw new Error(`Session ${key} is already completed.`);
  const deps = depsSatisfied(projectId, key);
  if (!deps.ok) throw new Error(`Session ${key} cannot start: unfinished dependencies ${deps.missing.join(", ")}.`);
  const ownerMs = milestonesOf(projectId).find((m) => m.sessions.some((s) => s.key === key));
  if (ownerMs) {
    const open = milestoneDepsOpen(projectId, ownerMs.key);
    if (open.length) throw new Error(`Session ${key} belongs to milestone ${ownerMs.key}, whose predecessor${open.length === 1 ? "" : "s"} ${open.join(", ")} ${open.length === 1 ? "is" : "are"} not completed — complete ${open.join(", ")} first (complete_milestone) or revise the plan.`);
  }

  const builderId = session.agentId ?? project.builderAgentId;
  const rt = agentRuntimeType(builderId);
  if (!rt) throw new Error(`Builder agent ${builderId} not found.`);
  if (rt === "api") throw new Error(`Builder agent must run on Claude Code or Codex (it needs file and shell tools); ${builderId} is on the API runtime.`);

  // ---- git: integration branch + checkout
  const { integration, base } = await ensureIntegrationBranch(project.rootPath, projectId);
  if (!project.integrationBranch) patchProject(projectId, { integrationBranch: integration, baseBranch: base ?? project.baseBranch });
  let cwd = project.rootPath;
  let merged: string[] = [];
  const depBranches = session.dependsOn.map((d) => getSession(projectId, d)?.branch).filter((b): b is string => !!b);
  if (session.branch) {
    cwd = session.cwd ?? worktreeDir(project.rootPath, projectId, key);
    await ensureWorktree(project.rootPath, cwd, session.branch, integration);
    merged = await mergeDependencyBranches(cwd, depBranches);
  } else {
    const busy = dirBusyWithin(projectId, project.rootPath, key);
    if (busy) throw new Error(`Session ${busy.key} is already working in the shared project directory — mark ${key} isolated to run it in parallel, or start it after ${busy.key} finishes.`);
    const sw = await git(project.rootPath, ["checkout", integration]);
    if (!sw.ok) throw new Error(`Could not switch the project directory to ${integration}: ${sw.stderr.slice(-200)}`);
    merged = await mergeDependencyBranches(project.rootPath, depBranches);
  }

  stoppedByOwner.delete(session.id);
  patchSession(projectId, key, { cwd, status: "running", startedAt: new Date().toISOString(), endedAt: null, stopReason: null, errorText: null });
  addActivity(projectId, "session", `${key} ${session.name} started · builder: ${readDb().agents.find((a) => a.id === builderId)?.name ?? builderId}${merged.length ? ` · deps merged: ${merged.join(", ")}` : ""}`);

  const timeoutMs = Math.min(opts.timeoutMin ?? DEFAULT_SESSION_TIMEOUT_MIN, MAX_SESSION_TIMEOUT_MIN) * 60_000;
  void runAndMonitor(projectId, key, builderId, cwd, timeoutMs, opts.continuation, opts.observe);
}

async function runAndMonitor(projectId: string, key: string, builderId: string, cwd: string, timeoutMs: number, continuation: string | undefined, observe: (t: string) => void) {
  const session = getSession(projectId, key)!;
  const project = getProject(projectId)!;
  const emit = turnEmitter(projectChannel(projectId), `session:${key}`);
  const runStarted = Date.now();
  let outcome: SessionOutcome;
  try {
    outcome = await buildAndReview({ project, session, builderId, cwd, timeoutMs, continuation, emit });
  } catch (err) {
    outcome = { status: "failed", summary: "", verdict: null, errorText: err instanceof Error ? err.message : String(err) };
  } finally {
    running.delete(session.id);
  }

  // everything this session did, kept with the session rather than left in RAM
  const before = getSession(projectId, key)?.steps ?? [];
  // an agent's own steps carry an actor; the engine's markers for this session
  // ("review round 1 started", the final result) are Nexora's own voice and
  // carry only the turn id. Both belong in the session's record.
  const mine = recentActivity(projectChannel(projectId), runStarted)
    .filter((e) => e.actor?.sessionKey === key || (!e.actor && e.turnId === `session:${key}`));
  // the session shows its result in its own panel; the narration need not end by repeating it
  const steps = keepSteps([...before, ...dropEchoedReply(mine, outcome.summary)]);

  const fresh = getProject(projectId);
  const pausing = fresh && ["PAUSING", "PAUSED"].includes(fresh.state);
  const handStopped = wasSessionStopped(session.id);
  const status = (pausing || handStopped) && outcome.status !== "completed" ? "paused" : outcome.status;
  patchSession(projectId, key, {
    status: status === "failed" || status === "timeout" ? "needs_attention" : status,
    stopReason: status === "paused" ? (pausing ? "project_pause" : "user_stop") : null,
    endedAt: new Date().toISOString(),
    resultSummary: outcome.summary.slice(0, 1_000) || null,
    errorText: outcome.errorText ?? null,
    ...(outcome.review ? { reviewStatus: outcome.review } : {}),
    ...(steps.length ? { steps } : {}),
  });
  stoppedByOwner.delete(session.id);
  addActivity(
    projectId,
    "session",
    status === "completed" ? `${key} completed · review: ${outcome.review ?? "unknown"}`
      : status === "paused" ? `${key} preserved (${pausing ? "project pause" : "stopped"})`
        : status === "timeout" ? `${key} timed out`
          : `${key} failed`,
    outcome.errorText ?? undefined
  );
  emit.event({ kind: "result", title: `${key} ${status}`, detail: outcome.summary.slice(0, 300), status: status === "completed" ? "done" : status === "paused" ? "done" : "failed" });

  if (pausing) return;
  if (status === "completed") {
    const ready = readySessionsAfter(projectId);
    observe(`Session ${key} COMPLETED. ${REVIEW_NOTE[outcome.review ?? "not_applicable"]} Result summary: ${outcome.summary.slice(0, 600) || "(no summary)"}${ready.length ? ` Sessions whose dependencies are now satisfied: ${ready.join(", ")}.` : ""}`);
  } else if (status === "paused") {
    observe(`Session ${key} was STOPPED; its work on disk is preserved. Decide whether to resume it later (resume_sessions), replan around it, or leave it.`);
  } else {
    const ctx = await failureContext(projectId, key, cwd, outcome);
    observe(`Session ${key} ${status === "timeout" ? "TIMED OUT" : "FAILED"} and needs your decision. Do NOT mechanically retry — analyze and decide with recover_session (the decision will be independently reviewed).\n${ctx}`);
  }
}

function readySessionsAfter(projectId: string): string[] {
  return readDb()
    .projectSessions.filter((s) => s.projectId === projectId && s.status === "planned" && depsSatisfied(projectId, s.key).ok)
    .map((s) => s.key);
}

async function failureContext(projectId: string, key: string, cwd: string, outcome: SessionOutcome): Promise<string> {
  const st = await git(cwd, ["status", "--short"]);
  const log = await git(cwd, ["log", "--oneline", "-5"]);
  return [
    `Session: ${key}`,
    `Error: ${outcome.errorText ?? "(none recorded)"}`,
    `Last summary: ${outcome.summary.slice(0, 500) || "(none)"}`,
    `Working tree (git status --short):\n${st.stdout || "(clean)"}`,
    `Recent commits:\n${log.stdout || "(none)"}`,
  ].join("\n");
}

/* ---------------------------------------------------------------- build + review */

async function buildAndReview(a: {
  project: ReturnType<typeof getProject> & object;
  session: SessionRecord;
  builderId: string;
  cwd: string;
  timeoutMs: number;
  continuation?: string;
  emit: ReturnType<typeof turnEmitter>;
}): Promise<SessionOutcome> {
  const { project, session, builderId, cwd, timeoutMs, emit } = a;
  const runStarted = Date.now();
  const projectId = project!.id;
  const key = session.key;
  const builderAgent = readDb().agents.find((x) => x.id === builderId);
  const reviewerAgent = readDb().agents.find((x) => x.id === project!.reviewerAgentId);
  // tools and prompt decided together, so the agent is never told it holds
  // something the turn does not actually attach
  const builderCaps = builderAgent ? turnCapabilities(builderAgent, "builder", session.grants?.tools ?? []) : { servers: [], permissions: [] };
  /*
   * The Director decides whether this result is independently reviewed.
   *
   * It changes what the Builder is asked to prove, so it has to be settled
   * before the Builder's prompt is assembled, not when the review loop starts.
   * A Builder whose work nobody checks afterwards must verify it properly; one
   * handing over to a Reviewer must not do that Reviewer's job as well.
   */
  const policy = session.reviewPolicy ?? "required";
  const willReview = policy !== "none";
  const reviewerCaps = reviewerAgent && willReview ? turnCapabilities(reviewerAgent, "reviewer") : { servers: [], permissions: [] };
  patchSession(projectId, key, { capabilities: { builder: builderCaps.permissions, reviewer: reviewerCaps.permissions } });
  /*
   * Where this is said matters as much as what it says.
   *
   * It used to live in the system prompt, and the Director's brief — arriving
   * later, about this specific job — told the Builder the opposite: "all must
   * work, verified by you before finishing", a Definition of Done that meant
   * opening the app and checking every feature by hand. The Builder did what
   * the nearer, more specific instruction said, and then the Reviewer it was
   * meant to be handing off to checked everything again.
   *
   * So the engine now gets the last word instead of the first: this block goes
   * after the brief, states that the requirements are a specification rather
   * than a checklist, and says plainly that it is the one deciding who checks.
   */
  const { responsibility, repairScope } = sessionVerification({
    policy,
    kind: session.kind ?? "build",
    reviewerName: reviewerAgent?.name ?? "An independent Reviewer",
    prompt: getPrompt,
    render,
  });
  const builderSystem = agentPrompt(builderId, `${getPrompt("project-builder-system")}\n\n${getPrompt("project-evidence-rule")}`, builderCaps);
  // registered immediately, not only once something spawns: a session on the
  // API runtime has no child process to kill, and must still be stoppable
  running.set(session.id, () => {});
  const onSpawn = (kill: () => void) => running.set(session.id, kill);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(60_000, deadline - Date.now());

  // ---- Builder turn
  const before = await snapshot(cwd);
  const scopeId = `session:${session.id}`;
  const brief = a.continuation ? render(getPrompt("project-session-continuation"), { note: a.continuation }) : session.prompt;
  const channel = projectChannel(projectId);
  const builderEmit = asActor(emit, actorFor(builderId, "Builder", key), channel);
  const message = withSkills(
    `${brief}\n\n${responsibility}`,
    conversationContinues(builderId, session.builderSessionId)
      ? skillReminder(session.skills)
      : skillBlock(session.skills, { scopeId, agentId: builderId }),
  );
  let builderResult;
  try {
    builderResult = await runAgentTurn({
      agentId: builderId,
      scopeId,
      systemPrompt: builderSystem,
      message,
      servers: builderCaps.servers,
      grantedPermissions: session.grants?.tools,
      grantedServers: session.grants?.servers,
      sessionId: session.builderSessionId ?? undefined,
      cwdOverride: cwd,
      toolProfile: "builder",
      freshPrompt: true,
      emit: builderEmit,
      timeoutMs: remaining(),
      onSpawn,
    });
  } catch (err) {
    // the owner stopped this agent: the session is parked, not broken, and the
    // Director can resume it with its conversation and scope intact
    if (err instanceof TurnStopped) return { status: "paused", summary: "", verdict: null };
    const text = err instanceof Error ? `${err.message}${(err as { detail?: string }).detail ? ` — ${(err as { detail?: string }).detail}` : ""}` : String(err);
    return { status: /timed out/i.test(text) ? "timeout" : "failed", summary: "", verdict: null, errorText: `Builder call failed: ${text}` };
  }
  if (builderResult.sessionId) patchSession(projectId, key, { builderSessionId: builderResult.sessionId });
  countTokens(projectId, key, builderResult.usage);
  let answer = builderResult.text;
  // Killing the process only ends the step that was running. A session is a
  // loop — build, review, repair — so every phase boundary has to ask whether
  // the owner still wants it to continue, or Stop merely skips to the next phase.
  if (wasSessionStopped(session.id)) return { status: "paused", summary: answer, verdict: null };

  // ---- review loop (ported policy: ≤2 rounds, final repair never re-reviewed)
  let after = await snapshot(cwd);
  let subject: ReviewSubject | null = subjectFor(await changedFiles(cwd, before, after), answer);
  let verdict: "pass" | "findings" | null = null;
  let consumed = session.reviewsConsumed;
  let previous: Finding[] = session.lastFindings ?? [];

  // the three ways a session ends up without a verdict, kept apart from each
  // other and from "the Reviewer said nothing was wrong"
  let review: ReviewStatus = !willReview ? "skipped" : subject ? "findings" : "not_applicable";
  if (!willReview) addActivity(projectId, "review", `${key} not reviewed — the Director set this session's review policy to none`, session.reviewPolicyWhy ?? undefined);
  patchSession(projectId, key, { reviewStatus: review });

  while (willReview && subject && consumed < MAX_REVIEW_ROUNDS) {
    if (wasSessionStopped(session.id)) return { status: "paused", summary: answer, verdict };
    const round = (consumed + 1) as 1 | 2;
    addActivity(projectId, "review", `${key} review round ${round} started`);
    const reviewEv = emit.start("model", `Review round ${round}`, undefined, "Reviewer");
    let reviewText: string;
    try {
      const r = await runAgentTurn({
        agentId: project!.reviewerAgentId,
        scopeId: `session:${session.id}:review:${round}`,
        systemPrompt: agentPrompt(project!.reviewerAgentId, getPrompt("project-reviewer-role-line"), reviewerCaps),
        message: withSkills(
          reviewPrompt({ originalRequest: session.originalRequest, subject, round, previous: round === 2 ? previous : undefined, kind: session.kind ?? "build", policy }),
          // every review round is a fresh conversation of its own, so the
          // Reviewer's skills travel with each one
          skillBlock(session.reviewerSkills, { scopeId: `session:${session.id}:review:${round}`, agentId: project!.reviewerAgentId }),
        ),
        cwdOverride: cwd,
        toolProfile: "reader",
        freshPrompt: true,
        includeGrantedMcp: false,
        servers: reviewerCaps.servers,
        emit: asActor(emit, actorFor(project!.reviewerAgentId, "Reviewer", key), channel),
        timeoutMs: Math.min(remaining(), 20 * 60_000),
        onSpawn,
      });
      reviewText = r.text;
      countTokens(projectId, key, r.usage);
    } catch (err) {
      // a Reviewer failure is not a verdict — the run finishes loudly unreviewed
      // a Reviewer that ran out of budget did not approve anything; the
      // session says so for the rest of its life rather than going quiet
      emit.finish(reviewEv, "model", `Review round ${round}`, { status: "failed", output: err instanceof Error ? err.message : String(err) });
      addActivity(projectId, "review", `${key} review round ${round} could not finish — result stands UNREVIEWED`, err instanceof Error ? err.message : String(err));
      review = "incomplete";
      patchSession(projectId, key, { reviewStatus: review });
      break;
    }
    const parsed = parseVerdict(reviewText);
    verdict = parsed.verdict;
    consumed = round;
    review = verdict === "pass" ? "passed" : "findings";
    patchSession(projectId, key, { reviewsConsumed: consumed, lastVerdict: verdict, lastFindings: parsed.items, reviewStatus: review });
    emit.finish(reviewEv, "model", `Review round ${round}`, { status: "done", output: reviewText.slice(0, 2000), meta: verdict === "pass" ? "PASS" : `${parsed.items.length} finding${parsed.items.length === 1 ? "" : "s"}` });
    addActivity(projectId, "review", `${key} review round ${round}: ${verdict === "pass" ? "PASS" : `${parsed.items.length} findings`}`, verdict === "pass" ? undefined : findingsAsText(parsed.items));
    if (verdict === "pass") break;
    if (wasSessionStopped(session.id)) return { status: "paused", summary: answer, verdict };
    previous = parsed.items;

    // ---- repair (round 1) or final repair (round 2, never re-reviewed)
    const isFinal = round >= MAX_REVIEW_ROUNDS;
    const tmpl = isFinal
      ? subject.kind === "answer" ? getPrompt("project-repair-answer-final-message") : getPrompt("project-repair-final-message")
      : subject.kind === "answer" ? getPrompt("project-repair-answer-findings-message") : getPrompt("project-repair-findings-message");
    addActivity(projectId, "review", `${key} ${isFinal ? "final repair" : "repair"} started`);
    try {
      const rep = await runAgentTurn({
        agentId: builderId,
        scopeId,
        systemPrompt: builderSystem,
        message: withSkills(
          `${render(tmpl, { findings: findingsAsText(parsed.items) })}\n\n${render(getPrompt("project-repair-responsibility"), { scope: repairScope })}`,
          conversationContinues(builderId, getSession(projectId, key)?.builderSessionId)
            ? skillReminder(session.skills)
            : skillBlock(session.skills, { scopeId, agentId: builderId }),
        ),
        sessionId: getSession(projectId, key)?.builderSessionId ?? undefined,
        cwdOverride: cwd,
        toolProfile: "builder",
        freshPrompt: true,
        servers: builderCaps.servers,
        grantedPermissions: session.grants?.tools,
        grantedServers: session.grants?.servers,
        emit: builderEmit,
        timeoutMs: remaining(),
        onSpawn,
      });
      if (rep.sessionId) patchSession(projectId, key, { builderSessionId: rep.sessionId });
      countTokens(projectId, key, rep.usage);
      answer = rep.text || answer;
      if (wasSessionStopped(session.id)) return { status: "paused", summary: answer, verdict };
    } catch (err) {
      if (err instanceof TurnStopped) return { status: "paused", summary: answer, verdict };
      const text = err instanceof Error ? err.message : String(err);
      return { status: "failed", summary: answer, verdict, errorText: `${isFinal ? "Final repair" : "Builder repair"} call failed: ${text}` };
    }
    if (isFinal) {
      patchSession(projectId, key, { finalRepairDone: true });
      addActivity(projectId, "review", `${key} final repair applied — not re-reviewed (review policy cap)`);
      break;
    }
    after = await snapshot(cwd);
    subject = subjectFor(await changedFiles(cwd, before, after), answer) ?? subject;
  }

  if (wasSessionStopped(session.id)) return { status: "paused", summary: answer, verdict };

  // ---- checkpoint
  // only what an agent actually wrote gets committed; what merely appeared
  // while the work ran is left in the tree for someone to decide about
  const wrote = filesWritten(recentActivity(channel, runStarted).filter((e) => e.actor?.sessionKey === key));
  const cp = await checkpoint(cwd, `${key} ${session.name}`, wrote.length ? wrote : undefined);
  if (cp) {
    const note = [
      cp.swept.length ? `swept in unstaged: ${cp.swept.join(", ")}` : "",
      cp.left.length ? `left uncommitted (nobody wrote them): ${cp.left.join(", ")}` : "",
    ].filter(Boolean).join(" · ") || undefined;
    addActivity(projectId, "session", `${key} checkpoint ${cp.hash}`, note);
    emit.event({ kind: "file", title: `checkpoint ${cp.hash}`, meta: "git", detail: note, status: "done" });
  }
  return { status: "completed", summary: answer, verdict, review };
}
