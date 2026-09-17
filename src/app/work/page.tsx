"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ClipboardList, CornerDownRight, Loader2, Plus } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { AgentAvatar } from "@/components/ui/Avatar";
import { TaskDetail } from "@/components/work/TaskDetail";
import { NewTaskDialog } from "@/components/work/NewTaskDialog";
import { CompanyShape } from "@/components/work/CompanyShape";
import { PriorityTag, STATUS_META, StatusDot, when } from "@/components/work/bits";
import { api, errorText, type TaskStatus, type TaskView, type TeamMember } from "@/lib/client-api";
import type { AgentView } from "@/lib/runtime/types";
import { useLinkedRequestId } from "@/lib/use-request-focus";
import { NARROW_WORKSPACE, useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";

const FILTERS: { key: string; label: string; match: (t: TaskView) => boolean }[] = [
  { key: "open", label: "Open", match: (t) => t.status !== "DONE" && t.status !== "CANCELLED" },
  { key: "TODO", label: "To do", match: (t) => t.status === "TODO" },
  { key: "IN_PROGRESS", label: "In progress", match: (t) => t.status === "IN_PROGRESS" },
  { key: "BLOCKED", label: "Blocked", match: (t) => t.status === "BLOCKED" },
  { key: "DONE", label: "Done", match: (t) => t.status === "DONE" },
  { key: "all", label: "Everything", match: () => true },
];

const GROUP_ORDER: TaskStatus[] = ["BLOCKED", "IN_PROGRESS", "TODO", "DONE", "CANCELLED"];

/**
 * Work — everything the company is doing, who holds it and what came of it.
 * Tasks are given to agents and the agents start on their own; this page is
 * for seeing that, not for driving it.
 */
export default function WorkPage() {
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [workload, setWorkload] = useState<TeamMember[]>([]);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("open");
  const [chosen, setChosen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const linked = useLinkedRequestId("task");
  const narrow = useMediaQuery(NARROW_WORKSPACE);

  const refresh = useCallback(() => {
    api.tasks({ status: "all" })
      .then((d) => { setTasks(d.tasks); setWorkload(d.workload); setError(null); })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { api.agents().then((r) => setAgents(r.agents)).catch(() => undefined); }, []);
  // agents finish work on their own; the page keeps up without being asked
  useEffect(() => {
    const t = setInterval(refresh, 8_000);
    return () => clearInterval(t);
  }, [refresh]);

  // a task opened by link may be finished, which the default filter hides —
  // show the board it actually lives on rather than an empty list
  const linkedTask = (tasks ?? []).find((t) => t.id === linked);
  const effective = linkedTask && !FILTERS.find((f) => f.key === filter)!.match(linkedTask) && !chosen ? "all" : filter;
  const shown = useMemo(() => (tasks ?? []).filter(FILTERS.find((f) => f.key === effective)!.match), [tasks, effective]);
  // an objective and the work delegated out of it read as one thing: the
  // pieces sit under the objective they belong to, wherever they would
  // otherwise have been filed
  const groups = useMemo(() => {
    const here = new Set(shown.map((t) => t.id));
    const roots = shown.filter((t) => !t.parentTaskId || !here.has(t.parentTaskId));
    const under = (id: string, depth: number): { task: TaskView; depth: number }[] =>
      depth > 6 ? [] : shown.filter((t) => t.parentTaskId === id).flatMap((c) => [{ task: c, depth }, ...under(c.id, depth + 1)]);
    const by = new Map<TaskStatus, { task: TaskView; depth: number }[]>();
    for (const t of roots) by.set(t.status, [...(by.get(t.status) ?? []), { task: t, depth: 0 }, ...under(t.id, 1)]);
    return GROUP_ORDER.filter((s) => by.get(s)?.length).map((s) => [s, by.get(s)!] as const);
  }, [shown]);

  const openId = (chosen && shown.some((t) => t.id === chosen) ? chosen : null) ?? (linked && (tasks ?? []).some((t) => t.id === linked) ? linked : null) ?? (narrow ? null : shown[0]?.id ?? null);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of FILTERS) c[f.key] = (tasks ?? []).filter(f.match).length;
    return c;
  }, [tasks]);

  return (
    <AppShell>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">Company</div>
          <h1 className="text-[22px] font-semibold tracking-tight">Work</h1>
          <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-3">
            Every task the company is carrying. Whoever a task is assigned to starts on their own, uses what Nexora gives them, and reports the result — you are told when something finishes or needs you.
          </p>
        </div>
        <Button variant="primary" size="md" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New task</Button>
      </header>

      {agents.length > 0 && <CompanyShape agents={agents} onChanged={() => { api.agents().then((r) => setAgents(r.agents)).catch(() => undefined); refresh(); }} />}

      {workload.length > 0 && <Workload team={workload} />}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] transition-colors",
              effective === f.key ? "border-brand/50 bg-brand/[0.14] text-ink" : "border-line text-ink-3 hover:text-ink"
            )}
          >
            {f.label}
            <span className="num text-[10.5px] text-ink-3">{counts[f.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {error && <div className="glass mb-3 rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div>}

      <div className={cn("grid gap-4", !narrow && openId && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]")}>
        <div className="min-w-0 space-y-4">
          {tasks === null && !error && (
            <div className="flex items-center gap-2 text-[12.5px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Loading work…</div>
          )}
          {tasks !== null && !shown.length && <Empty filter={effective} onCreate={() => setCreating(true)} />}
          {groups.map(([status, rows]) => (
            <section key={status}>
              <h2 className="mb-1.5 flex items-center gap-2 px-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">
                {STATUS_META[status].label}
                {/* the count is of work filed here, not of the pieces shown underneath it */}
                <span className="num font-normal">{rows.filter((r) => r.depth === 0).length}</span>
              </h2>
              <ul className="space-y-1.5">
                {rows.map(({ task: t, depth }) => (
                  <li key={t.id} style={depth ? { paddingInlineStart: depth * 18 } : undefined}>
                    <TaskRow task={t} depth={depth} active={t.id === openId} onOpen={() => setChosen(t.id)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        {openId && !narrow && (
          <div className="lg:sticky lg:top-4 lg:max-h-[calc(100dvh-140px)]">
            <TaskDetail taskId={openId} agents={agents} onChanged={refresh} onOpenTask={setChosen} />
          </div>
        )}
      </div>

      {/* narrow screens: the task takes the screen rather than squeezing beside the list */}
      {openId && narrow && chosen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-[#080d19] p-3">
          <div className="mx-auto max-w-xl">
            <TaskDetail taskId={openId} agents={agents} onChanged={refresh} onClose={() => setChosen(null)} onOpenTask={setChosen} />
          </div>
        </div>
      )}

      {creating && <NewTaskDialog agents={agents} onClose={() => setCreating(false)} onCreated={refresh} />}
    </AppShell>
  );
}

function TaskRow({ task, active, depth = 0, onOpen }: { task: TaskView; active: boolean; depth?: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all",
        active ? "border-brand/50 bg-brand/[0.10]" : "border-line bg-white/[0.02] hover:border-line-2 hover:bg-white/[0.045]",
        depth > 0 && !active && "border-line/60 bg-white/[0.012]",
        task.status === "CANCELLED" && "opacity-55"
      )}
    >
      {depth > 0 && <CornerDownRight className="-ms-1 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />}
      <StatusDot status={task.status} size={depth > 0 ? 22 : 26} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span dir="auto" className={cn("truncate font-medium", depth > 0 ? "text-[12.5px]" : "text-[13px]", task.status === "DONE" ? "text-ink-2" : "text-ink")}>{task.title}</span>
          <PriorityTag priority={task.priority} />
          {task.waitingForTeam && (
            <span className="shrink-0 rounded-md border border-brand/35 bg-brand/[0.10] px-1.5 py-px text-[10px] text-brand">
              waiting for {task.children.filter((c) => c.status !== "DONE" && c.status !== "CANCELLED").length} of the team
            </span>
          )}
          {!task.waitingForTeam && task.children.length > 0 && (
            <span className="shrink-0 rounded-md border border-line px-1.5 py-px text-[10px] text-ink-3">{task.children.length} delegated</span>
          )}
        </span>
        <span dir="auto" className="mt-0.5 block truncate text-[11.5px] text-ink-3">
          {task.status === "BLOCKED" && task.blockedReason ? task.blockedReason
            : task.status === "DONE" && task.resultSummary ? task.resultSummary
            : task.description || "No detail given"}
        </span>
      </span>
      <span className="hidden shrink-0 items-center gap-2 sm:flex">
        {task.assignedTo ? (
          <>
            <span className="text-end leading-tight">
              <span className="block text-[11.5px] text-ink-2">{task.assignedTo.name}</span>
              <span className="block text-[10px] text-ink-3">{when(task.updatedAt)}</span>
            </span>
            <AgentAvatar id={task.assignedTo.id} dept={task.assignedTo.dept as never} name={task.assignedTo.name} size={24} />
          </>
        ) : (
          <span className="rounded-md border border-dashed border-line-2 px-1.5 py-0.5 text-[10px] text-ink-3">unassigned</span>
        )}
      </span>
    </button>
  );
}

/** Who is busy and who is free — counts, not capacity theatre. */
function Workload({ team }: { team: TeamMember[] }) {
  return (
    <section className="mb-4">
      <h2 className="mb-1.5 px-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">Who is carrying it</h2>
      <ul className="flex flex-wrap gap-2">
        {team.map((m) => (
          <li key={m.agentId}>
            <Link
              href={`/agents/${m.agentId}`}
              className="flex items-center gap-2.5 rounded-xl border border-line bg-white/[0.02] px-3 py-2 transition-colors hover:border-brand/40 hover:bg-white/[0.05]"
            >
              <AgentAvatar id={m.agentId} dept={m.dept as never} name={m.name} size={28} />
              <span className="leading-tight">
                <span className="block text-[12.5px] font-medium text-ink">{m.name}</span>
                <span className="flex items-center gap-1.5 text-[10.5px] text-ink-3">
                  <span className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    m.status === "WORKING" ? "bg-brand" : m.status === "BLOCKED" ? "bg-warning" : m.status === "WAITING" ? "bg-[#f5b942]" : "bg-ink-3"
                  )} />
                  {m.status === "WORKING" ? "Working" : m.status === "BLOCKED" ? "Blocked" : m.status === "WAITING" ? "Waiting" : "Idle"}
                  <span className="num">· {m.activeTasks} active</span>
                  {m.pendingTasks > 0 && <span className="num">· {m.pendingTasks} queued</span>}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Empty({ filter, onCreate }: { filter: string; onCreate: () => void }) {
  const open = filter === "open" || filter === "all";
  return (
    <div className="glass flex flex-col items-center justify-center gap-3 rounded-2xl px-6 py-14 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl border border-line bg-white/[0.03] text-ink-3">
        <ClipboardList className="h-5 w-5" />
      </span>
      <div>
        <h3 className="text-[14px] font-semibold tracking-tight">{open ? "No work on the board" : `Nothing is ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()}`}</h3>
        <p className="mx-auto mt-1 max-w-[46ch] text-[12.5px] leading-relaxed text-ink-3">
          {open
            ? "Create a task, or simply tell a manager what you want done — they will choose someone on their team and the work appears here."
            : "Switch the filter to see the rest of the board."}
        </p>
      </div>
      {open && <Button variant="primary" size="sm" onClick={onCreate}><Plus className="h-3.5 w-3.5" /> New task</Button>}
    </div>
  );
}
