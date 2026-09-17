"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, CornerLeftUp, Folder, FolderOpen, FolderPlus, HardDrive, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { api, errorText, type DirListing } from "@/lib/client-api";
import { cn } from "@/lib/utils";

/**
 * Choose the folder a task runs in — browse to one, or make a new one here.
 * Without a folder the agent works in its own private workspace; with one,
 * its runtime starts inside that directory, which is how work reaches a real
 * repository or project.
 */
export type RecentFolder = { name: string; path: string; meta?: string };

export function FolderPicker({
  value,
  suggestedName,
  recents,
  recentsLabel = "Recent folders",
  allowNone = true,
  onChange,
  onClose,
}: {
  value: string | null;
  suggestedName?: string;
  /** folders already in use, so the common case is one click */
  recents?: RecentFolder[];
  recentsLabel?: string;
  /** may the work run with no folder at all (an agent's own workspace)? */
  allowNone?: boolean;
  onChange: (path: string | null) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [typed, setTyped] = useState(value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(suggestedName ?? "");

  const browse = useCallback((path: string) => {
    setBusy(true);
    setError(null);
    api.browseFolder(path)
      .then((r) => { if (r.listing) { setListing(r.listing); setTyped(r.listing.path); } })
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    let alive = true;
    api.browseFolder(value || undefined)
      .then((r) => {
        if (!alive) return;
        if (r.listing) { setListing(r.listing); setTyped(r.listing.path); }
        else if (r.quickLinks?.length) browse(r.quickLinks[0].path);
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => { alive = false; };
  }, [value, browse]);

  async function create() {
    if (!listing || !newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.createFolder(listing.path, newName);
      setCreating(false);
      setNewName("");
      onChange(r.created.path);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-line-2 bg-[#0d1119]">
      {/* folders already in use — usually the answer */}
      {recents && recents.length > 0 && (
        <div className="border-b border-line px-2.5 py-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-3">{recentsLabel}</div>
          <div className="max-h-[104px] space-y-0.5 overflow-y-auto">
            {recents.map((r) => (
              <button
                key={r.path}
                type="button"
                onClick={() => { onChange(r.path); onClose(); }}
                className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-start transition-colors hover:bg-white/[0.06]"
              >
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                <span className="shrink-0 text-[12px] font-medium text-ink">{r.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-3">{r.path}</span>
                {r.meta && <span className="shrink-0 text-[10px] text-ink-3">{r.meta}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* where we are */}
      <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-2">
        <HardDrive className="h-3.5 w-3.5 shrink-0 text-ink-3" />
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); browse(typed); } }}
          spellCheck={false}
          placeholder="/opt/myproject"
          className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-3"
        />
        {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-3" />}
        <Button type="button" variant="ghost" size="xs" onClick={() => browse(typed)} disabled={!typed.trim()}>Open</Button>
        <button type="button" onClick={onClose} className="shrink-0 text-ink-3 hover:text-ink" aria-label="Close the folder picker">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* where to start, and how to make a new one */}
      {listing && (
        <div className="flex flex-wrap items-center gap-1 border-b border-line px-2.5 py-1.5">
          {listing.quickLinks.map((q) => (
            <button
              key={q.path}
              type="button"
              onClick={() => browse(q.path)}
              className={cn(
                "rounded-md border px-1.5 py-0.5 text-[10.5px] transition-colors",
                listing.path === q.path ? "border-brand/50 bg-brand/[0.14] text-ink" : "border-line text-ink-3 hover:border-brand/40 hover:text-ink"
              )}
            >
              {q.name}
            </button>
          ))}
          <button
            type="button"
            disabled={!listing.writable}
            title={listing.writable ? "Make a new folder here" : "This folder is not writable"}
            onClick={() => { setNewName(suggestedName ?? ""); setCreating(true); }}
            className="ms-auto inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10.5px] text-ink-2 transition-colors enabled:hover:border-brand/40 enabled:hover:text-ink disabled:opacity-40"
          >
            <FolderPlus className="h-3 w-3" /> New folder
          </button>
        </div>
      )}

      {/* folders here */}
      <div className="max-h-[210px] min-h-[120px] overflow-y-auto p-1.5">
        {listing?.parent && (
          <button
            type="button"
            onClick={() => browse(listing.parent!)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-ink-3 transition-colors hover:bg-white/[0.05] hover:text-ink"
          >
            <CornerLeftUp className="h-3.5 w-3.5" /> up one level
          </button>
        )}
        {listing?.dirs.map((d) => (
          <button
            key={d.path}
            type="button"
            onClick={() => browse(d.path)}
            onDoubleClick={() => { onChange(d.path); onClose(); }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-white/[0.05]"
          >
            <Folder className="h-3.5 w-3.5 shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">{d.name}</span>
            <ChevronRight className="h-3 w-3 shrink-0 text-ink-3" />
          </button>
        ))}
        {listing && !listing.dirs.length && (
          <p className="px-2 py-3 text-[11.5px] text-ink-3">
            No folders here{listing.hidden > 0 ? ` (${listing.hidden} hidden)` : ""}. You can still use this one, or make a new folder inside it.
          </p>
        )}
        {!listing && !error && <div className="flex items-center gap-2 px-2 py-3 text-[11.5px] text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading…</div>}
      </div>

      {error && <p className="border-t border-line px-2.5 py-1.5 text-[11px] text-[#ff8ea3]">{error}</p>}

      {/* make one, or take this one */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-2.5 py-2">
        {creating ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1.5"
            onSubmit={(e) => { e.preventDefault(); void create(); }}
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0 text-brand" />
            <input
              value={newName}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setCreating(false); }}
              placeholder="new-folder-name"
              className="min-w-0 flex-1 rounded-md border border-line bg-white/[0.04] px-2 py-1 font-mono text-[11.5px] outline-none focus:border-brand/60"
            />
            <Button type="submit" variant="primary" size="xs" disabled={busy || !newName.trim()}>Create and use</Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setCreating(false)}>Cancel</Button>
          </form>
        ) : (
          <>
            {allowNone && value && (
              <Button type="button" variant="ghost" size="xs" onClick={() => { onChange(null); onClose(); }}>
                Use the agent&apos;s own workspace
              </Button>
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-3">{listing?.path ?? ""}</span>
            <Button
              type="button"
              variant="primary"
              size="xs"
              disabled={!listing}
              onClick={() => { onChange(listing!.path); onClose(); }}
            >
              <Check className="h-3.5 w-3.5" /> Use this folder
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** The folder a task is pinned to, as one quiet line. */
export function FolderLine({ path, className }: { path: string | null | undefined; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-[11px] text-ink-3", className)}>
      <Folder className="h-3 w-3 shrink-0" />
      <span className="truncate font-mono">{path || "the agent's own workspace"}</span>
    </span>
  );
}
