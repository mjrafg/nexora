/* ------------------------------------------------------------------
   The Project Director engine (ported/adapted from Tandem's director/engine.ts).

   Serialized Director turns per project, observation coalescing, the eleven
   director tools with engine-enforced invariants, the plan-review and
   recovery-review loops, pause/resume, and delivery.
   ------------------------------------------------------------------ */

import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { recentActivity, turnEmitter } from "@/lib/activity";
import { dropEchoedReply, keepSteps } from "./steps";
import { readDb } from "@/lib/store/db";
import { agentRuntimeType, buildSystemPrompt, runAgentTurn } from "@/lib/runtime";
import type { ExtraMcpServer } from "@/lib/runtime/types";
import type { AllowedTool, ToolCallRecord } from "@/lib/mcp/types";
import { checkpointOnlyFiles, deliver as gitDeliver, ensureIntegrationBranch, git, isAncestor, removeWorktree } from "./git";
import { MAX_PLAN_REVIEW_ROUNDS, render } from "./prompts";
import { parseVerdict } from "./review";
import { launchSession, stopAllSessions } from "./session";
import {
  addActivity,
  addMessage,
  createProject as storeCreateProject,
  dirBusyWithin,
  findingsAsText,
  getProject,
  getSession,
  listMessages,
  milestoneByKey,
  milestoneDepsOpen,
  milestonesOf,
  openMilestones,
  patchMilestone,
  patchProject,
  patchSession,
  planDocument,
  planSessions,
  projectChannel,
  sessionsByStatus,
  setPlan,
  setProjectState,
  stateSnapshot,
} from "./store";
import type { MilestoneInput, PendingRecovery, ProjectRecord, ReviewPolicy, SessionInput, SessionKind } from "./types";

import { contradictsInPlaceTopology } from "./topology";
import { reviewOutcome } from "./review-status";

const KINDS = new Set(["build", "qa", "cleanup"]);
const POLICIES = new Set(["required", "spot_check", "none"]);

import { getPrompt, renderPrompt } from "@/lib/prompts";
import { catalogLines, skillServers } from "@/lib/skills/deliver";
import { GRANTABLE, resolveGrant } from "./grants";
import { availableSkills } from "@/lib/skills/library";

/* ---------------------------------------------------------------- internal callback auth */

const DATA_DIR = process.env.NEXORA_DATA_DIR ?? path.join(process.cwd(), "data");

export function internalToken(): string {
  const file = path.join(DATA_DIR, "internal-token");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const t = randomBytes(24).toString("hex");
    fs.writeFileSync(file, t, { mode: 0o600 });
    return t;
  }
}

