"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRightLeft, Ban, CornerLeftUp, Flag, Folder, Loader2, MessageSquare, RotateCcw, Users, X } from "lucide-react";
import { AgentAvatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Form";
import { api, errorText, type TaskEvent, type TaskLink, type TaskPriority, type TaskView } from "@/lib/client-api";
import type { AgentView } from "@/lib/runtime/types";
import { PriorityTag, STATUS_META, StatusDot, folderNameFrom, when } from "./bits";
import { FolderPicker } from "./FolderPicker";

/**
 * One piece of work in full: what was asked, who holds it, what happened,
 * and what it produced. The owner's controls live here too — priority, who
 * does it, stop it, send it back.
 */
export function TaskDetail({ taskId, agents, onChanged, onClose, onOpenTask }: { taskId: string; agents: AgentView[]; onChanged: () => void; onClose?: () => void; onOpenTask?: (id: string) => void }) {
  const [data, setData] = useState<{ task: TaskView; history: TaskEvent[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    let alive = true;
    api.task(taskId).then((d) => alive && setData(d)).catch((e) => alive && setError(errorText(e)));
    return () => { alive = false; };
  }, [taskId]);

  // the list refreshes on a timer; keep the open task in step with it
  useEffect(() => {
    const t = setInterval(() => { api.task(taskId).then(setData).catch(() => undefined); }, 6_000);
    return () => clearInterval(t);
  }, [taskId]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const d = await api.updateTask(taskId, body);
      setData((cur) => (cur ? { ...cur, ...d } : d));
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <div className="glass rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div>;
  if (!data) {
    return (
      <div className="glass flex items-center gap-2 rounded-2xl p-4 text-[12.5px] text-ink-3">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading task…
      </div>
    );
  }

  const { task, history } = data;
  const meta = STATUS_META[task.status];
  const open = task.status !== "DONE" && task.status !== "CANCELLED";

  return (
    <div className="glass flex min-h-0 flex-col overflow-hidden rounded-2xl">
      <header className="flex items-start gap-3 border-b border-line px-4 py-3">
        <StatusDot status={task.status} size={30} />
        <div className="min-w-0 flex-1">
          <h2 dir="auto" className="text-[14.5px] font-semibold leading-snug tracking-tight text-ink">{task.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-3">
            <span className={meta.text}>{meta.label}</span>
            <PriorityTag priority={task.priority} />
            <span>· created {when(task.createdAt)}</span>
            {task.createdBy && <span>by {task.createdBy.name}</span>}
          </div>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="shrink-0 text-ink-3 hover:text-ink" aria-label="Close task"><X className="h-4 w-4" /></button>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {/* who holds it */}
        <section className="flex flex-wrap items-center gap-3">
          {task.assignedTo ? (
            <Link href={`/agents/${task.assignedTo.id}`} className="flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-2.5 py-1.5 transition-colors hover:border-brand/40">
              <AgentAvatar id={task.assignedTo.id} dept={task.assignedTo.dept as never} name={task.assignedTo.name} size={26} />
              <span className="leading-tight">
                <span className="block text-[12.5px] font-medium text-ink">{task.assignedTo.name}</span>
                <span className="block text-[10.5px] text-ink-3">{task.assignedTo.role}</span>
              </span>
            </Link>
          ) : (
            <span className="rounded-xl border border-dashed border-line-2 px-3 py-1.5 text-[11.5px] text-ink-3">Nobody holds this yet</span>
          )}
          {task.manager && <span className="text-[11px] text-ink-3">Accountable: {task.manager.name}</span>}
          {task.chatId && task.assignedTo && (
            <Link href={`/agents/${task.assignedTo.id}?chat=${task.chatId}`} className="ms-auto inline-flex items-center gap-1.5 text-[11.5px] text-brand hover:text-ink">
              <MessageSquare className="h-3.5 w-3.5" /> Open the conversation
            </Link>
          )}
        </section>

        <section>
          <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">Folder</h3>
          {picking ? (
            <FolderPicker
              value={task.workingDirectory ?? null}
              suggestedName={folderNameFrom(task.title)}
              onChange={(dir) => void act({ workingDirectory: dir })}
              onClose={() => setPicking(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => open && setPicking(true)}
              disabled={!open}
              className="flex w-full items-center gap-2 rounded-lg border border-line bg-white/[0.02] px-2.5 py-1.5 text-start transition-colors enabled:hover:border-brand/40 disabled:opacity-70"
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-ink-3" />
              <span className={task.workingDirectory ? "min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2" : "min-w-0 flex-1 text-[11.5px] text-ink-3"}>
                {task.workingDirectory ?? "The agent's own workspace"}
              </span>
              {open && <span className="shrink-0 text-[11px] text-brand">Change</span>}
            </button>
          )}
        </section>

        {(task.parent || task.children.length > 0) && (
          <section className="rounded-xl border border-line bg-white/[0.02] p-3">
            {task.parent && (
              <button
                type="button"
                onClick={() => onOpenTask?.(task.parent!.id)}
                disabled={!onOpenTask}
                className="mb-2 flex w-full items-start gap-2 text-start text-[11.5px] text-ink-3 enabled:hover:text-ink"
              >
                <CornerLeftUp className="mt-px h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0">
                  Part of <span dir="auto" className="text-ink-2">{task.parent.title}</span>
                </span>
              </button>
            )}
            {task.children.length > 0 && (
              <>
                <h3 className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">
                  <Users className="h-3.5 w-3.5" /> Delegated out of this
                  {task.waitingForTeam && <span className="rounded-md border border-brand/40 bg-brand/[0.12] px-1.5 py-px text-[10px] font-medium normal-case tracking-normal text-brand">waiting for the team</span>}
                </h3>
                <ul className="space-y-1">
                  {task.children.map((c) => <li key={c.id}><ChildRow child={c} onOpen={onOpenTask} /></li>)}
                </ul>
              </>
            )}
          </section>
        )}

        {task.description && (
          <section>
            <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">What was asked</h3>
            <p dir="auto" className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">{task.description}</p>
          </section>
        )}

        {task.status === "BLOCKED" && task.blockedReason && (
          <section className="rounded-xl border border-warning/30 bg-warning/[0.07] p-3">
            <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-warning">Blocked</h3>
            <p dir="auto" className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-warning">{task.blockedReason}</p>
          </section>
        )}

        {task.status === "DONE" && (
          <section className="rounded-xl border border-[#3dd68c]/25 bg-[#3dd68c]/[0.06] p-3">
            <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#5fe3a3]">Result</h3>
            <p dir="auto" className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">{task.resultSummary || "(no summary was given)"}</p>
            {task.result && Object.keys(task.result).length > 0 && (
              <dl className="mt-2 space-y-1 border-t border-[#3dd68c]/15 pt-2">
                {Object.entries(task.result).map(([k, v]) => (
                  <div key={k} className="flex flex-wrap gap-x-2 text-[11.5px]">
                    <dt className="text-ink-3">{k.replace(/_/g, " ")}</dt>
                    <dd className="min-w-0 break-words text-ink-2">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        )}

        <section>
          <h3 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">History</h3>
          <ol className="space-y-1.5">
            {history.map((e) => (
              <li key={e.id} className="flex gap-2.5 text-[11.5px]">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-line-2" />
                <span className="min-w-0 flex-1">
                  <span dir="auto" className="text-ink-2">{e.text}</span>
                  <span className="ms-1.5 whitespace-nowrap text-[10.5px] text-ink-3">{when(e.at)}</span>
                </span>
              </li>
            ))}
            {!history.length && <li className="text-[11.5px] text-ink-3">Nothing has happened yet.</li>}
          </ol>
        </section>
      </div>

      {error && <p className="border-t border-line px-4 py-2 text-[11.5px] text-[#ff8ea3]">{error}</p>}

      {open && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-3">
            <Flag className="h-3.5 w-3.5" />
            <Select
              className="h-8 w-[118px] text-[12px]"
              value={task.priority}
              disabled={busy}
              onChange={(e) => void act({ priority: e.target.value as TaskPriority })}
            >
              {["LOW", "NORMAL", "HIGH", "CRITICAL"].map((p) => <option key={p} value={p}>{p[0] + p.slice(1).toLowerCase()}</option>)}
            </Select>
          </label>
          <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-3">
            <ArrowRightLeft className="h-3.5 w-3.5" />
            <Select
              className="h-8 w-[168px] text-[12px]"
              value={task.assignedToAgentId ?? ""}
              disabled={busy}
              onChange={(e) => e.target.value && void act({ assignedToAgentId: e.target.value })}
            >
              <option value="">Assign to…</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.role}</option>)}
            </Select>
          </label>
          <div className="ms-auto flex items-center gap-2">
            {task.status === "BLOCKED" && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void act({ retry: true })} title="Send it back — the agent picks it up again">
                <RotateCcw className="h-3.5 w-3.5" /> Unblock and retry
              </Button>
            )}
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => {
                const reason = window.prompt(`Cancel “${task.title}”? Say why, briefly — it is recorded.`);
                if (reason === null) return;
                void act({ cancel: { reason } });
              }}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />} Cancel
            </Button>
          </div>
        </footer>
      )}
    </div>
  );
}

/** One piece of delegated work, as its parent sees it. */
function ChildRow({ child, onOpen }: { child: TaskLink; onOpen?: (id: string) => void }) {
  const meta = STATUS_META[child.status];
  return (
    <button
      type="button"
      onClick={() => onOpen?.(child.id)}
      disabled={!onOpen}
      className="flex w-full items-center gap-2 rounded-lg border border-line bg-white/[0.02] px-2 py-1.5 text-start transition-colors enabled:hover:border-brand/40 enabled:hover:bg-white/[0.05]"
    >
      <StatusDot status={child.status} size={18} />
      <span className="min-w-0 flex-1">
        <span dir="auto" className="block truncate text-[12px] text-ink-2">{child.title}</span>
        <span dir="auto" className="block truncate text-[10.5px] text-ink-3">
          {child.assignedTo ? child.assignedTo.name : "unassigned"} · <span className={meta.text}>{meta.label}</span>
          {child.status === "BLOCKED" && child.blockedReason ? ` — ${child.blockedReason}` : ""}
          {child.status === "DONE" && child.resultSummary ? ` — ${child.resultSummary}` : ""}
        </span>
      </span>
    </button>
  );
}
