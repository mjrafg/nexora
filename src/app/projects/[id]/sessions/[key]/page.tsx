"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, GitBranch, Globe, Loader2, Square } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ActivityFeed } from "@/components/agents/ActivityFeed";
import { BrowserDock } from "@/components/agents/BrowserDock";
import { api, errorText, type ActivityEvent, type SkillView } from "@/lib/client-api";
import { TOOL_CATALOG } from "@/lib/runtime/catalog";
import type { AgentView } from "@/lib/runtime/types";
import type { ProjectView, SessionRecord } from "@/lib/projects/types";
import { cn } from "@/lib/utils";

/** The review's real state — a skipped or unfinished review never shows as a pass. */
function ReviewBadge({ session }: { session: SessionRecord }) {
  const status = session.reviewStatus ?? (session.lastVerdict === "pass" ? "passed" : session.lastVerdict === "findings" ? "findings" : null);
  if (!status) return null;
  const look: Record<string, [string, string]> = {
    passed: ["#3dd68c", `review passed · ${session.reviewsConsumed}/2`],
    findings: ["#f5b942", `review findings · ${session.reviewsConsumed}/2`],
    incomplete: ["#ff5c7a", "review incomplete — unreviewed"],
    skipped: ["#6f7890", "no reviewer (policy)"],
    not_applicable: ["#6f7890", "nothing to review"],
  };
  const [color, label] = look[status] ?? ["#6f7890", status];
  return <Badge color={color}>{label}</Badge>;
}

const STATUS_COLOR: Record<string, string> = {
  planned: "#6f7890", running: "#4f8bff", completed: "#3dd68c", failed: "#ff5c7a",
  timeout: "#f5b942", needs_attention: "#f5b942", paused: "#6f7890", abandoned: "#6f7890",
};

/**
 * One session, on its own page.
 *
 * What it did, as it does it: the steps kept with the session, joined by
 * whatever is happening right now on the project's live stream. A finished
 * session reads the same way an hour later as it did while running — which is
 * the point of keeping the steps at all.
 */
