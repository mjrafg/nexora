"use client";

import { useEffect, useState } from "react";
import { FolderOpen, Loader2, X, Sparkles } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Form";
import { FolderPicker, type RecentFolder } from "@/components/work/FolderPicker";
import { folderNameFrom } from "@/components/work/bits";
import { api, errorText } from "@/lib/client-api";
import type { AgentView } from "@/lib/runtime/types";

/** "5d ago" for the recents list. */
function ago(iso: string): string {
  const h = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [title, setTitle] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [goal, setGoal] = useState("");
  const [director, setDirector] = useState("");
  const [builder, setBuilder] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [recents, setRecents] = useState<RecentFolder[]>([]);

  useEffect(() => {
    api.agents().then((r) => {
      setAgents(r.agents);
      const eng = r.agents.filter((a) => a.dept === "engineering");
      const cli = (a: AgentView) => a.runtime.runtimeType !== "api";
      const d = eng.find((a) => /cto|chief/i.test(a.role) && cli(a)) ?? eng.find(cli) ?? r.agents.find(cli);
      const b = eng.find((a) => cli(a) && a.id !== d?.id) ?? eng.find(cli);
      const rv = eng.find((a) => cli(a) && a.id !== d?.id && a.id !== b?.id) ?? r.agents.find((a) => cli(a) && a.id !== b?.id);
      setDirector(d?.id ?? "");
      setBuilder(b?.id ?? "");
      setReviewer(rv?.id ?? "");
    }).catch((e) => setError(errorText(e)));
    // the folders this company already builds in: usually the answer
    api.projects()
      .then((r) => setRecents(r.projects.slice(0, 6).map((p) => ({ name: p.title, path: p.rootPath, meta: ago(p.updatedAt) }))))
      .catch(() => undefined);
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // the folder is chosen (and created, if new) in the picker, so it exists by now
      await api.createProject({ title: title.trim() || undefined, rootPath, goal, directorAgentId: director, builderAgentId: builder, reviewerAgentId: reviewer, createDir: false });
      onCreated();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  const options = (filter?: (a: AgentView) => boolean) => agents.filter(filter ?? (() => true)).map((a) => (
    <option key={a.id} value={a.id}>{a.name} — {a.role} ({a.runtime.runtimeType})</option>
  ));

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <Panel elevated title="New project" subtitle="The Director plans milestones; Builders build; the Reviewer judges." icon={<Sparkles className="h-4 w-4 text-brand" />} action={<Button variant="ghost" size="xs" onClick={onClose}><X className="h-3 w-3" /></Button>}>
          <div className="space-y-3">
            <Field label="Title" hint="Optional. Leave it empty and the Director names the project when it writes the plan.">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Named from your goal unless you say otherwise" />
            </Field>
            <Field label="Project folder" hint="Where this project is built, on this server. Pick one you already use, browse to it, or make a new folder here. A git repo is initialised if the folder has none.">
              {picking ? (
                <FolderPicker
                  value={rootPath || null}
                  suggestedName={folderNameFrom(title || goal)}
                  recents={recents}
                  recentsLabel="Projects you already have"
                  allowNone={false}
                  onChange={(dir) => setRootPath(dir ?? "")}
                  onClose={() => setPicking(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setPicking(true)}
                  className="flex w-full items-center gap-2 rounded-lg border border-line bg-white/[0.04] px-3 py-2 text-start transition-colors hover:border-brand/50"
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                  <span className={rootPath ? "min-w-0 flex-1 truncate font-mono text-[12px] text-ink" : "min-w-0 flex-1 text-[12.5px] text-ink-3"}>
                    {rootPath || "No folder chosen yet"}
                  </span>
                  <span className="shrink-0 text-[11px] text-brand">{rootPath ? "Change" : "Choose or create…"}</span>
                </button>
              )}
            </Field>
            <Field label="Goal" hint="What the finished project must do. The Director turns this into milestones.">
              <Textarea rows={5} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Build a REST API for invoices with…" />
            </Field>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label="Director" hint="Plans and orchestrates; never edits code."><Select value={director} onChange={(e) => setDirector(e.target.value)}>{options()}</Select></Field>
              <Field label="Default Builder" hint="Needs Claude Code or Codex (file + shell tools)."><Select value={builder} onChange={(e) => setBuilder(e.target.value)}>{options((a) => a.runtime.runtimeType !== "api")}</Select></Field>
              <Field label="Reviewer" hint="Independent, read-only judgement of every result."><Select value={reviewer} onChange={(e) => setReviewer(e.target.value)}>{options()}</Select></Field>
            </div>
            {error && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-[#ff8ea3]">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={submit} disabled={busy || !rootPath.trim() || !goal.trim() || !director || !builder || !reviewer}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Start project
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
