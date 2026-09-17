"use client";

import { Fragment, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, ExternalLink, Pause, Play, Square, Trash2, Loader2, Send, Boxes, Activity as ActivityIcon, ChevronDown, ChevronRight, GitBranch, CheckCircle2, XCircle, Circle, CircleDot, AlertTriangle } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Markdown } from "@/components/ui/Markdown";
import { ActivityFeed } from "@/components/agents/ActivityFeed";
import { api, errorText, type ActivityEvent } from "@/lib/client-api";
import { textDirection } from "@/lib/direction";
import type { ProjectView, ProjectActivity, ProjectMessage, SessionRecord, MilestoneView } from "@/lib/projects/types";
import { cn } from "@/lib/utils";

const STATE_COLOR: Record<string, string> = {
  PLANNING: "#818cf8", RUNNING: "#3dd68c", PAUSING: "#f5b942", PAUSED: "#6f7890", RESUMING: "#818cf8", COMPLETED: "#3dd68c", NEEDS_USER: "#f5b942", FAILED: "#ff5c7a",
};
const SESSION_COLOR: Record<string, string> = {
  planned: "#6f7890", running: "#4f8bff", completed: "#3dd68c", failed: "#ff5c7a", timeout: "#f5b942", needs_attention: "#f5b942", paused: "#6f7890", abandoned: "#6f7890",
};

