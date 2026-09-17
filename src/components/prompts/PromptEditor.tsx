"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Clock, Download, GitCompare, Loader2, RotateCcw, Save, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { api, errorText, type PromptRevision, type PromptView } from "@/lib/client-api";
import { CATEGORY_LABELS } from "@/lib/prompts/types";
import { cn } from "@/lib/utils";
import { CategoryTag, DiffView, StatusTag, when } from "./bits";
import { PromptTextarea } from "./PromptTextarea";

type Tab = "edit" | "default" | "diff" | "history";

/**
 * One prompt, in full: what it resolves to now, what the built-in says, what
 * changed, and what it used to be. The built-in is always one click away and
 * is never at risk — resetting only removes the owner's copy.
 */
export function PromptEditor({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: (p: PromptView) => void }) {
  const [prompt, setPrompt] = useState<PromptView | null>(null);
  const [revisions, setRevisions] = useState<PromptRevision[]>([]);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<Tab>("edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // the page mounts a fresh editor per prompt (key={id}), so there is nothing
  // to reset here — just fetch the one this editor is for
  useEffect(() => {
    let alive = true;
    api.prompt(id)
      .then((d) => { if (!alive) return; setPrompt(d.prompt); setRevisions(d.revisions); setDraft(d.prompt.content); })
      .catch((e) => alive && setError(errorText(e)));
    return () => { alive = false; };
  }, [id]);

  const dirty = !!prompt && draft !== prompt.content;
  const diffPair = useMemo<[string, string]>(
    () => (prompt ? [prompt.defaultContent, dirty ? draft : prompt.content] : ["", ""]),
    [prompt, draft, dirty]
  );

  async function act(body: { content?: string; reset?: boolean; revisionId?: string }) {
    setBusy(true);
    setError(null);
    try {
      const d = await api.savePrompt(id, body);
      setPrompt(d.prompt);
      setRevisions(d.revisions);
      setDraft(d.prompt.content);
      onChanged(d.prompt);
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
      setConfirmReset(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function exportOne() {
    const r = await fetch("/api/prompts/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [id] }) });
    download(await r.blob(), `nexora-prompt-${id}.json`);
  }

  if (error && !prompt) return <div className="glass rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div>;
  if (!prompt) {
    return (
      <div className="glass flex items-center gap-2 rounded-2xl p-4 text-[12.5px] text-ink-3">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading prompt…
      </div>
    );
  }

  const tabs: [Tab, string][] = [["edit", "Prompt"], ["default", "Built-in default"], ["diff", "Difference"], ["history", `History${revisions.length ? ` (${revisions.length})` : ""}`]];

  return (
    <div className="glass flex min-h-0 flex-col overflow-hidden rounded-2xl">
      <header className="border-b border-line px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[14.5px] font-semibold tracking-tight text-ink">{prompt.name}</h2>
              <CategoryTag category={prompt.category} />
              <StatusTag customized={prompt.customized} updateAvailable={prompt.updateAvailable} />
            </div>
            <p className="mt-1 max-w-[70ch] text-[12px] leading-relaxed text-ink-3">{prompt.description}</p>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 text-ink-3 hover:text-ink" aria-label="Close prompt"><X className="h-4 w-4" /></button>
        </div>

        <dl className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <dt>ID</dt>
            <dd><code className="rounded border border-line bg-white/[0.04] px-1 py-px font-mono text-[10.5px] text-ink-2">{prompt.id}</code></dd>
          </span>
          <span className="flex items-center gap-1.5"><dt>Built-in</dt><dd className="num text-ink-2">v{prompt.version}</dd></span>
          {prompt.customized && (
            <span className="flex items-center gap-1.5"><dt>Customized from</dt><dd className="num text-ink-2">v{prompt.overrideBaseVersion ?? "?"}</dd></span>
          )}
          {prompt.lastModifiedAt && (
            <span className="flex items-center gap-1.5"><dt>Edited</dt><dd className="text-ink-2">{when(prompt.lastModifiedAt)} by {prompt.lastModifiedBy}{prompt.lastModifiedSource === "IMPORT" ? " (import)" : ""}</dd></span>
          )}
          {prompt.usedBy?.length ? (
            <span className="flex items-center gap-1.5"><dt>Used by</dt><dd className="text-ink-2">{prompt.usedBy.join(", ")}</dd></span>
          ) : null}
        </dl>

        {prompt.updateAvailable && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-warning/[0.07] px-3 py-2 text-[11.5px] text-warning">
            <span className="min-w-0 flex-1">
              Your version was written from built-in v{prompt.overrideBaseVersion}. The built-in is now v{prompt.version} — your text is untouched, and you can compare or take the new one.
            </span>
            <button type="button" onClick={() => setTab("diff")} className="underline underline-offset-2 hover:text-ink">Compare</button>
          </div>
        )}
      </header>

      <div className="flex gap-1 border-b border-line px-3">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn("border-b-2 px-2.5 py-2 text-[12px] transition-colors", tab === key ? "border-brand text-ink" : "border-transparent text-ink-3 hover:text-ink-2")}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {tab === "edit" && (
          <PromptTextarea value={draft} onChange={setDraft} onSave={() => dirty && void act({ content: draft })} placeholders={prompt.placeholders} />
        )}
        {tab === "default" && (
          <>
            <p className="mb-2 text-[11.5px] text-ink-3">
              The text that ships with Nexora, version {prompt.version}. It stays in source control and is never changed by editing above.
            </p>
            <PromptTextarea value={prompt.defaultContent} readOnly placeholders={prompt.placeholders} />
          </>
        )}
        {tab === "diff" && <DiffView before={diffPair[0]} after={diffPair[1]} labels={[`built-in v${prompt.version}`, dirty ? "your unsaved edit" : "in use now"]} />}
        {tab === "history" && (
          <div className="space-y-1.5">
            {!revisions.length && <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-[12px] text-ink-3">This prompt has never been changed.</p>}
            {revisions.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.02] px-3 py-2">
                <Clock className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] text-ink-2">
                    {r.content === null ? "Reset to the built-in" : r.source === "IMPORT" ? "Replaced by an import" : "Edited"}
                  </span>
                  <span className="block text-[10.5px] text-ink-3">{when(r.changedAt)} by {r.changedBy} · from built-in v{r.baseVersion}</span>
                </span>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void act({ revisionId: r.id })}>Restore</Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <p className="border-t border-line px-4 py-2 text-[11.5px] text-[#ff8ea3]">{error}</p>}

      <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        <Button variant="primary" size="sm" disabled={!dirty || busy} onClick={() => void act({ content: draft })}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
          {saved && !dirty ? "Saved" : "Save"}
        </Button>
        {dirty && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(prompt.content)}>Discard changes</Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setTab(tab === "diff" ? "edit" : "diff")}>
          <GitCompare className="h-3.5 w-3.5" /> {tab === "diff" ? "Back to the prompt" : "Compare with built-in"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void exportOne()}><Download className="h-3.5 w-3.5" /> Export</Button>
        <span className="ms-auto">
          {confirmReset ? (
            <span className="flex items-center gap-2 text-[11.5px] text-ink-2">
              Replace your version with the built-in?
              <Button variant="danger" size="sm" disabled={busy} onClick={() => void act({ reset: true })}>Reset</Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>Keep mine</Button>
            </span>
          ) : (
            <Button variant="outline" size="sm" disabled={!prompt.customized || busy} onClick={() => setConfirmReset(true)} title={prompt.customized ? "Remove your version and use the built-in again" : "This prompt is already the built-in"}>
              <RotateCcw className="h-3.5 w-3.5" /> Reset to default
            </Button>
          )}
        </span>
      </footer>
    </div>
  );
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export { CATEGORY_LABELS };
