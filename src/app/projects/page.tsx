"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FolderKanban, Plus, Loader2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { NewProjectDialog } from "@/components/projects/NewProjectDialog";
import { api, errorText } from "@/lib/client-api";
import type { ProjectView } from "@/lib/projects/types";

const STATE_COLOR: Record<string, string> = {
  PLANNING: "#818cf8", RUNNING: "#3dd68c", PAUSING: "#f5b942", PAUSED: "#6f7890", RESUMING: "#818cf8", COMPLETED: "#3dd68c", NEEDS_USER: "#f5b942", FAILED: "#ff5c7a",
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => api.projects().then((r) => setProjects(r.projects)).catch((e) => setError(errorText(e)));
  useEffect(() => {
    api.projects().then((r) => setProjects(r.projects)).catch((e) => setError(errorText(e)));
  }, []);

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Projects</h1>
          <p className="text-[12.5px] text-ink-3">A Director agent plans, Engineering agents build in isolated worktrees, an independent Reviewer judges every result.</p>
        </div>
        <Button variant="primary" size="md" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New project
        </Button>
      </div>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void load(); }} />}
      {error && <div className="glass rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div>}
      {!projects && !error && <div className="flex items-center gap-2 text-[12.5px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {projects?.map((p) => (
          <Link key={p.id} href={`/projects/${p.id}`} className="glass flex flex-col gap-2 rounded-2xl p-4 transition-colors hover:bg-white/[0.05]">
            <div className="flex items-center gap-2">
              <FolderKanban className="h-4 w-4 text-brand" />
              <span className="truncate text-[14px] font-semibold text-ink">{p.title}</span>
              <Badge color={STATE_COLOR[p.state]} className="ml-auto" dot>{p.state}</Badge>
            </div>
            <div className="truncate font-mono text-[10.5px] text-ink-3">{p.rootPath}</div>
            <p className="line-clamp-2 text-[12px] text-ink-2">{p.goal}</p>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-3">
              <span>Director <span className="text-ink-2">{p.directorAgentName}</span></span>
              <span>Builder <span className="text-ink-2">{p.builderAgentName}</span></span>
              <span>Reviewer <span className="text-ink-2">{p.reviewerAgentName}</span></span>
              <span className="num">{p.milestones.length} milestones · {p.counts.completed}/{p.counts.sessions} sessions done</span>
            </div>
          </Link>
        ))}
        {projects && projects.length === 0 && (
          <div className="glass col-span-full grid place-items-center rounded-2xl p-10 text-center">
            <FolderKanban className="h-8 w-8 text-ink-3" />
            <p className="mt-2 text-[13px] text-ink-2">No projects yet. Start one and the Director will plan it.</p>
          </div>
        )}
      </div>
    </AppShell>
  );
}