export default function SessionPage({ params }: { params: Promise<{ id: string; key: string }> }) {
  const { id, key } = use(params);
  const [project, setProject] = useState<ProjectView | null>(null);
  const [live, setLive] = useState<ActivityEvent[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [servers, setServers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(0);
  /*
   * Whose browser to watch.
   *
   * Both roles can hold one now, and during a build they take turns: the
   * Builder while it works, the Reviewer while it checks. Default to whoever
   * is mid-turn so opening the dock shows something live, and let the owner
   * pin the other one when they want to follow it instead.
   */
  const [dockFor, setDockFor] = useState<string | null>(null);

  const load = useCallback(() => {
    api.project(id).then((r) => { setProject(r.project); setError(null); }).catch((e) => setError(errorText(e)));
  }, [id]);
  useEffect(() => {
    load();
    api.agents().then((r) => { setAgents(r.agents); setNames(Object.fromEntries(r.agents.map((a) => [a.id, a.name]))); }).catch(() => {});
    api.skills().then((r) => setSkills(r.skills)).catch(() => {});
    api.mcpServers().then((r) => setServers(Object.fromEntries(r.servers.map((x) => [x.id, x.name])))).catch(() => {});
  }, [load]);

  const session: SessionRecord | undefined = useMemo(
    () => project?.milestones.flatMap((m) => m.sessions).find((s) => s.key === key),
    [project, key]
  );
  const runningNow = session?.status === "running";

  // live steps for THIS session only — the stream carries the whole project
  useEffect(() => {
    const es = new EventSource(`/api/projects/${id}/activity`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as ActivityEvent;
        const mine = ev.actor?.sessionKey === key || (!ev.actor && ev.turnId === `session:${key}`);
        if (ev.kind === "status") {
          if (timer) clearTimeout(timer);
          timer = setTimeout(load, 400);
          return;
        }
        if (!mine) return;
        setLive((cur) => {
          const i = cur.findIndex((x) => x.id === ev.id);
          if (i >= 0) { const n = cur.slice(); n[i] = ev; return n; }
          return [...cur, ev];
        });
      } catch { /* ignore */ }
    };
    return () => { es.close(); if (timer) clearTimeout(timer); };
  }, [id, key, load]);

  // a clock, only while there is something to count
  useEffect(() => {
    if (!runningNow) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    const first = setTimeout(() => setNow(Date.now()), 0);
    return () => { clearInterval(t); clearTimeout(first); };
  }, [runningNow]);

  // what is kept, plus what has arrived since, without showing anything twice
  const steps = useMemo(() => {
    const seen = new Map<string, ActivityEvent>();
    for (const e of session?.steps ?? []) seen.set(e.id, e);
    for (const e of live) seen.set(e.id, e);
    return [...seen.values()].sort((a, b) => a.ts - b.ts);
  }, [session?.steps, live]);

  async function stop() {
    setStopping(true);
    try { await api.stopProjectSession(id, key); load(); }
    catch (e) { setError(errorText(e)); }
    finally { setStopping(false); }
  }

  if (error && !project) return <AppShell><div className="glass rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div></AppShell>;
  if (!project || !session) {
    return (
      <AppShell>
        <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
          {project ? `No session ${key} in this project.` : <><Loader2 className="h-4 w-4 animate-spin" /> Loading…</>}
        </div>
      </AppShell>
    );
  }

  const builderId = session.agentId ?? project.builderAgentId;
  const canWatch = (id: string, role: "builder" | "reviewer") =>
    (session.capabilities?.[role] ?? agents.find((a) => a.id === id)?.toolPermissions ?? []).includes("browser");
  const browserAgents = agents.filter((a) =>
    (a.id === builderId && canWatch(builderId, "builder")) || (a.id === project.reviewerAgentId && canWatch(project.reviewerAgentId, "reviewer")));
  const workingAgent = browserAgents.find((a) => project.busy.some((b) => b.name === a.name));
  const dockAgent = dockFor ? agents.find((a) => a.id === dockFor) : null;

  const color = STATUS_COLOR[session.status] ?? "#6f7890";
  const started = session.startedAt ? new Date(session.startedAt).getTime() : 0;
  const ended = session.endedAt ? new Date(session.endedAt).getTime() : 0;
  const elapsed = started ? Math.round(((ended || now || started) - started) / 1000) : 0;
  const builder = session.agentId ? names[session.agentId] ?? session.agentId : project.builderAgentName;

  return (
    // the timeline scrolls inside its panel rather than growing the page
    <AppShell workspace>
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
        <Link href={`/projects/${id}`} className="rounded-lg p-1.5 text-ink-3 hover:bg-white/[0.06] hover:text-ink" aria-label="Back to the project">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className="font-mono text-[12px] text-ink-3">{session.key}</span>
        <h1 className="text-[18px] font-semibold tracking-tight">{session.name}</h1>
        <Badge color={color} dot>{session.status.replace("_", " ")}</Badge>
        <ReviewBadge session={session} />
        <div className="ms-auto flex items-center gap-2">
          {runningNow && (
            <Button variant="ghost" size="sm" onClick={stop} disabled={stopping}>
              {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />} Stop
            </Button>
          )}
          {browserAgents.length > 0 && (
            <Button variant={dockFor ? "outline" : "ghost"} size="sm" onClick={() => setDockFor(dockFor ? null : (workingAgent ?? browserAgents[0]).id)} title="Watch this session's browser">
              <Globe className="h-3.5 w-3.5" /> Browser
            </Button>
          )}
          <a href={`/api/projects/${id}/sessions/${encodeURIComponent(key)}/export?format=markdown`} download>
            <Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export log</Button>
          </a>
        </div>
      </div>
      <p className="mb-4 shrink-0 text-[12.5px] text-ink-3">
        <Link href={`/projects/${id}`} className="hover:text-ink-2">{project.title}</Link> · {session.purpose}
      </p>

      {error && <div className="glass mb-3 rounded-2xl p-3 text-[12.5px] text-[#ff8ea3]">{error}</div>}

      <div className="flex min-h-0 flex-1 gap-4">
      <div className={cn("grid min-w-0 flex-1 gap-4 overflow-y-auto xl:overflow-hidden", !dockAgent && "xl:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]")}>
        <Panel title="What the agents did" subtitle={runningNow ? "live — updating as it works" : `${steps.length} step${steps.length === 1 ? "" : "s"}, kept with the session`} className="flex min-h-[360px] flex-col xl:min-h-0" bodyClassName="flex min-h-0 flex-1 flex-col">
          {steps.length === 0 ? (
            <p className="text-[12px] text-ink-3">
              {runningNow ? "Waiting for the first step…" : "No steps were kept for this session. Runs from before steps were recorded have only their summary."}
            </p>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto"><ActivityFeed events={steps} grouped live={runningNow} /></div>
          )}
        </Panel>

        <div className="min-h-0 space-y-4 xl:overflow-y-auto xl:pe-1">
          <Panel title="This session">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11.5px]">
              <Fact k="Builder" v={`${builder}${session.agentId ? "" : " (project default)"}`} />
              <Fact k="Kind" v={session.kind ?? "build"} />
              {/* the audit question is "why was there no Reviewer here", and it
                  is answered in the same place the Reviewer would be named */}
              <Fact
                k="Review policy"
                v={<span>{session.reviewPolicy ?? "required"}{session.reviewPolicyBy ? <span className="text-ink-3"> · chosen by {session.reviewPolicyBy}</span> : null}{session.reviewPolicyWhy ? <span className="text-ink-3"> — {session.reviewPolicyWhy}</span> : null}</span>}
              />
              <Fact k="Reviewer" v={(session.reviewPolicy ?? "required") === "none" ? <span className="text-ink-3">none — not reviewed by policy</span> : project.reviewerAgentName} />
              {session.branch && <Fact k="Branch" v={<span className="inline-flex items-center gap-1 font-mono text-[10.5px]"><GitBranch className="h-3 w-3" />{session.branch}</span>} />}
              {session.cwd && <Fact k="Worktree" v={<span className="break-all font-mono text-[10.5px]">{session.cwd}</span>} />}
              <Fact k="Started" v={session.startedAt ? new Date(session.startedAt).toLocaleString() : "—"} />
              {elapsed > 0 && <Fact k="Elapsed" v={`${elapsed < 90 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m`}${session.endedAt ? "" : " and counting"}`} />}
              {session.tokens && <Fact k="Model turns" v={`${session.tokens.turns} · ${session.tokens.input.toLocaleString()} in / ${session.tokens.output.toLocaleString()} out`} />}
              {session.dependsOn.length ? <Fact k="Depends on" v={session.dependsOn.join(", ")} /> : null}
              {session.stopReason && <Fact k="Stopped by" v={session.stopReason.replace("_", " ")} />}
            </dl>
          </Panel>

          <Panel title="What these agents were given" subtitle="for this session only">
            <div className="space-y-3">
              <Given
                role="Builder" who={builder}
                agent={agents.find((a) => a.id === (session.agentId ?? project.builderAgentId))}
                attached={session.capabilities?.builder}
                grant={session.grants} servers={servers}
                skills={(session.skills?.skillIds ?? []).map((id) => skills.find((s2) => s2.id === id)?.name ?? id)}
              />
              <Given
                role="Reviewer" who={project.reviewerAgentName}
                agent={agents.find((a) => a.id === project.reviewerAgentId)}
                attached={session.capabilities?.reviewer}
                grant={null} servers={servers}
                skills={(session.reviewerSkills?.skillIds ?? []).map((id) => skills.find((s2) => s2.id === id)?.name ?? id)}
              />
            </div>
          </Panel>

          {session.lastFindings.length > 0 && (
            <Panel title="Findings from the last review">
              <ul className="space-y-1 text-[11.5px]">
                {session.lastFindings.map((f, i) => (
                  <li key={i} className="text-ink-2">
                    <span className={f.severity === "major" ? "text-[#ff8ea3]" : "text-warning"}>[{f.severity}]</span> {f.title}
                    {f.file && <span className="font-mono text-ink-3"> — {f.file}{f.line ? `:${f.line}` : ""}</span>}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {session.resultSummary && (
            <Panel title="Result"><div className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink-2">{session.resultSummary}</div></Panel>
          )}
          {session.errorText && (
            <Panel title="Error"><pre className="whitespace-pre-wrap text-[11px] text-[#ff8ea3]">{session.errorText}</pre></Panel>
          )}

          <Panel title="Brief given to the Builder">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-ink-2">{session.prompt}</pre>
          </Panel>
        </div>
      </div>

      {dockAgent && (
        <BrowserDock
          agent={dockAgent}
          onClose={() => setDockFor(null)}
          above={browserAgents.length > 1 ? (
            <div className="flex gap-1 text-[11px]">
              {browserAgents.map((a) => (
                <button key={a.id} onClick={() => setDockFor(a.id)}
                  className={cn("rounded-md border px-2 py-0.5", a.id === dockAgent.id ? "border-brand/60 bg-brand/10 text-ink" : "border-line text-ink-3 hover:text-ink-2")}>
                  {a.name}{a.id === builderId ? " · Builder" : " · Reviewer"}
                </button>
              ))}
            </div>
          ) : undefined}
        />
      )}
      </div>
    </AppShell>
  );
}

/**
 * What one role could reach in this session, and where each piece came from.
 *
 * A permission the agent already held and one the Director handed it for this
 * session read the same at the point of use and mean very different things
 * afterwards — the first is permanent and follows the agent everywhere, the
 * second ends with the session. They are shown apart for that reason.
 */
function Given({ role, who, agent, attached, grant, skills, servers }: {
  role: string;
  who: string;
  agent?: AgentView;
  /** what the turn actually attached, when the session recorded it */
  attached?: string[];
  grant?: { tools: string[]; servers: string[] } | null;
  skills: string[];
  servers: Record<string, string>;
}) {
  const label = (id: string) => TOOL_CATALOG.find((t) => t.id === id)?.label ?? id;
  // the permanent set is what the agent carries; the attached set is what this
  // session actually gave it. A Reviewer holds more than it is handed.
  const base = attached ?? agent?.toolPermissions ?? [];
  const own = base.filter((t) => !(grant?.tools ?? []).includes(t));
  const withheld = attached ? (agent?.toolPermissions ?? []).filter((t) => !attached.includes(t)) : [];
  const granted = grant?.tools ?? [];
  const grantedServers = grant?.servers ?? [];
  return (
    <div className="rounded-lg border border-line bg-white/[0.02] p-2.5">
      <div className="mb-1.5 flex items-baseline gap-2 text-[11.5px]">
        <span className="font-medium text-ink">{who}</span>
        <span className="text-ink-3">{role}</span>
      </div>
      <Line k="Skills">
        {skills.length
          ? skills.map((n) => <Chip key={n} tone="#6d7cff">{n}</Chip>)
          : <span className="text-ink-3">none selected</span>}
      </Line>
      {/* only a session that recorded its set can say what the turn could reach;
          an older one can only say what the agent carries, and should say which */}
      <Line k={attached ? "Could reach this session" : "Agent holds (not recorded per session)"}>
        {own.length ? own.map((t) => <Chip key={t} tone="#aab2c5">{label(t)}</Chip>) : <span className="text-ink-3">none</span>}
      </Line>
      {withheld.length > 0 && (
        <Line k="Held but not attached">
          {withheld.map((t) => <Chip key={t} tone="#6f7890">{label(t)}</Chip>)}
        </Line>
      )}
      <Line k="Granted for this session">
        {granted.length || grantedServers.length ? (
          <>
            {granted.map((t) => <Chip key={t} tone="#f5b942">{label(t)}</Chip>)}
            {grantedServers.map((id) => <Chip key={id} tone="#f5b942">{servers[id] ?? id} (tools)</Chip>)}
          </>
        ) : <span className="text-ink-3">nothing — it ran with what it already had</span>}
      </Line>
    </div>
  );
}

function Line({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-0.5 text-[11px]">
      <span className="w-[150px] shrink-0 text-ink-3">{k}</span>
      <span className="flex min-w-0 flex-wrap gap-1">{children}</span>
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <span className="rounded-md border px-1.5 py-px text-[10.5px]" style={{ borderColor: `${tone}55`, color: tone }}>{children}</span>
  );
}

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className={cn("text-ink-3")}>{k}</dt>
      <dd className="min-w-0 text-ink-2">{v}</dd>
    </>
  );
}
