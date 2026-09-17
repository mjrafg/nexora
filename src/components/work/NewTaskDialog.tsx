"use client";

import { useEffect, useState } from "react";
import { Check, Folder, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Form";
import { ErrorBox, Modal } from "@/components/payments/shared";
import { api, errorText, type TaskPriority } from "@/lib/client-api";
import { FolderPicker, type RecentFolder } from "./FolderPicker";
import { folderNameFrom } from "./bits";
import type { AgentView } from "@/lib/runtime/types";

/**
 * The owner creating work directly. Leaving the agent unset is deliberate:
 * a manager can pick up an unassigned task and decide who does it.
 */
export function NewTaskDialog({ agents, onClose, onCreated }: { agents: AgentView[]; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ title: "", description: "", assignedToAgentId: "", priority: "NORMAL" as TaskPriority });
  const [folder, setFolder] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [recents, setRecents] = useState<RecentFolder[]>([]);

  // folders the company already works in — a project root, or a previous task's
  useEffect(() => {
    Promise.all([api.tasks({ status: "all" }), api.projects().catch(() => ({ projects: [] }))])
      .then(([t, p]) => {
        const seen = new Map<string, RecentFolder>();
        for (const proj of p.projects) if (proj.rootPath) seen.set(proj.rootPath, { name: proj.title, path: proj.rootPath, meta: "project" });
        for (const task of t.tasks) {
          if (task.workingDirectory && !seen.has(task.workingDirectory)) {
            seen.set(task.workingDirectory, { name: task.workingDirectory.split("/").pop() || "folder", path: task.workingDirectory });
          }
        }
        setRecents([...seen.values()].slice(0, 6));
      })
      .catch(() => undefined);
  }, []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = form.title.trim().length > 2;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.createTask({
        title: form.title,
        description: form.description,
        priority: form.priority,
        assignedToAgentId: form.assignedToAgentId || null,
        workingDirectory: folder,
      });
      onCreated();
      onClose();
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  }

  const managers = agents.filter((a) => a.reports.length);
  return (
    <Modal
      title="New task"
      subtitle="Whoever you assign starts on their own — you never have to tell them to begin."
      onClose={onClose}
      width="max-w-xl"
    >
      <div className="grid gap-3">
        <Field label="What needs to happen">
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Fix the login issue" autoFocus />
        </Field>
        <Field label="Detail" hint="The outcome you want and anything they could not work out themselves. You do not need to say how to do it.">
          <Textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Customers report the login page rejecting valid passwords since this morning. Find the cause, fix it, and verify a real sign-in works." />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Who does it" hint={managers.length ? "Give it to a manager and they choose someone on their team." : undefined}>
            <Select value={form.assignedToAgentId} onChange={(e) => setForm({ ...form, assignedToAgentId: e.target.value })}>
              <option value="">Leave unassigned</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.role}{a.reports.length ? ` (${a.reports.length} report${a.reports.length === 1 ? "" : "s"})` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}>
              {["LOW", "NORMAL", "HIGH", "CRITICAL"].map((p) => <option key={p} value={p}>{p[0] + p.slice(1).toLowerCase()}</option>)}
            </Select>
          </Field>
        </div>
        <Field
          label="Folder"
          hint="Where the work happens. Leave it alone and the agent works in its own private workspace; point it at a repository or project folder and its runtime starts inside that directory."
        >
          {picking ? (
            <FolderPicker
              value={folder}
              suggestedName={folderNameFrom(form.title)}
              recents={recents}
              onChange={setFolder}
              onClose={() => setPicking(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="flex w-full items-center gap-2 rounded-lg border border-line bg-white/[0.04] px-3 py-2 text-start transition-colors hover:border-brand/50"
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-ink-3" />
              <span className={folder ? "min-w-0 flex-1 truncate font-mono text-[12px] text-ink" : "min-w-0 flex-1 text-[12.5px] text-ink-3"}>
                {folder ?? "The agent's own workspace"}
              </span>
              <span className="shrink-0 text-[11px] text-brand">{folder ? "Change" : "Choose or create…"}</span>
            </button>
          )}
        </Field>
      </div>
      {err && <div className="mt-3"><ErrorBox text={err} /></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}><X className="h-3.5 w-3.5" /> Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy || !valid}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Create task
        </Button>
      </div>
    </Modal>
  );
}
