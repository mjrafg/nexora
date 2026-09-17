"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Markdown } from "@/components/ui/Markdown";
import { ActivityFeed } from "@/components/agents/ActivityFeed";
import { api, errorText, type ActivityEvent } from "@/lib/client-api";
import type { ProjectMessage, ProjectView } from "@/lib/projects/types";

/**
 * The Director, thinking out loud.
 *
 * Its replies with the steps it took to produce each one underneath, in order:
 * what it read, which tools it called, what came back. The same narrative a
 * session page gives for a Builder, for the agent that decides.
 */
export default function DirectorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [project, setProject] = useState<ProjectView | null>(null);
  const [messages, setMessages] = useState<ProjectMessage[]>([]);
  const [live, setLive] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.project(id)
      .then((r) => { setProject(r.project); setMessages(r.messages); setError(null); })
      .catch((e) => setError(errorText(e)));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const es = new EventSource(`/api/projects/${id}/activity`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as ActivityEvent;
        if (ev.kind === "status") {
          if (timer) clearTimeout(timer);
          timer = setTimeout(load, 400);
          return;
        }
        // only the Director's own work belongs on this page
        if (ev.actor?.role !== "Director") return;
        setLive((cur) => {
          const i = cur.findIndex((x) => x.id === ev.id);
          if (i >= 0) { const n = cur.slice(); n[i] = ev; return n; }
          return [...cur, ev];
        });
      } catch { /* ignore */ }
    };
    return () => { es.close(); if (timer) clearTimeout(timer); };
  }, [id, load]);

  // steps that have arrived since the last reply was written — the turn in flight
  const inFlight = useMemo(() => {
    const kept = new Set((messages.flatMap((m) => m.activity ?? [])).map((e) => e.id));
    return live.filter((e) => !kept.has(e.id));
  }, [live, messages]);

  if (error && !project) return <AppShell><div className="glass rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div></AppShell>;
  if (!project) return <AppShell><div className="flex items-center gap-2 text-[12.5px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div></AppShell>;

  return (
    <AppShell>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link href={`/projects/${id}`} className="rounded-lg p-1.5 text-ink-3 hover:bg-white/[0.06] hover:text-ink" aria-label="Back to the project">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-[18px] font-semibold tracking-tight">{project.directorAgentName}</h1>
        <Badge color="#6d7cff">Director</Badge>
        <Badge color="#aab2c5">{project.state}</Badge>
        <div className="ms-auto">
          <a href={`/api/projects/${id}/export?format=markdown`} download>
            <Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export project log</Button>
          </a>
        </div>
      </div>
      <p className="mb-4 text-[12.5px] text-ink-3">
        <Link href={`/projects/${id}`} className="hover:text-ink-2">{project.title}</Link> · every decision, with the steps behind it
      </p>

      <Panel title="Decisions" subtitle={`${messages.filter((m) => m.role === "assistant").length} replies · ${messages.filter((m) => m.role === "observation").length} engine observations`}>
        <div className="space-y-3">
          {messages.map((m) => <Turn key={m.id} m={m} director={project.directorAgentName} />)}
          {inFlight.length > 0 && (
            <div className="rounded-xl border border-brand/30 bg-brand/[0.04] p-2.5">
              <div className="mb-1.5 flex items-center gap-2 text-[11.5px] text-ink-2">
                <Loader2 className="h-3 w-3 animate-spin text-ceo" /> {project.directorAgentName} is working now
              </div>
              <ActivityFeed events={inFlight} grouped live />
            </div>
          )}
          {messages.length === 0 && <p className="text-[12px] text-ink-3">Nothing yet.</p>}
        </div>
      </Panel>
    </AppShell>
  );
}

function Turn({ m, director }: { m: ProjectMessage; director: string }) {
  const [open, setOpen] = useState(false);
  if (m.role === "observation") {
    return (
      <div className="rounded-lg border border-dashed border-line px-3 py-1.5 text-[11px] text-ink-3">
        <button type="button" onClick={() => setOpen((o) => !o)} className="w-full text-start">
          ⚙︎ Engine observation delivered to the Director · {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </button>
        {open && <pre className="mt-1.5 whitespace-pre-wrap break-words text-[10.5px] text-ink-2">{m.content}</pre>}
      </div>
    );
  }
  const mine = m.role === "user";
  return (
    <div className="rounded-xl border border-line bg-white/[0.02] p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
        <span className="text-ink-2">{mine ? "Owner" : director}</span>
        <span>{new Date(m.createdAt).toLocaleString()}</span>
        {m.usage?.inputTokens != null && <span className="num">{m.usage.inputTokens.toLocaleString()} in / {(m.usage.outputTokens ?? 0).toLocaleString()} out</span>}
      </div>
      {!mine && m.activity && m.activity.length > 0 && (
        <div className="mb-2"><ActivityFeed events={m.activity} grouped /></div>
      )}
      <div className="text-[13px] leading-relaxed text-ink-2">
        {mine || m.error ? <pre className="whitespace-pre-wrap font-sans">{m.content}</pre> : <Markdown>{m.content}</Markdown>}
      </div>
      {m.error && <div className="mt-1.5 text-[11.5px] text-[#ff8ea3]">{m.error}</div>}
    </div>
  );
}