export function internalBase(): string {
  return process.env.NEXORA_INTERNAL_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3111}`;
}

/* ---------------------------------------------------------------- director tools */

const DIRECTOR_TOOLS: { name: string; op: string; description: string; inputSchema: Record<string, unknown> }[] = [
  { name: "project_get_state", op: "get_state", description: "Fetch the live project state.", inputSchema: { type: "object", properties: {} } },
  { name: "project_set_plan", op: "set_plan", description: "Submit or revise the master plan (milestones only).", inputSchema: { type: "object", properties: { title: { type: "string", description: "A short name for this project, three to six words. The owner may not have named it — if the current title reads like a fragment of their request, replace it with a real name now." }, summary: { type: "string" }, milestones: { type: "array", items: { type: "object", properties: { key: { type: "string" }, name: { type: "string" }, goal: { type: "string" }, acceptance: { type: "string" }, depends_on: { type: "array", items: { type: "string" } } }, required: ["key", "name", "goal", "acceptance"] } } }, required: ["milestones", "summary"] } },
  { name: "plan_milestone_sessions", op: "plan_sessions", description: "Decompose one milestone into self-contained sessions.", inputSchema: { type: "object", properties: { milestone: { type: "string" }, reasoning: { type: "string" }, sessions: { type: "array", items: { type: "object", properties: { key: { type: "string" }, name: { type: "string" }, purpose: { type: "string" }, prompt: { type: "string" }, depends_on: { type: "array", items: { type: "string" } }, isolated: { type: "boolean" }, agent_id: { type: "string" }, skills: { type: "array", items: { type: "string" }, description: "skill_ids from list_skills that this session's Builder should be given — choose from the work, usually none, one or two" }, reviewer_skills: { type: "array", items: { type: "string" }, description: "skill_ids for the independent Reviewer of this session; usually different from the Builder's" }, kind: { type: "string", enum: ["build", "qa", "cleanup"], description: "what this session is: build (implementation, the default), qa (its job is testing), cleanup (small docs/tidy-up). Decides how much its Builder verifies and what its Reviewer checks." }, review_policy: { type: "string", enum: ["required", "spot_check", "none"], description: "whether this session's result gets an independent Reviewer. required = full independent verification; spot_check = the Reviewer audits the session's own evidence and re-checks the risky parts; none = no Reviewer at all. Default is required." }, review_why: { type: "string", description: "one line: why that review policy is right for this session. Recorded in the project audit trail." }, grant_tools: { type: "array", items: { type: "string" }, description: "extra permissions this session's Builder needs, beyond what its agent already has: read_files, write_files, run_commands, web_search, web_fetch, browser, company_profile. Scoped to this session only. Anything else (payments, credentials, writing company data) is refused — those go through the Capability Manager, which asks the owner." }, grant_servers: { type: "array", items: { type: "string" }, description: "tool servers this session may use, by name. Only servers someone on this project has already been given." } }, required: ["key", "name", "purpose", "prompt"] } } }, required: ["milestone", "sessions", "reasoning"] } },
  { name: "start_sessions", op: "start_sessions", description: "Start planned sessions whose dependencies are satisfied.", inputSchema: { type: "object", properties: { keys: { type: "array", items: { type: "string" } }, timeout_minutes: { type: "number" } }, required: ["keys"] } },
  { name: "resume_sessions", op: "resume_sessions", description: "Resume paused/interrupted sessions in their own conversations.", inputSchema: { type: "object", properties: { keys: { type: "array", items: { type: "string" } }, note: { type: "string" } }, required: ["keys"] } },
  { name: "recover_session", op: "recover_session", description: "Decide how to recover a failed/timed-out session (independently reviewed).", inputSchema: { type: "object", properties: { key: { type: "string" }, action: { type: "string", enum: ["continue", "restart", "abandon", "wait"] }, reasoning: { type: "string" }, new_prompt: { type: "string" }, extra_minutes: { type: "number" } }, required: ["key", "action", "reasoning"] } },
  { name: "integrate_milestone", op: "integrate_milestone", description: "Start the milestone's integration session on the integration branch.", inputSchema: { type: "object", properties: { milestone: { type: "string" }, instructions: { type: "string" }, timeout_minutes: { type: "number" } }, required: ["milestone", "instructions"] } },
  { name: "complete_milestone", op: "complete_milestone", description: "Mark a milestone complete once its work is merged.", inputSchema: { type: "object", properties: { milestone: { type: "string" }, summary: { type: "string" } }, required: ["milestone", "summary"] } },
  { name: "project_deliver", op: "deliver", description: "Fast-forward the base branch to the integration branch. If files are present that no agent committed, delivery stops and names them; pass confirm_extra_files to ship them anyway.", inputSchema: { type: "object", properties: { confirm_extra_files: { type: "boolean", description: "Ship files that only the engine\u2019s checkpoint committed, after judging that they belong in the delivery." } } } },
  { name: "complete_project", op: "complete_project", description: "Mark the project complete after delivery.", inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
  { name: "project_need_user", op: "need_user", description: "Pause for an owner decision; ask the question in your reply.", inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
];

const OP_BY_NAME = new Map(DIRECTOR_TOOLS.map((t) => [t.name, t.op]));

export function directorExtraServer(projectId: string): ExtraMcpServer {
  return {
    slug: "director",
    command: process.execPath,
    args: [path.join(process.cwd(), "scripts", "mcp-director.mjs")],
    env: { NEXORA_INTERNAL_URL: internalBase(), NEXORA_INTERNAL_TOKEN: internalToken(), NEXORA_PROJECT_ID: projectId },
    tools: DIRECTOR_TOOLS.map((t) => t.name),
  };
}

export function directorInAppTools(projectId: string): { tools: AllowedTool[]; call: (fullName: string, args: Record<string, unknown>) => Promise<ToolCallRecord> } {
  return {
    tools: DIRECTOR_TOOLS.map((t) => ({ fullName: `director__${t.name}`, serverId: "director", serverName: "Project Director", serverSlug: "director", toolName: t.name, description: t.description, inputSchema: t.inputSchema as AllowedTool["inputSchema"] })),
    call: async (fullName, args) => {
      const started = Date.now();
      const name = fullName.replace(/^director__/, "");
      const r = await handleDirectorTool(projectId, name, args);
      return { server: "Project Director", tool: name, args, ok: r.ok, result: r.text ?? "", error: r.ok ? undefined : r.error, durationMs: Date.now() - started };
    },
  };
}

/* ---------------------------------------------------------------- turn serialization */

type TurnState = { busy: boolean; queued: string[] };
const turns = new Map<string, TurnState>();
const turnState = (id: string) => turns.get(id) ?? (turns.set(id, { busy: false, queued: [] }), turns.get(id)!);

export function queueObservation(projectId: string, text: string): void {
  const p = getProject(projectId);
  if (!p || ["PAUSING", "PAUSED", "COMPLETED", "FAILED"].includes(p.state)) return;
  void pumpDirector(projectId, text, "observation");
}

async function pumpDirector(projectId: string, message: string, kind: "user" | "observation"): Promise<void> {
  const st = turnState(projectId);
  if (st.busy) {
    st.queued.push(kind === "user" ? `OWNER MESSAGE: ${message}` : message);
    return;
  }
  st.busy = true;
  try {
    let next: string | null = kind === "user" ? message : render(getPrompt("project-director-observation"), { observations: message });
    let nextKind = kind;
    while (next !== null) {
      await runDirectorTurn(projectId, next, nextKind);
      await processAfterTurn(projectId);
      if (st.queued.length) {
        next = render(getPrompt("project-director-observation"), { observations: st.queued.splice(0).join("\n\n") });
        nextKind = "observation";
      } else next = null;
    }
  } finally {
    st.busy = false;
  }
}

function builderCatalog(project: ProjectRecord): string {
  const db = readDb();
  const rows = db.agents
    .filter((a) => a.dept === "engineering" || a.id === project.builderAgentId)
    .map((a) => {
      const rt = agentRuntimeType(a.id);
      return rt && rt !== "api" ? `- ${a.id} — ${a.name}, ${a.role} (${rt})${a.id === project.builderAgentId ? " [default]" : ""}` : null;
    })
    .filter(Boolean);
  return rows.length ? rows.join("\n") : `- ${project.builderAgentId} [default]`;
}

async function runDirectorTurn(projectId: string, message: string, kind: "user" | "observation"): Promise<void> {
  const project = getProject(projectId);
  if (!project) return;
  const director = readDb().agents.find((a) => a.id === project.directorAgentId);
  if (!director) return;
  const emit = turnEmitter(projectChannel(projectId), `director:${randomUUID().slice(0, 8)}`, {
    actor: { agentId: director.id, name: director.name, role: "Director" },
    mirror: [director.id],
  });
  // the catalog is ids and one line each — never bodies; the Director reads a
  // skill with read_skill if it wants to, and hands ids to sessions otherwise.
  // With no skills available the section is absent entirely, leaving the
  // Director's assembly exactly as it was before skills existed.
  const skillNote = availableSkills().length ? ["", renderPrompt("skills-director-note", { catalog: catalogLines() })] : [];
  const grantNote = ["", renderPrompt("project-grants-note", { grantable: GRANTABLE.join(", ") })];
  const reviewNote = ["", getPrompt("project-review-policy-note")];
  const system = [
    getPrompt("project-director-system"),
    "",
    "# AVAILABLE BUILDER AGENTS (use agent_id when planning sessions)",
    builderCatalog(project),
    ...reviewNote,
    ...skillNote,
    ...grantNote,
    "",
    "# Your identity",
    buildSystemPrompt(director),
  ].join("\n");
  const body = `${render(getPrompt("project-director-state"), { project_state: stateSnapshot(projectId) })}\n\n${message}`;
  if (kind === "observation") addMessage({ projectId, role: "observation", content: message });
  const history = listMessages(projectId)
    .filter((m) => m.role !== "observation")
    .slice(-16)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const rt = agentRuntimeType(director.id) ?? "api";
  const turnStart = Date.now();
  try {
    const result = await runAgentTurn({
      agentId: director.id,
      scopeId: `project:${projectId}:director`,
      systemPrompt: system,
      message: body,
      history: rt === "api" ? history : undefined,
      sessionId: project.directorSessions[rt],
      cwdOverride: project.rootPath,
      toolProfile: "reader",
      extraServers: [directorExtraServer(projectId)],
      extraTools: directorInAppTools(projectId),
      servers: skillServers(),
      emit,
      timeoutMs: 15 * 60_000,
      freshPrompt: true,
    });
    if (result.sessionId) patchProject(projectId, { directorSessions: { ...getProject(projectId)!.directorSessions, [rt]: result.sessionId } });
    // the Director's own steps ride with its reply, the way a chat keeps them
    const activity = keepSteps(dropEchoedReply(recentActivity(projectChannel(projectId), turnStart).filter((e) => e.turnId === emit.turnId), result.text ?? ""), 150_000);
    addMessage({ projectId, role: "assistant", content: result.text || "(no reply)", usage: result.usage, activity, toolCalls: result.toolCalls?.map((t) => ({ tool: t.tool, ok: t.ok, summary: (t.ok ? t.result : t.error ?? "").slice(0, 200) })) });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    addMessage({ projectId, role: "assistant", content: `Director turn failed: ${text}`, error: text });
    addActivity(projectId, "state", `Director turn failed: ${text.slice(0, 200)}`);
  }
}

/* ---------------------------------------------------------------- reviews after a turn */

async function reviewArtifact(projectId: string, prompt: string, round: number): Promise<{ verdict: "pass" | "findings"; findingsText: string; steps: ReturnType<typeof keepSteps> } | null> {
  const project = getProject(projectId)!;
  const reviewer = readDb().agents.find((a) => a.id === project.reviewerAgentId);
  const emit = turnEmitter(projectChannel(projectId), `review:${round}`, {
    actor: { agentId: project.reviewerAgentId, name: reviewer?.name ?? "Reviewer", role: "Reviewer" },
    mirror: [project.reviewerAgentId],
  });
  const startedAt = Date.now();
  try {
    const r = await runAgentTurn({
      agentId: project.reviewerAgentId,
      scopeId: `project:${projectId}:review:${round}`,
      systemPrompt: getPrompt("project-artifact-reviewer-system"),
      // the same contract the session Reviewer answers under: one parser, one
      // format. Without it these reviews answered in free prose and a
      // substantive PASS was filed as "unstructured output".
      message: `${prompt}\n\n${getPrompt("project-reviewer-output-format")}`,
      cwdOverride: project.rootPath,
      toolProfile: "reader",
      includeGrantedMcp: false,
      freshPrompt: true,
      emit,
      timeoutMs: 10 * 60_000,
    });
    const parsed = parseVerdict(r.text);
    /*
     * Keep everything, including the closing note.
     *
     * Elsewhere that note is dropped because the reply is shown beside it and
     * the pair reads as a stutter. A review has no reply bubble: a PASS records
     * only "accepted by the independent reviewer", so its reasoning lives
     * nowhere else. A review that inspects nothing is then one note — which is
     * an honest record of a turn that only read the plan it was handed.
     */
    const steps = keepSteps(
      recentActivity(projectChannel(projectId), startedAt).filter((e) => e.turnId === emit.turnId),
      120_000,
    );
    return { verdict: parsed.verdict, findingsText: findingsAsText(parsed.items), steps };
  } catch {
    return null;
  }
}

async function processAfterTurn(projectId: string): Promise<void> {
  const p = getProject(projectId);
  if (!p) return;
  if (["COMPLETED", "FAILED", "PAUSING", "PAUSED"].includes(p.state)) return;

  // ---- master plan review loop
  if (p.planReviewRound > 0 && p.planReviewRound <= MAX_PLAN_REVIEW_ROUNDS) {
    if (milestonesOf(projectId).length === 0) return;
    const round = p.planReviewRound;
    if (round === MAX_PLAN_REVIEW_ROUNDS) {
      patchProject(projectId, { planReviewRound: 0 });
      addActivity(projectId, "review", "Plan revised twice — proceeding without a third review (review policy cap)");
      acceptPlan(projectId);
      return;
    }
    const review = await reviewArtifact(projectId, render(getPrompt("project-plan-review-request"), { project_goal: p.goal, plan: planDocument(projectId) }), round);
    if (!review) {
      addActivity(projectId, "review", "Plan review could not run — plan proceeds unreviewed (reviewer unavailable)");
      patchProject(projectId, { planReviewRound: 0 });
      acceptPlan(projectId);
      return;
    }
    if (review.verdict === "pass") {
      patchProject(projectId, { planReviewRound: 0 });
      addActivity(projectId, "review", `Plan accepted by the independent reviewer (round ${round})`, undefined, review.steps);
      acceptPlan(projectId);
      return;
    }
    addActivity(projectId, "review", `Plan review round ${round}: findings returned`, review.findingsText, review.steps);
    patchProject(projectId, { planReviewRound: round + 1 });
    await runDirectorTurn(projectId, render(round === 1 ? getPrompt("project-plan-findings-message") : getPrompt("project-plan-final-message"), { findings: review.findingsText }), "observation");
    await processAfterTurn(projectId);
    return;
  }

  // ---- recovery decision review loop
  if (p.pendingRecovery) {
    const pending = p.pendingRecovery;
    if (pending.round >= 3) {
      patchProject(projectId, { pendingRecovery: null });
      addActivity(projectId, "review", `Recovery for ${pending.sessionKey} revised twice — applying without a third review (review policy cap)`);
      await applyRecovery(projectId, pending);
      return;
    }
    const review = await reviewArtifact(
      projectId,
      render(getPrompt("project-recovery-review-request"), {
        session_context: pending.context,
        decision: `Action: ${pending.action}\nReasoning: ${pending.reasoning}${pending.newPrompt ? `\nNew/updated session instructions:\n${pending.newPrompt}` : ""}${pending.extraMinutes ? `\nAdditional time: ${pending.extraMinutes} minutes` : ""}`,
      }),
      pending.round
    );
    if (!review || review.verdict === "pass") {
      patchProject(projectId, { pendingRecovery: null });
      addActivity(projectId, "review", review ? `Recovery decision for ${pending.sessionKey} accepted by the reviewer (round ${pending.round})` : `Recovery review could not run — decision for ${pending.sessionKey} applied unreviewed`, undefined, review?.steps);
      await applyRecovery(projectId, pending);
      return;
    }
    addActivity(projectId, "review", `Recovery review round ${pending.round} for ${pending.sessionKey}: findings returned`, review.findingsText);
    patchProject(projectId, { pendingRecovery: { ...pending, round: pending.round + 1, awaitingRevision: true } });
    await runDirectorTurn(projectId, render(pending.round === 1 ? getPrompt("project-recovery-findings-message") : getPrompt("project-recovery-final-message"), { findings: review.findingsText }), "observation");
    await processAfterTurn(projectId);
  }
}

function acceptPlan(projectId: string): void {
  const p = getProject(projectId)!;
  if (p.state === "PLANNING") {
    setProjectState(projectId, "RUNNING", "Master plan accepted — project is running");
    queueObservation(projectId, "The master plan passed the independent review. Tell the owner, then begin: inspect the repository, plan the first ready milestone into sessions, and start the ones you judge ready.");
  } else {
    addActivity(projectId, "plan", "Milestone plan revised");
    queueObservation(projectId, "Your revised milestone plan is accepted. Continue orchestration.");
  }
}

async function applyRecovery(projectId: string, pending: PendingRecovery): Promise<void> {
  const key = pending.sessionKey;
  const session = getSession(projectId, key);
  if (!session) return;
  const observe = (t: string) => queueObservation(projectId, t);
  try {
    if (pending.action === "abandon") {
      patchSession(projectId, key, { status: "abandoned", endedAt: new Date().toISOString() });
      addActivity(projectId, "recovery", `${key} abandoned: ${pending.reasoning.slice(0, 200)}`);
      queueObservation(projectId, `Session ${key} is now abandoned. Replan around it if needed.`);
    } else if (pending.action === "wait") {
      patchSession(projectId, key, { status: "paused", stopReason: "user_stop" });
      addActivity(projectId, "recovery", `${key} left paused: ${pending.reasoning.slice(0, 200)}`);
    } else if (pending.action === "restart") {
      patchSession(projectId, key, { status: "planned", builderSessionId: null, reviewsConsumed: 0, lastVerdict: null, lastFindings: [], finalRepairDone: false, ...(pending.newPrompt ? { prompt: pending.newPrompt, originalRequest: pending.newPrompt } : {}) });
      addActivity(projectId, "recovery", `${key} restarted${pending.newPrompt ? " with a rewritten prompt" : ""}`);
      await launchSession(projectId, key, { timeoutMin: pending.extraMinutes, observe });
    } else {
      addActivity(projectId, "recovery", `${key} continued`);
      await launchSession(projectId, key, { timeoutMin: pending.extraMinutes, continuation: pending.reasoning, observe });
    }
  } catch (err) {
    queueObservation(projectId, `Recovery for ${key} could not be applied: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ---------------------------------------------------------------- tool dispatch */

