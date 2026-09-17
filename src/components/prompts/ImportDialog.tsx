"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Ban, Check, FileUp, Loader2, Minus, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { api, errorText, type ImportPreview } from "@/lib/client-api";
import { cn } from "@/lib/utils";
import { DiffView } from "./bits";

const VERDICT: Record<string, { label: string; tone: string; icon: typeof Check; blurb: string }> = {
  update: { label: "Will change", tone: "text-brand", icon: Check, blurb: "The built-in text is in use; this file replaces it." },
  conflict: { label: "Replaces yours", tone: "text-warning", icon: AlertTriangle, blurb: "You already have your own version of this prompt." },
  unchanged: { label: "No change", tone: "text-ink-3", icon: Minus, blurb: "Already exactly this text." },
  unknown: { label: "Unknown id", tone: "text-ink-3", icon: Ban, blurb: "This Nexora has no prompt with that id." },
  invalid: { label: "Cannot import", tone: "text-[#ff8ea3]", icon: Ban, blurb: "" },
};

/**
 * Importing prompts, with the preview first.
 *
 * Nothing is written until the owner has seen every prompt the file would
 * touch and ticked it. A conflict — a prompt they wrote themselves — is
 * called out rather than quietly overwritten.
 */
export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [file, setFile] = useState<unknown>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ applied: number; skipped: number } | null>(null);

  const applicable = useMemo(() => (preview?.entries ?? []).filter((e) => e.verdict === "update" || e.verdict === "conflict"), [preview]);

  async function read(f: File) {
    setError(null);
    setBusy(true);
    try {
      const parsed: unknown = JSON.parse(await f.text());
      setFile(parsed);
      setFileName(f.name);
      const d = await api.previewPromptImport(parsed);
      setPreview(d.preview);
      setChosen(new Set(d.suggested));
    } catch (e) {
      setPreview(null);
      setError(e instanceof SyntaxError ? "That file is not valid JSON." : errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const d = await api.applyPromptImport(file, [...chosen]);
      setDone({ applied: d.result.applied.length, skipped: d.result.skipped.length });
      onImported();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-3" onClick={onClose}>
      <div className="glass-strong flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl shadow-2xl shadow-black/60" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <FileUp className="h-4 w-4 text-brand" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold tracking-tight">Import prompts</h2>
            <p className="text-[11.5px] text-ink-3">{fileName ? `${fileName}${preview?.exportedAt ? ` · exported ${preview.exportedAt.slice(0, 10)}` : ""}` : "Choose a Nexora prompt export file. Nothing is changed until you say so."}</p>
          </div>
          <button type="button" onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close"><X className="h-4 w-4" /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {done ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <span className="grid h-11 w-11 place-items-center rounded-2xl border border-[#3dd68c]/35 bg-[#3dd68c]/[0.12] text-[#5fe3a3]"><Check className="h-5 w-5" /></span>
              <p className="text-[13.5px] font-semibold">{done.applied} prompt{done.applied === 1 ? "" : "s"} imported</p>
              <p className="max-w-[46ch] text-[12px] text-ink-3">{done.skipped ? `${done.skipped} were skipped — unknown ids or text that was already identical.` : "Everything you selected was applied."}</p>
            </div>
          ) : !preview ? (
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border border-dashed border-line-2 px-6 py-12 text-center transition-colors hover:border-brand/40 hover:bg-white/[0.02]">
              <span className="grid h-11 w-11 place-items-center rounded-2xl border border-line bg-white/[0.03] text-ink-3">
                {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
              </span>
              <span className="text-[13px] font-medium text-ink">Choose a prompt file</span>
              <span className="max-w-[44ch] text-[11.5px] text-ink-3">A JSON file exported from Nexora. Prompts are matched by their id, so names may safely differ.</span>
              <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); }} />
            </label>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                {([["update", preview.counts.update], ["conflict", preview.counts.conflict], ["unchanged", preview.counts.unchanged], ["unknown", preview.counts.unknown], ["invalid", preview.counts.invalid]] as const).map(([k, n]) => (
                  <span key={k} className={cn("rounded-lg border border-line px-2.5 py-1 text-[11.5px]", n ? VERDICT[k].tone : "text-ink-3 opacity-60")}>
                    {VERDICT[k].label} <span className="num">{n}</span>
                  </span>
                ))}
              </div>
              <ul className="space-y-1.5">
                {preview.entries.map((e) => {
                  const meta = VERDICT[e.verdict];
                  const Icon = meta.icon;
                  const selectable = e.verdict === "update" || e.verdict === "conflict";
                  return (
                    <li key={`${e.id}-${e.name}`} className="rounded-xl border border-line bg-white/[0.02]">
                      <div className="flex items-center gap-2.5 px-3 py-2">
                        <input
                          type="checkbox"
                          disabled={!selectable}
                          checked={chosen.has(e.id)}
                          onChange={(ev) => setChosen((s) => { const n = new Set(s); if (ev.target.checked) n.add(e.id); else n.delete(e.id); return n; })}
                          className="h-3.5 w-3.5 shrink-0 accent-[color:var(--color-brand)] disabled:opacity-30"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] text-ink">{e.name}</span>
                          <span className="block truncate font-mono text-[10.5px] text-ink-3">{e.id || "(no id)"}</span>
                        </span>
                        <span className={cn("flex shrink-0 items-center gap-1.5 text-[11px]", meta.tone)}>
                          <Icon className="h-3.5 w-3.5" /> {meta.label}
                        </span>
                        {selectable && (
                          <button type="button" onClick={() => setOpen(open === e.id ? null : e.id)} className="shrink-0 text-[11px] text-brand hover:text-ink">
                            {open === e.id ? "Hide" : "Compare"}
                          </button>
                        )}
                      </div>
                      {(e.problem || open === e.id) && (
                        <div className="border-t border-line px-3 py-2">
                          {e.problem && <p className="mb-2 text-[11.5px] text-ink-3">{e.problem}</p>}
                          {open === e.id && <DiffView before={e.current} after={e.incoming} labels={["in use now", "from the file"]} />}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {error && <p className="mt-3 text-[11.5px] text-[#ff8ea3]">{error}</p>}
        </div>

        <footer className="flex items-center gap-2 border-t border-line px-4 py-3">
          {done ? (
            <Button variant="primary" size="sm" className="ms-auto" onClick={onClose}>Done</Button>
          ) : (
            <>
              {preview && (
                <span className="text-[11.5px] text-ink-3">
                  {chosen.size} of {applicable.length} selected
                  {applicable.length > 0 && (
                    <>
                      {" · "}
                      <button type="button" className="text-brand hover:text-ink" onClick={() => setChosen(new Set(applicable.map((e) => e.id)))}>select all</button>
                      {" · "}
                      <button type="button" className="text-brand hover:text-ink" onClick={() => setChosen(new Set())}>none</button>
                    </>
                  )}
                </span>
              )}
              <span className="ms-auto flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
                <Button variant="primary" size="sm" disabled={!preview || !chosen.size || busy} onClick={() => void apply()}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Import {chosen.size || ""}
                </Button>
              </span>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
