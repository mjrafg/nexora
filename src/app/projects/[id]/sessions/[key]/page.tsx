"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, GitBranch, Loader2, Square } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ActivityFeed } from "@/components/agents/ActivityFeed";
import { api, errorText, type ActivityEvent } from "@/lib/client-api";
import type { ProjectView, SessionRecord } from "@/lib/projects/types";
import { cn } from "@/lib/utils";

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
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(0);

  const load = useCallback(() => {
    api.project(id).then((r) => { setProject(r.project); setError(null); }).catch((e) => setError(errorText(e)));
  }, [id]);
  useEffect(() => {
    load();
    api.agents().then((r) => setNames(Object.fromEntries(r.agents.map((a) => [a.id, a.name])))).catch(() => {});
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

  const color = STATUS_COLOR[session.status] ?? "#6f7890";
  const started = session.startedAt ? new Date(session.startedAt).getTime() : 0;
  const ended = session.endedAt ? new Date(session.endedAt).getTime() : 0;
  const elapsed = started ? Math.round(((ended || now || started) - started) / 1000) : 0;
  const builder = session.agentId ? names[session.agentId] ?? session.agentId : project.builderAgentName;

  return (
    <AppShell>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link href={`/projects/${id}`} className="rounded-lg p-1.5 text-ink-3 hover:bg-white/[0.06] hover:text-ink" aria-label="Back to the project">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className="font-mono text-[12px] text-ink-3">{session.key}</span>
        <h1 className="text-[18px] font-semibold tracking-tight">{session.name}</h1>
        <Badge color={color} dot>{session.status.replace("_", " ")}</Badge>
        {session.lastVerdict && <Badge color={session.lastVerdict === "pass" ? "#3dd68c" : "#f5b942"}>review {session.lastVerdict} · {session.reviewsConsumed}/2</Badge>}
        <div className="ms-auto flex items-center gap-2">
          {runningNow && (
            <Button variant="ghost" size="sm" onClick={stop} disabled={stopping}>
              {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />} Stop
            </Button>
          )}
          <a href={`/api/projects/${id}/sessions/${encodeURIComponent(key)}/export?format=markdown`} download>
            <Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export log</Button>
          </a>
        </div>
      </div>
      <p className="mb-4 text-[12.5px] text-ink-3">
        <Link href={`/projects/${id}`} className="hover:text-ink-2">{project.title}</Link> · {session.purpose}
      </p>

      {error && <div className="glass mb-3 rounded-2xl p-3 text-[12.5px] text-[#ff8ea3]">{error}</div>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <Panel title="What the agents did" subtitle={runningNow ? "live — updating as it works" : `${steps.length} step${steps.length === 1 ? "" : "s"}, kept with the session`}>
          {steps.length === 0 ? (
            <p className="text-[12px] text-ink-3">
              {runningNow ? "Waiting for the first step…" : "No steps were kept for this session. Runs from before steps were recorded have only their summary."}
            </p>
          ) : (
            <div className="max-h-[calc(100vh-260px)] overflow-y-auto"><ActivityFeed events={steps} grouped live={runningNow} /></div>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="This session">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11.5px]">
              <Fact k="Builder" v={builder} />
              <Fact k="Reviewer" v={project.reviewerAgentName} />
              {session.branch && <Fact k="Branch" v={<span className="inline-flex items-center gap-1 font-mono text-[10.5px]"><GitBranch className="h-3 w-3" />{session.branch}</span>} />}
              {session.cwd && <Fact k="Worktree" v={<span className="break-all font-mono text-[10.5px]">{session.cwd}</span>} />}
              <Fact k="Started" v={session.startedAt ? new Date(session.startedAt).toLocaleString() : "—"} />
              {elapsed > 0 && <Fact k="Elapsed" v={`${elapsed < 90 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m`}${session.endedAt ? "" : " and counting"}`} />}
              {session.tokens && <Fact k="Model turns" v={`${session.tokens.turns} · ${session.tokens.input.toLocaleString()} in / ${session.tokens.output.toLocaleString()} out`} />}
              {session.grants?.tools.length ? <Fact k="Granted for this session" v={<span className="text-[#f5b942]">{session.grants.tools.join(", ")}</span>} /> : null}
              {session.grants?.servers.length ? <Fact k="Granted tool servers" v={<span className="text-[#f5b942]">{session.grants.servers.length}</span>} /> : null}
              {session.skills?.skillIds.length ? <Fact k="Builder skills" v={session.skills.skillIds.join(", ")} /> : null}
              {session.reviewerSkills?.skillIds.length ? <Fact k="Reviewer skills" v={session.reviewerSkills.skillIds.join(", ")} /> : null}
              {session.dependsOn.length ? <Fact k="Depends on" v={session.dependsOn.join(", ")} /> : null}
              {session.stopReason && <Fact k="Stopped by" v={session.stopReason.replace("_", " ")} />}
            </dl>
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
    </AppShell>
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