type ToolReply = { ok: boolean; text?: string; error?: string };

export async function handleDirectorTool(projectId: string, name: string, args: Record<string, unknown>): Promise<ToolReply> {
  const op = OP_BY_NAME.get(name) ?? name;
  const project = getProject(projectId);
  if (!project) return { ok: false, error: "Unknown project." };
  if (["COMPLETED", "FAILED"].includes(project.state) && op !== "get_state") {
    return { ok: false, error: `This project is ${project.state} and can no longer be changed. Answer the owner from the existing state.` };
  }
  if (["PAUSING", "PAUSED"].includes(project.state) && op !== "get_state") {
    return { ok: false, error: `The project is ${project.state}. Nothing can start, change, or complete while it is paused — ask the owner to press Resume.` };
  }
  const observe = (t: string) => queueObservation(projectId, t);
  try {
    switch (op) {
      case "get_state":
        return { ok: true, text: stateSnapshot(projectId) };

      case "set_plan": {
        const raw = (args.milestones as Record<string, unknown>[]) ?? [];
        const milestones: MilestoneInput[] = raw.map((m) => ({
          key: String(m.key ?? "").trim(),
          name: String(m.name ?? "").trim(),
          goal: String(m.goal ?? ""),
          acceptance: String(m.acceptance ?? ""),
          dependsOn: Array.isArray(m.depends_on) ? (m.depends_on as unknown[]).map(String) : [],
        }));
        if (milestones.length === 0) return { ok: false, error: "A plan needs at least one milestone." };
        if (milestones.length > 20) return { ok: false, error: "Keep the master plan to at most 20 milestones." };
        setPlan(projectId, milestones, String(args.summary ?? ""));
        const round = project.planReviewRound > 0 ? project.planReviewRound : 1;
        patchProject(projectId, { planReviewRound: round, ...(args.title ? { title: String(args.title).slice(0, 80) } : {}) });
        addActivity(projectId, "plan", `Master plan ${round > 1 ? "revised" : "proposed"}: ${milestones.length} milestones`);
        return { ok: true, text: `Plan recorded (${milestones.length} milestones). The independent review runs next — you will receive its verdict.` };
      }

      case "plan_sessions": {
        const raw = (args.sessions as Record<string, unknown>[]) ?? [];
        const sessions: SessionInput[] = raw.map((s) => ({
          key: String(s.key ?? "").trim(),
          name: String(s.name ?? "").trim(),
          purpose: String(s.purpose ?? ""),
          prompt: String(s.prompt ?? ""),
          dependsOn: Array.isArray(s.depends_on) ? (s.depends_on as unknown[]).map(String) : [],
          isolated: !!s.isolated,
          agentId: s.agent_id ? String(s.agent_id) : null,
          skills: Array.isArray(s.skills) ? (s.skills as unknown[]).map(String) : [],
          grantTools: Array.isArray(s.grant_tools) ? (s.grant_tools as unknown[]).map(String) : [],
          grantServers: Array.isArray(s.grant_servers) ? (s.grant_servers as unknown[]).map(String) : [],
          reviewerSkills: Array.isArray(s.reviewer_skills) ? (s.reviewer_skills as unknown[]).map(String) : [],
          kind: KINDS.has(String(s.kind)) ? (String(s.kind) as SessionKind) : "build",
          reviewPolicy: POLICIES.has(String(s.review_policy)) ? (String(s.review_policy) as ReviewPolicy) : "required",
          reviewWhy: s.review_why ? String(s.review_why).slice(0, 400) : undefined,
        }));
        if (sessions.length === 0) return { ok: false, error: "Provide at least one session." };
        if (sessions.some((s) => !s.prompt.trim())) return { ok: false, error: "Every session needs a full self-contained prompt." };
        for (const s of sessions) {
          if (s.agentId) {
            const rt = agentRuntimeType(s.agentId);
            if (!rt) return { ok: false, error: `Session ${s.key}: unknown agent_id ${s.agentId}.` };
            if (rt === "api") return { ok: false, error: `Session ${s.key}: agent ${s.agentId} runs on the API runtime and cannot build; pick a Claude Code or Codex agent.` };
            // the engine promises every session an independent Reviewer; it
            // cannot keep that promise if the Reviewer built the thing
            const proj = getProject(projectId);
            if (proj && s.agentId === proj.reviewerAgentId) {
              const who = readDb().agents.find((a) => a.id === proj.reviewerAgentId)?.name ?? "That agent";
              return { ok: false, error: `Session ${s.key}: ${who} is this project's Reviewer and cannot also build the work it will review. Pick a different agent, or leave agent_id unset to use the project's Builder.` };
            }
          }
        }
        const msKey = String(args.milestone ?? "");
        if (!milestoneByKey(projectId, msKey)) return { ok: false, error: `Unknown milestone: ${msKey}` };
        const openDeps = milestoneDepsOpen(projectId, msKey);
        if (openDeps.length) return { ok: false, error: `Milestone ${msKey} cannot be decomposed yet: predecessor${openDeps.length === 1 ? "" : "s"} ${openDeps.join(", ")} not completed. Complete ${openDeps.join(", ")} first (complete_milestone), or revise the plan.` };
        const project = getProject(projectId)!;
        // anything above the owner's ceiling is refused per item and said back,
        // so the Director learns the boundary instead of guessing at it
        const refusals = sessions.flatMap((x) =>
          resolveGrant(project, x.grantTools, x.grantServers).refused.map((r) => `${x.key}: ${r.id} — ${r.why}`)
        );
        const ms = planSessions(projectId, msKey, sessions);
        patchMilestone(projectId, ms.key, { status: "running" });
        addActivity(projectId, "decision", `${ms.key} planned into ${ms.sessions.length} sessions`, String(args.reasoning ?? "").slice(0, 1_500));
        /*
         * Say back who is actually assigned and what review each session gets.
         *
         * agent_id is optional and the Director rarely sends it, so the engine
         * quietly used the project default — while the Director's reasoning
         * named a different agent, once the project's own Reviewer. Nobody was
         * lying; nobody was ever told. An assignment the Director can read is
         * an assignment it can correct.
         */
        const names = Object.fromEntries(readDb().agents.map((x) => [x.id, x.name]));
        const assigned = ms.sessions
          .map((x) => `- ${x.key}: builder ${names[x.agentId ?? project.builderAgentId] ?? "?"}${x.agentId ? "" : " (project default — you did not set agent_id)"} · ${x.kind ?? "build"} · review ${x.reviewPolicy ?? "required"}${x.reviewPolicy === "none" ? " (NO Reviewer will run)" : ""}`)
          .join("\n");
        const assignmentNote = `\n\nAssignments the engine recorded — if any of these is not what you intended, fix it now with plan_milestone_sessions before starting, and never describe a session to the owner as run by an agent other than the one named here:\n${assigned}`;
        if (refusals.length) addActivity(projectId, "decision", `${ms.key}: ${refusals.length} grant(s) refused`, refusals.join("\n"));
        return { ok: true, text: `Milestone ${ms.key} now has ${ms.sessions.length} sessions. Start the ready ones with start_sessions.${refusals.length ? `\n\nNot granted:\n${refusals.map((r) => `- ${r}`).join("\n")}` : ""}${assignmentNote}` };
      }

      case "start_sessions": {
        const keys = ((args.keys as unknown[]) ?? []).map(String);
        if (!keys.length) return { ok: false, error: "Provide session keys to start." };
        const started: string[] = [];
        const errors: string[] = [];
        for (const key of keys) {
          try {
            await launchSession(projectId, key, { timeoutMin: args.timeout_minutes ? Number(args.timeout_minutes) : undefined, observe });
            started.push(key);
          } catch (err) {
            errors.push(`${key}: ${err instanceof Error ? err.message : err}`);
          }
        }
        if (started.length && getProject(projectId)!.state === "RESUMING") setProjectState(projectId, "RUNNING", "Project resumed");
        return { ok: errors.length === 0 || started.length > 0, text: `${started.length ? `Started: ${started.join(", ")}. Each runs with its own Builder and an independent Reviewer; you will be woken when they finish.` : ""}${errors.length ? `\nNot started — ${errors.join("; ")}` : ""}`.trim(), ...(started.length === 0 ? { error: errors.join("; ") } : {}) };
      }

      case "resume_sessions": {
        const keys = ((args.keys as unknown[]) ?? []).map(String);
        const resumed: string[] = [];
        const errors: string[] = [];
        for (const key of keys) {
          try {
            const s = getSession(projectId, key);
            if (!s) throw new Error("unknown session");
            if (!["paused", "timeout", "needs_attention"].includes(s.status)) throw new Error(`is ${s.status}`);
            await launchSession(projectId, key, { continuation: args.note ? String(args.note) : "", observe });
            resumed.push(key);
          } catch (err) {
            errors.push(`${key}: ${err instanceof Error ? err.message : err}`);
          }
        }
        if (resumed.length && ["RESUMING", "PAUSED"].includes(getProject(projectId)!.state)) setProjectState(projectId, "RUNNING", "Project resumed");
        return { ok: errors.length === 0 || resumed.length > 0, text: `${resumed.length ? `Resumed: ${resumed.join(", ")}.` : ""}${errors.length ? ` Not resumed — ${errors.join("; ")}` : ""}`.trim() };
      }

      case "recover_session": {
        const key = String(args.key ?? "");
        const session = getSession(projectId, key);
        if (!session) return { ok: false, error: `Unknown session: ${key}` };
        const action = String(args.action ?? "") as PendingRecovery["action"];
        if (!["continue", "restart", "abandon", "wait"].includes(action)) return { ok: false, error: "action must be one of: continue, restart, abandon, wait." };
        let round = 1;
        if (project.pendingRecovery && project.pendingRecovery.sessionKey === key && project.pendingRecovery.awaitingRevision) round = project.pendingRecovery.round;
        const context = `Session ${key} (${session.name}) status ${session.status}.\nError: ${session.errorText ?? "(none)"}\nLast result: ${session.resultSummary ?? "(none)"}\nReviews spent: ${session.reviewsConsumed}, last verdict: ${session.lastVerdict ?? "none"}`;
        patchProject(projectId, { pendingRecovery: { sessionKey: key, action, reasoning: String(args.reasoning ?? ""), newPrompt: args.new_prompt ? String(args.new_prompt) : undefined, extraMinutes: args.extra_minutes ? Number(args.extra_minutes) : undefined, round, context } });
        addActivity(projectId, "recovery", `Recovery ${round > 1 ? "revised" : "proposed"} for ${key}: ${action}`);
        return { ok: true, text: round >= 3 ? "Final revision recorded — it will be applied without further review (review policy cap)." : "Recovery decision recorded. It is significant, so the independent reviewer evaluates it next; you will receive the verdict." };
      }

      case "integrate_milestone": {
        const msKey = String(args.milestone ?? "");
        const ms = milestoneByKey(projectId, msKey);
        if (!ms) return { ok: false, error: `Unknown milestone: ${msKey}` };
        const msDeps = milestoneDepsOpen(projectId, msKey);
        if (msDeps.length) return { ok: false, error: `Milestone ${msKey}'s predecessor${msDeps.length === 1 ? "" : "s"} ${msDeps.join(", ")} not completed — integrate after ${msDeps.join(", ")}.` };
        const intKey = `${msKey}.INT`;
        const unfinished = ms.sessions.filter((s) => !["completed", "abandoned"].includes(s.status) && !(s.key === intKey && s.status === "planned"));
        if (unfinished.length) return { ok: false, error: `Sessions still open: ${unfinished.map((s) => s.key).join(", ")} — integration needs every session completed or abandoned.` };
        const busy = dirBusyWithin(projectId, project.rootPath);
        if (busy) return { ok: false, error: `Session ${busy.key} is working in the project directory — integrate after it finishes.` };
        const { integration } = await ensureIntegrationBranch(project.rootPath, projectId);
        // the engine created the topology, so the engine states it — an
        // integration Builder must never have to guess whether a session
        // branch exists, and must not be told to merge one that does not
        const branches = ms.sessions.filter((s) => s.branch && s.status === "completed").map((s) => s.branch as string);
        const instructions = String(args.instructions ?? "");
        if (!branches.length) {
          const clash = contradictsInPlaceTopology(instructions);
          if (clash) {
            return {
              ok: false,
              error: `Milestone ${msKey}'s sessions were NOT isolated — they committed straight onto ${integration}, so no session branch exists and there is nothing to merge. Your instructions tell the integration session to merge one: "${clash}". That would send it looking for a branch that was never created. Reissue integrate_milestone with instructions that validate the work already on ${integration} in place.`,
            };
          }
        }
        const topology = branches.length
          ? render(getPrompt("project-integration-merge"), { integration_branch: integration, session_branches: branches.join(", ") })
          : render(getPrompt("project-integration-in-place"), { integration_branch: integration });
        // what this milestone's sessions already proved, so integration
        // validates the integration instead of re-running their acceptance
        const evidence = ms.sessions
          .filter((x) => x.key !== intKey && x.status === "completed")
          .map((x) => `- ${x.key} ${x.name} [${x.kind ?? "build"}] — review: ${x.reviewStatus ?? "unknown"}${x.reviewStatus === "skipped" ? " (no Reviewer ran; the Builder's own verification is all there is)" : ""}${x.reviewStatus === "incomplete" ? " (UNREVIEWED — its Reviewer could not finish; do not trust its claims without checking)" : ""}`)
          .join("\n") || "- (nothing recorded)";
        const reuse = render(getPrompt("project-integration-reuse-evidence"), { prior_evidence: evidence });
        planSessions(projectId, msKey, [{ key: intKey, name: `${ms.name} integration`, purpose: `Integrate and validate milestone ${msKey}`, prompt: render(getPrompt("project-integration-wrapper"), { instructions: `${reuse}\n\n${instructions}`, integration_branch: integration, topology }), dependsOn: [], isolated: false, kind: "integration", reviewPolicy: "required", reviewWhy: "Integration is always independently reviewed." }]);
        patchMilestone(projectId, msKey, { status: "integrating" });
        await launchSession(projectId, intKey, { timeoutMin: args.timeout_minutes ? Number(args.timeout_minutes) : undefined, observe });
        addActivity(projectId, "integration", `${msKey} integration session started`);
        return { ok: true, text: `Integration session ${intKey} started on ${integration}. You will be woken with its outcome.` };
      }

      case "complete_milestone": {
        const msKey = String(args.milestone ?? "");
        const ms = milestoneByKey(projectId, msKey);
        if (!ms) return { ok: false, error: `Unknown milestone: ${msKey}` };
        if (ms.sessions.length === 0) return { ok: false, error: `Milestone ${msKey} has no sessions — decompose it (plan_milestone_sessions) and do the work, or remove it from the plan (project_set_plan) if it is no longer needed.` };
        const open = ms.sessions.filter((s) => !["completed", "abandoned"].includes(s.status));
        if (open.length) return { ok: false, error: `Cannot complete ${msKey}: sessions still open (${open.map((s) => s.key).join(", ")}).` };
        const integration = getProject(projectId)!.integrationBranch;
        if (integration) {
          const unmerged: string[] = [];
          for (const s of ms.sessions) if (s.branch && s.status === "completed" && !(await isAncestor(project.rootPath, s.branch, integration))) unmerged.push(`${s.key} (${s.branch})`);
          if (unmerged.length) return { ok: false, error: `Cannot complete ${msKey}: session work is not merged into ${integration} yet — ${unmerged.join(", ")}. Run integrate_milestone first.` };
        }
        patchMilestone(projectId, msKey, { status: "completed" });
        addActivity(projectId, "session", `${msKey} completed: ${String(args.summary ?? "").slice(0, 300)}`);
        return { ok: true, text: `Milestone ${msKey} is complete. Revise later milestones if what you learned changes them, then plan the next ready milestone.` };
      }

      case "deliver": {
        const p = getProject(projectId)!;
        if (!p.integrationBranch) return { ok: true, text: "No integration branch exists — the work already lives on the base branch; nothing to deliver." };
        if (!p.baseBranch) return { ok: false, error: "No base branch was recorded for this project — deliver via a session that merges the integration branch into the intended branch, then complete the project." };
        const busy = dirBusyWithin(projectId, p.rootPath);
        if (busy) return { ok: false, error: `Session ${busy.key} is working in the project directory — deliver after it finishes.` };
        /*
         * Anything on the branch that no agent ever committed itself.
         *
         * A session that could not test in a browser once wrote itself
         * MANUAL_TEST_INSTRUCTIONS.md, never committed it, and a checkpoint
         * swept it into the delivery. Rather than guess at filenames, ask git
         * which files exist only because the engine committed them, and put
         * the question to the Director before it ships them.
         */
        const swept = await checkpointOnlyFiles(p.rootPath, p.integrationBranch);
        if (swept.length && !args.confirm_extra_files) {
          return {
            ok: false,
            error: [
              `These files are on ${p.integrationBranch} but no agent ever committed them — the engine's checkpoint swept them in from the working tree:`,
              ...swept.map((f) => `- ${f}`),
              "",
              "If they are part of what this project set out to deliver, call deliver again with confirm_extra_files: true. If they are scratch left over from a session (notes to self, manual test instructions, throwaway scripts), remove them in a short session first and then deliver.",
            ].join("\n"),
          };
        }
        /*
         * What is actually being shipped, review-wise.
         *
         * Delivery is the last point at which "everything was checked" is
         * still a correctable belief rather than something the owner has been
         * told. Sessions the Director excused are its own decision and do not
         * block; a review that started and never finished is not a decision
         * anyone made, and is named separately.
         */
        const shipped = readDb().projectSessions.filter((x) => x.projectId === projectId && x.status === "completed");
        const unreviewed = shipped.filter((x) => reviewOutcome(x) === "incomplete");
        const byPolicy = shipped.filter((x) => reviewOutcome(x) === "skipped");
        const coverage = [
          unreviewed.length ? `NOT REVIEWED — the Reviewer never finished on: ${unreviewed.map((x) => x.key).join(", ")}. This work has not passed review; do not tell the owner it has.` : "",
          byPolicy.length ? `No independent review by your own decision on: ${byPolicy.map((x) => x.key).join(", ")}.` : "",
        ].filter(Boolean).join(" ");

        const r = await gitDeliver(p.rootPath, p.integrationBranch, p.baseBranch);
        if (r.ok) addActivity(projectId, "delivery", r.message, [swept.length ? `delivered with engine-checkpointed files the Director confirmed: ${swept.join(", ")}` : "", coverage].filter(Boolean).join("\n") || undefined);
        return r.ok ? { ok: true, text: coverage ? `${r.message}\n\nReview coverage of what you just delivered: ${coverage}` : r.message } : { ok: false, error: r.message };
      }

      case "complete_project": {
        const open = sessionsByStatus(projectId, ["running", "planned", "timeout", "needs_attention"]);
        if (open.length) return { ok: false, error: `Sessions still open: ${open.map((s) => s.key).join(", ")}.` };
        const msOpen = openMilestones(projectId);
        if (msOpen.length) return { ok: false, error: `Milestone${msOpen.length === 1 ? "" : "s"} ${msOpen.join(", ")} not completed — complete ${msOpen.length === 1 ? "it" : "them"} (complete_milestone) or revise the plan first.` };
        const p = getProject(projectId)!;
        if (p.integrationBranch && p.baseBranch) {
          const exists = (await git(p.rootPath, ["rev-parse", "--verify", `refs/heads/${p.integrationBranch}`])).ok;
          if (exists && !(await isAncestor(p.rootPath, p.integrationBranch, p.baseBranch))) {
            return { ok: false, error: `The result is not delivered: ${p.baseBranch} is behind ${p.integrationBranch}. Call project_deliver first.` };
          }
        }
        for (const s of readDb().projectSessions.filter((x) => x.projectId === projectId && x.branch && x.cwd && x.cwd !== p.rootPath)) {
          await removeWorktree(p.rootPath, s.cwd!);
        }
        setProjectState(projectId, "COMPLETED", `Project completed: ${String(args.summary ?? "").slice(0, 300)}`);
        return { ok: true, text: "Project marked complete. Summarize the delivered result for the owner." };
      }

      case "need_user": {
        setProjectState(projectId, "NEEDS_USER", `Waiting for the owner: ${String(args.question ?? "").slice(0, 300)}`);
        return { ok: true, text: "State set to NEEDS_USER. Ask the owner the question in your reply." };
      }

      default:
        return { ok: false, error: `Unknown director operation: ${name}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ---------------------------------------------------------------- owner-facing entry points */

export function createProjectRun(input: { title: string; rootPath: string; goal: string; directorAgentId: string; builderAgentId: string; reviewerAgentId: string }): ProjectRecord {
  const p = storeCreateProject(input);
  addActivity(p.id, "state", "Project created — waiting for the Director's first plan");
  addMessage({ projectId: p.id, role: "user", content: input.goal });
  void pumpDirector(p.id, input.goal, "user");
  return p;
}

export function directorUserMessage(projectId: string, text: string): void {
  const p = getProject(projectId);
  if (!p) throw new Error("Unknown project.");
  addMessage({ projectId, role: "user", content: text });
  if (p.state === "NEEDS_USER") setProjectState(projectId, "RUNNING", "Owner replied — continuing");
  void pumpDirector(projectId, text, "user");
}

export function pauseProject(projectId: string): void {
  const p = getProject(projectId);
  if (!p || ["PAUSING", "PAUSED", "COMPLETED", "FAILED"].includes(p.state)) return;
  setProjectState(projectId, "PAUSING", "Pause requested — stopping running sessions");
  const stopped = stopAllSessions(projectId);
  if (stopped === 0) setProjectState(projectId, "PAUSED", "Project paused");
  else setTimeout(() => {
    const q = getProject(projectId);
    if (q?.state === "PAUSING" && sessionsByStatus(projectId, ["running"]).length === 0) setProjectState(projectId, "PAUSED", "Project paused");
  }, 5_000);
}

export function resumeProject(projectId: string): void {
  const p = getProject(projectId);
  if (!p || !["PAUSED", "NEEDS_USER", "PAUSING"].includes(p.state)) return;
  setProjectState(projectId, "RESUMING", "Resume requested");
  const paused = sessionsByStatus(projectId, ["paused", "timeout", "needs_attention"]);
  void pumpDirector(projectId, render(getPrompt("project-director-observation"), { observations: paused.length ? `The owner resumed the project. Interrupted sessions: ${paused.map((s) => `${s.key} [${s.status}]`).join(", ")}. Decide what to resume (resume_sessions) or start (start_sessions).` : "The owner resumed the project. Continue orchestration." }), "observation");
}

/** Boot: sessions that were running when the process died are preserved as paused. */
export function recoverProjectRuns(): void {
  const db = readDb();
  for (const s of db.projectSessions.filter((x) => x.status === "running")) {
    patchSession(s.projectId, s.key, { status: "paused", stopReason: "restart", endedAt: new Date().toISOString() });
  }
}