/** The engine's own moves belong in the story; per-session bookkeeping does not. */
const IN_CHAT = new Set(["plan", "review", "recovery", "delivery", "decision", "integration"]);

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [project, setProject] = useState<ProjectView | null>(null);
  const [activity, setActivity] = useState<ProjectActivity[]>([]);
  const [messages, setMessages] = useState<ProjectMessage[]>([]);
  const [live, setLive] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"milestones" | "activity" | "live">("milestones");
  // the Director can name a specific Builder per session; that is stored as an
  // id, and an id is not an answer to "who built this"
  const [names, setNames] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.project(id);
      setProject(r.project);
      setActivity(r.activity);
      setMessages(r.messages);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    api.project(id).then((r) => { setProject(r.project); setActivity(r.activity); setMessages(r.messages); }).catch((e) => setError(errorText(e)));
    api.agents().then((r) => setNames(Object.fromEntries(r.agents.map((a) => [a.id, a.name])))).catch(() => {});
  }, [id]);

  // Live stream: project-level status changes trigger a reload; tool/model events feed the live tab.
  useEffect(() => {
    const es = new EventSource(`/api/projects/${id}/activity`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as ActivityEvent;
        if (ev.kind === "status") {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void load(), 400);
        } else {
          setLive((cur) => {
            const i = cur.findIndex((x) => x.id === ev.id);
            if (i >= 0) { const n = cur.slice(); n[i] = ev; return n; }
            return [...cur.slice(-200), ev];
          });
        }
      } catch { /* ignore */ }
    };
    return () => { es.close(); if (timer) clearTimeout(timer); };
  }, [id, load]);

  // Status events fire when a session changes, but a Director turn starts
  // without one — so "is anything happening?" would go stale for minutes.
  // A slow poll keeps that answer honest while the project can still move.
  const settled = !project || ["COMPLETED", "FAILED", "PAUSED"].includes(project.state);
  useEffect(() => {
    if (settled) return;
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [settled, load]);

  // the transcript grows from both ends of the story — what the Director said,
  // and what the engine did while it was quiet
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "end" }); }, [messages.length, activity.length]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setDraft("");
    try { await api.projectMessage(id, text); await load(); } catch (e) { setError(errorText(e)); setDraft(text); } finally { setBusy(false); }
  }
  async function pauseResume() {
    if (!project) return;
    setBusy(true);
    try {
      if (["PAUSED", "NEEDS_USER", "PAUSING"].includes(project.state)) await api.resumeProject(id); else await api.pauseProject(id);
      await load();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function remove() {
    if (!project || !window.confirm(`Delete project “${project.title}”? Running sessions are stopped. The repository is left as is.`)) return;
    await api.deleteProject(id);
    router.push("/projects");
  }

  /*
   * The chat is the project's story, so it has to include the parts the
   * Director did not say itself.
   *
   * Planning, plan review, recovery and delivery are the engine's own doing —
   * they were recorded as activity and shown only on a separate tab, so a
   * project sitting in plan review looked like nothing was happening at all.
   * Session-level lines stay out: the Director reports those in its replies,
   * and the plan panel lists them.
   */
  const timeline = useMemo(() => {
    const rows: ({ at: number; kind: "message"; m: ProjectMessage } | { at: number; kind: "engine"; a: ProjectActivity })[] = [
      ...messages.map((m) => ({ at: new Date(m.createdAt).getTime(), kind: "message" as const, m })),
      ...activity.filter((a) => IN_CHAT.has(a.kind)).map((a) => ({ at: a.ts, kind: "engine" as const, a })),
    ];
    return rows.sort((x, y) => x.at - y.at);
  }, [messages, activity]);

  if (error && !project) return <AppShell><div className="glass rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div></AppShell>;
  if (!project) return <AppShell><div className="flex items-center gap-2 text-[12.5px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Loading project…</div></AppShell>;

  const canPause = ["RUNNING", "RESUMING", "PLANNING"].includes(project.state);
  const canResume = ["PAUSED", "NEEDS_USER"].includes(project.state);

  return (
    // an application frame: the page itself never scrolls, so the transcript
    // and the plan each scroll inside their own panel instead of dragging the
    // whole project out of view
    <AppShell workspace>
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-3">
        <Link href="/projects" className="grid h-8 w-8 place-items-center rounded-lg border border-line text-ink-3 hover:text-ink"><ArrowLeft className="h-4 w-4" /></Link>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight">
            <Boxes className="h-5 w-5 text-brand" /> {project.title}
            <Badge color={STATE_COLOR[project.state]} dot>{project.state}</Badge>
            <ActivityNow project={project} />
          </h1>
          <p className="truncate font-mono text-[11px] text-ink-3">{project.rootPath}{project.integrationBranch ? ` · ${project.integrationBranch}` : ""}</p>
        </div>
        <Link href={`/projects/${id}/director`}>
          <Button variant="ghost" size="sm"><Boxes className="h-3.5 w-3.5" /> Director</Button>
        </Link>
        <a href={`/api/projects/${id}/export?format=markdown`} download>
          <Button variant="ghost" size="sm"><Download className="h-3.5 w-3.5" /> Export</Button>
        </a>
        {(canPause || canResume) && (
          <Button variant="ghost" size="sm" onClick={pauseResume} disabled={busy}>
            {canResume ? <><Play className="h-3.5 w-3.5" /> Resume</> : <><Pause className="h-3.5 w-3.5" /> Pause</>}
          </Button>
        )}
        <Button variant="danger" size="sm" onClick={remove}><Trash2 className="h-3.5 w-3.5" /></Button>
      </div>
      {error && <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-[#ff8ea3]">{error}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_400px] xl:overflow-hidden">
        {/* Project Chat */}
        <Panel title="Project Chat" subtitle={`Director: ${project.directorAgentName} · Builder: ${project.builderAgentName} · Reviewer: ${project.reviewerAgentName}`} className="flex min-h-[420px] flex-col xl:min-h-0" bodyClassName="flex-1 !p-0 min-h-0">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {timeline.map((row) => row.kind === "message"
                ? <ProjectBubble key={row.m.id} m={row.m} />
                : <EngineRow key={row.a.id} a={row.a} />)}
              {project.busy.map((b) => (
                <div key={b.name} className="inline-flex items-center gap-2 rounded-2xl rounded-tl-sm border border-line bg-white/[0.04] px-3 py-2 text-[12px] text-ink-3">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> {b.name} is {b.role === "Director" ? "directing" : b.role === "Reviewer" ? "reviewing" : "building"}…
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
            <form className="flex items-end gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} rows={2} dir="auto"
                placeholder={project.state === "NEEDS_USER" ? "The Director is waiting for your answer…" : `Message the Director…`}
                className="min-h-[44px] flex-1 resize-none rounded-xl border border-line bg-white/[0.04] px-3 py-2 text-[13px] outline-none placeholder:text-ink-3 focus:border-brand/60" disabled={busy || project.state === "COMPLETED"} />
              <Button type="submit" variant="primary" size="md" disabled={busy || !draft.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</Button>
            </form>
          </div>
        </Panel>

        {/* Drawer */}
        <Panel title="Plan & sessions" subtitle={`${project.milestones.length} milestones · ${project.counts.completed}/${project.counts.sessions} sessions completed`} className="flex min-h-0 flex-col" bodyClassName="!pt-0 flex min-h-0 flex-1 flex-col">
          {/* the tabs stay put; only what they show scrolls */}
          <div className="mb-2 flex shrink-0 gap-1 border-b border-line text-[12px]">
            {(["milestones", "activity", "live"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cn("border-b-2 px-2.5 py-1.5 capitalize", tab === t ? "border-brand text-ink" : "border-transparent text-ink-3 hover:text-ink-2")}>{t}</button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === "milestones" && (
              project.milestones.length === 0 ? <p className="text-[12px] text-ink-3">No plan yet — the Director is working on it.</p> :
              <div className="space-y-2">{project.milestones.map((m) => <MilestoneCard key={m.id} m={m} project={project} names={names} onStopped={load} />)}</div>
            )}
            {tab === "activity" && (
              <div className="space-y-1">
                {activity.map((a) => <ActivityRow key={a.id} a={a} />)}
                {activity.length === 0 && <p className="text-[12px] text-ink-3">Nothing yet.</p>}
              </div>
            )}
            {tab === "live" && <LiveTab events={live} />}
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}


/** Who is mid-step right now, from the live stream's own running events. */
function WorkingNow({ events }: { events: ActivityEvent[] }) {
  const busy = new Map<string, { name: string; role: string; sessionKey?: string; title: string }>();
  for (const e of events) {
    if (!e.actor) continue;
    if (e.status === "running") busy.set(e.actor.agentId, { ...e.actor, title: e.title });
    else if (busy.get(e.actor.agentId)?.title === e.title) busy.delete(e.actor.agentId);
  }
  const rows = [...busy.values()];
  if (!rows.length) return <p className="mb-2 text-[11.5px] text-ink-3">Nobody is mid-step right now.</p>;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {rows.map((r) => (
        <span key={`${r.name}-${r.title}`} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-white/[0.03] px-2 py-1 text-[11.5px]">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-ceo" />
          <span className="shrink-0 text-ink">{r.name}</span>
          <span className="shrink-0 text-ink-3">{r.role}{r.sessionKey ? ` · ${r.sessionKey}` : ""}</span>
          <span className="truncate font-mono text-[10.5px] text-ink-2">{r.title}</span>
        </span>
      ))}
    </div>
  );
}

/** The run as it happens: who is working, then everything they did, newest last. */
function LiveTab({ events }: { events: ActivityEvent[] }) {
  const [who, setWho] = useState<string>("all");
  const actors = [...new Set(events.map((e) => e.actor?.name).filter(Boolean) as string[])];
  const shown = who === "all" ? events : events.filter((e) => e.actor?.name === who);
  return (
    <div>
      <WorkingNow events={events} />
      {actors.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1 text-[11px]">
          {["all", ...actors].map((a) => (
            <button key={a} onClick={() => setWho(a)}
              className={cn("rounded-md border px-2 py-0.5 capitalize", who === a ? "border-brand/60 bg-brand/10 text-ink" : "border-line text-ink-3 hover:text-ink-2")}>
              {a}
            </button>
          ))}
        </div>
      )}
      {shown.length ? <ActivityFeed events={shown} live grouped /> : <p className="text-[12px] text-ink-3">Tool calls and commands appear here as agents work.</p>}
    </div>
  );
}

/**
 * Whether anything is happening, right now.
 *
 * The state badge answers a different question: RUNNING means "not paused and
 * not finished", and stays RUNNING through every gap between turns. Asking
 * "is it stopped?" of that badge cannot be answered, so this says which agents
 * are actually holding a turn and which sessions are executing.
 */
function ActivityNow({ project }: { project: ProjectView }) {
  const { busy, runningKeys } = project;
  if (!busy.length && !runningKeys.length) {
    const settled = project.state === "COMPLETED" || project.state === "FAILED";
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[10.5px] font-normal text-ink-3">
        <span className="h-1.5 w-1.5 rounded-full bg-ink-3" />
        {settled ? "nothing left to run" : project.state === "PAUSED" ? "stopped" : "idle — nothing running"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand/[0.08] px-2 py-0.5 text-[10.5px] font-normal text-ink-2">
      <Loader2 className="h-3 w-3 animate-spin text-ceo" />
      {busy.length ? busy.map((b) => `${b.name} (${b.role})`).join(", ") : `${runningKeys.length} session${runningKeys.length === 1 ? "" : "s"}`}
      {runningKeys.length > 0 && <span className="font-mono text-ink-3">{runningKeys.join(", ")}</span>}
    </span>
  );
}

/** Something the engine did, in the run's own story rather than on a tab. */
function EngineRow({ a }: { a: ProjectActivity }) {
  const [open, setOpen] = useState(false);
  const expandable = !!a.detail || !!a.steps?.length;
  const tone = a.kind === "delivery" ? "#3dd68c" : a.kind === "recovery" ? "#f5b942" : "#6d7cff";
  return (
    <div className="rounded-lg border border-dashed border-line px-3 py-1.5">
      <button type="button" onClick={() => expandable && setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left text-[11.5px]">
        {expandable ? (open ? <ChevronDown className="h-3 w-3 shrink-0 text-ink-3" /> : <ChevronRight className="h-3 w-3 shrink-0 text-ink-3" />) : <span className="w-3 shrink-0" />}
        <span className="shrink-0 rounded px-1 text-[9.5px] uppercase tracking-wide" style={{ color: tone, background: `${tone}18` }}>{a.kind}</span>
        <span className="min-w-0 flex-1 truncate text-ink-2">{a.text}</span>
        {a.steps?.length ? <span className="shrink-0 text-[10px] text-ink-3">{a.steps.length} steps</span> : null}
        <span className="shrink-0 num text-[10.5px] text-ink-3">{new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </button>
      {open && a.detail && <pre className="mt-1.5 whitespace-pre-wrap break-words text-[10.5px] text-ink-3">{a.detail}</pre>}
      {open && a.steps?.length ? <div className="mt-1.5"><ActivityFeed events={a.steps} grouped /></div> : null}
    </div>
  );
}

/**
 * What happened to this session's review — never blank, and never a pass
 * unless a Reviewer actually finished and said so.
 *
 * A session whose Reviewer ran out of steps used to render nothing at all,
 * which reads exactly like a session that needed no review.
 */
export function ReviewChip({ s }: { s: SessionRecord }) {
  const status = s.reviewStatus ?? (s.lastVerdict === "pass" ? "passed" : s.lastVerdict === "findings" ? "findings" : null);
  if (!status || s.status === "planned") return null;
  const look: Record<string, [string, string]> = {
    passed: ["#5fe3a3", `review passed · ${s.reviewsConsumed}/2`],
    findings: ["#f5b942", `review findings · ${s.reviewsConsumed}/2`],
    incomplete: ["#ff8ea3", "review incomplete — unreviewed"],
    skipped: ["#8b93a7", "no review (by policy)"],
    not_applicable: ["#8b93a7", "nothing to review"],
  };
  const [color, label] = look[status] ?? ["#8b93a7", status];
  return <span style={{ color }} title={s.reviewPolicyWhy ?? undefined}>{label}</span>;
}

function ProjectBubble({ m }: { m: ProjectMessage }) {
  const [open, setOpen] = useState(false);
  if (m.role === "observation") {
    return (
      <div className="rounded-lg border border-dashed border-line px-3 py-1.5 text-[11px] text-ink-3">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 text-left">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <ActivityIcon className="h-3 w-3" /> Engine observation delivered to the Director
        </button>
        {open && <pre className="mt-1.5 whitespace-pre-wrap break-words text-[10.5px] text-ink-2">{m.content}</pre>}
      </div>
    );
  }
  const mine = m.role === "user";
  return (
    <div className={cn("flex", mine && "justify-end")}>
      <div className={cn("min-w-0", mine ? "max-w-[78%]" : "max-w-[92%]")}>
        {/* what the Director did to arrive at this reply, above the reply it
            produced — the same order the work happened in */}
        {!mine && m.activity && m.activity.length > 0 && (
          <div className="mb-1.5"><ActivityFeed events={m.activity} grouped /></div>
        )}
        <div dir={mine || m.error ? textDirection(m.content) : undefined} className={cn("rounded-2xl px-3 py-2 text-start text-[13px] leading-relaxed", mine ? "whitespace-pre-wrap rounded-tr-sm bg-gradient-to-b from-[#6d7cff] to-[#5563e8] text-white" : m.error ? "whitespace-pre-wrap rounded-tl-sm border border-danger/30 bg-danger/10 text-[#ff8ea3]" : "rounded-tl-sm border border-line bg-white/[0.04] text-ink-2")}>
          {mine || m.error ? m.content : <Markdown>{m.content}</Markdown>}
        </div>
        {m.toolCalls && m.toolCalls.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {m.toolCalls.map((t, i) => (
              <span key={i} className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px]", t.ok ? "border-line text-ink-3" : "border-danger/30 text-[#ff8ea3]")} title={t.summary}>
                {t.ok ? <CheckCircle2 className="h-2.5 w-2.5 text-[#5fe3a3]" /> : <XCircle className="h-2.5 w-2.5" />} {t.tool}
              </span>
            ))}
          </div>
        )}
        <div className={cn("mt-1 text-[10px] text-ink-3", mine && "text-right")}>{new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
      </div>
    </div>
  );
}

function MilestoneCard({ m, project, names, onStopped }: { m: MilestoneView; project: ProjectView; names: Record<string, string>; onStopped: () => void }) {
  const [open, setOpen] = useState(true);
  const Icon = m.status === "completed" ? CheckCircle2 : m.status === "planned" ? Circle : CircleDot;
  return (
    <div className="rounded-lg border border-line bg-white/[0.02]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", m.status === "completed" ? "text-[#5fe3a3]" : m.status === "planned" ? "text-ink-3" : "text-brand")} />
        <span className="font-mono text-[11px] text-ink-3">{m.key}</span>
        <span className="truncate text-[12.5px] font-medium text-ink">{m.name}</span>
        <span className="ml-auto text-[10.5px] text-ink-3">{m.status}{m.dependsOn.length ? ` · after ${m.dependsOn.join(", ")}` : ""}</span>
      </button>
      {open && (
        <div className="border-t border-line px-2.5 py-2">
          <p className="text-[11.5px] text-ink-2">{m.goal}</p>
          {m.acceptance && <p className="mt-1 text-[10.5px] text-ink-3"><span className="text-ink-2">Acceptance:</span> {m.acceptance}</p>}
          {m.sessions.length > 0 && <div className="mt-2 space-y-1">{m.sessions.map((s) => <SessionRow key={s.id} s={s} project={project} names={names} onStopped={onStopped} />)}</div>}
        </div>
      )}
    </div>
  );
}

function SessionRow({ s, project, names, onStopped }: { s: SessionRecord; project: ProjectView; names: Record<string, string>; onStopped: () => void }) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  async function stop(e: React.MouseEvent) {
    e.stopPropagation();
    setStopping(true);
    setStopError(null);
    try { await api.stopProjectSession(project.id, s.key); onStopped(); }
    catch (err) { setStopError(errorText(err)); }
    finally { setStopping(false); }
  }
  const color = SESSION_COLOR[s.status] ?? "#6f7890";
  return (
    <div className="rounded-md border border-line/70 bg-black/20">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11.5px]">
        {s.status === "running" ? <Loader2 className="h-3 w-3 animate-spin text-brand" /> : s.status === "needs_attention" || s.status === "failed" || s.status === "timeout" ? <AlertTriangle className="h-3 w-3 text-warning" /> : <span className="h-2 w-2 rounded-full" style={{ background: color }} />}
        <Link href={`/projects/${project.id}/sessions/${encodeURIComponent(s.key)}`} onClick={(e) => e.stopPropagation()}
          className="shrink-0 font-mono text-ink-3 underline-offset-2 hover:text-brand hover:underline" title="Open this session">
          {s.key}
        </Link>
        <span className="truncate text-ink">{s.name}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-ink-3">
          {s.branch && <GitBranch className="h-3 w-3" />}
          <ReviewChip s={s} />
          <span style={{ color }}>{s.status.replace("_", " ")}</span>
        </span>
      </button>
      {s.status === "running" && (
        <div className="flex items-center gap-2 border-t border-line/70 px-2 py-1">
          <button type="button" onClick={stop} disabled={stopping}
            className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10.5px] text-ink-3 hover:border-danger/40 hover:text-[#ff8ea3] disabled:opacity-50">
            {stopping ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />} Stop this session
          </button>
          <span className="text-[10px] text-ink-3">work on the branch is kept; the Director can resume it</span>
          {stopError && <span className="text-[10px] text-[#ff8ea3]">{stopError}</span>}
        </div>
      )}
      {open && (
        <div className="space-y-1.5 border-t border-line/70 px-2 py-1.5 text-[11px]">
          <div className="text-ink-2">{s.purpose}</div>
          {s.dependsOn.length > 0 && <div className="text-ink-3">Depends on {s.dependsOn.join(", ")}</div>}
          {s.resultSummary && <div><div className="text-[9.5px] uppercase tracking-wide text-ink-3">Result</div><div className="whitespace-pre-wrap text-ink-2">{s.resultSummary.slice(0, 800)}</div></div>}
          {s.lastFindings.length > 0 && (
            <div><div className="text-[9.5px] uppercase tracking-wide text-ink-3">Last findings</div>
              <ul className="list-disc pl-4 text-ink-2">{s.lastFindings.map((f, i) => <li key={i}><span className={f.severity === "major" ? "text-[#ff8ea3]" : "text-warning"}>[{f.severity}]</span> {f.title}{f.file ? <span className="font-mono text-ink-3"> — {f.file}{f.line ? `:${f.line}` : ""}</span> : null}</li>)}</ul>
            </div>
          )}
          {s.errorText && <div className="text-[#ff8ea3]">{s.errorText}</div>}
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/projects/${project.id}/sessions/${encodeURIComponent(s.key)}`}
              className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10.5px] text-ink-2 hover:border-brand/50 hover:text-ink">
              <ExternalLink className="h-3 w-3" /> Open session
            </Link>
            <a href={`/api/projects/${project.id}/sessions/${encodeURIComponent(s.key)}/export?format=markdown`} download
              className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10.5px] text-ink-3 hover:border-brand/50 hover:text-ink">
              <Download className="h-3 w-3" /> Export log
            </a>
          </div>
          <Facts s={s} project={project} names={names} />
          {s.steps && s.steps.length > 0 && (
            <details>
              <summary className="cursor-pointer text-ink-3">
                What the agents did — {s.steps.length} step{s.steps.length === 1 ? "" : "s"}
              </summary>
              <div className="mt-1.5 max-h-[420px] overflow-y-auto"><ActivityFeed events={s.steps} grouped /></div>
            </details>
          )}
          <details><summary className="cursor-pointer text-ink-3">Builder prompt</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[10.5px] text-ink-2">{s.prompt}</pre></details>
        </div>
      )}
    </div>
  );
}


/** A clock that ticks only while something is actually running. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    // first tick on the next frame, not during the effect body, so the clock
    // never causes a cascading render of its own
    const t = setInterval(() => setNow(Date.now()), 1000);
    const first = setTimeout(() => setNow(Date.now()), 0);
    return () => { clearInterval(t); clearTimeout(first); };
  }, [active]);
  return now;
}

/** The run's own record: who, where, how long, what it cost, what it was given. */
function Facts({ s, project, names }: { s: SessionRecord; project: ProjectView; names: Record<string, string> }) {
  const started = s.startedAt ? new Date(s.startedAt).getTime() : 0;
  const ended = s.endedAt ? new Date(s.endedAt).getTime() : 0;
  const now = useNow(!!started && !ended);
  const elapsed = started ? Math.round(((ended || now || started) - started) / 1000) : 0;
  const rows: [string, React.ReactNode][] = [];
  rows.push(["Builder", s.agentId ? names[s.agentId] ?? s.agentId : project.builderAgentName]);
  rows.push(["Reviewer", project.reviewerAgentName]);
  if (s.branch) rows.push(["Branch", <span key="b" className="font-mono text-[10.5px]">{s.branch}</span>]);
  if (s.cwd) rows.push(["Worktree", <span key="w" className="font-mono text-[10.5px] break-all">{s.cwd}</span>]);
  if (elapsed) rows.push(["Elapsed", `${elapsed < 90 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m`}${s.endedAt ? "" : " and counting"}`]);
  if (s.tokens) rows.push(["Model turns", `${s.tokens.turns} · ${s.tokens.input.toLocaleString()} in / ${s.tokens.output.toLocaleString()} out`]);
  if (s.grants?.tools.length) rows.push(["Granted for this session", <span key="g" className="text-[#f5b942]">{s.grants.tools.join(", ")}</span>]);
  if (s.skills?.skillIds.length) rows.push(["Builder skills", s.skills.skillIds.join(", ")]);
  if (s.reviewerSkills?.skillIds.length) rows.push(["Reviewer skills", s.reviewerSkills.skillIds.join(", ")]);
  if (s.builderSessionId) rows.push(["Runtime session", <span key="r" className="font-mono text-[10.5px]">{s.builderSessionId.slice(0, 12)}…</span>]);
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[10.5px]">
      {rows.map(([k, v], i) => (
        <Fragment key={i}>
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 truncate text-ink-2">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function ActivityRow({ a }: { a: ProjectActivity }) {
  const [open, setOpen] = useState(false);
  // a plan or recovery review carries what the Reviewer actually did
  const expandable = !!a.detail || !!a.steps?.length;
  return (
    <div className="rounded-md border border-line/70 bg-black/10 px-2 py-1 text-[11px]">
      <button type="button" onClick={() => expandable && setOpen((o) => !o)} className="flex w-full items-start gap-2 text-left">
        <span className="shrink-0 num text-ink-3">{new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <span className="shrink-0 rounded bg-white/[0.06] px-1 text-[9.5px] uppercase text-ink-3">{a.kind}</span>
        <span className="text-ink-2">{a.text}</span>
        {a.steps?.length ? <span className="ms-auto shrink-0 text-[10px] text-ink-3">{a.steps.length} steps</span> : null}
      </button>
      {open && a.detail && <pre className="mt-1 whitespace-pre-wrap break-words text-[10.5px] text-ink-3">{a.detail}</pre>}
      {open && a.steps?.length ? <div className="mt-1.5"><ActivityFeed events={a.steps} grouped /></div> : null}
    </div>
  );
}
