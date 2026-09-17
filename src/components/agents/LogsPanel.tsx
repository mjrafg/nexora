"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Loader2, RefreshCw, Search, X } from "lucide-react";
import { api, errorText, type ChatLogEntry } from "@/lib/client-api";
import { ExportMenu } from "./ExportMenu";
import { cn } from "@/lib/utils";

/** Filter by what an entry is, not by how it happened to be recorded. */
const FILTERS = [
  { key: "all", label: "Everything", groups: null },
  { key: "messages", label: "Messages", groups: ["message"] },
  { key: "steps", label: "Steps", groups: ["tool", "browser", "command", "file", "model"] },
  { key: "tools", label: "Tools", groups: ["tool"] },
  { key: "browser", label: "Browser", groups: ["browser"] },
  { key: "failed", label: "Failures", groups: null },
] as const;

type Filter = (typeof FILTERS)[number]["key"];

/**
 * The complete log of a conversation: every message, every step, every tool
 * call with its input and output, guard verdicts and compactions, in the order
 * they happened. Copy a single entry, or export the whole thing.
 */
export function LogsPanel({ agentId, chatId, onClose }: { agentId: string; chatId: string; onClose: () => void }) {
  const [entries, setEntries] = useState<ChatLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    return api
      .chatLogs(agentId, chatId)
      .then((r) => { setEntries(r.entries); setError(null); })
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  }, [agentId, chatId]);

  useEffect(() => {
    let alive = true;
    api
      .chatLogs(agentId, chatId)
      .then((r) => { if (alive) { setEntries(r.entries); setError(null); } })
      .catch((e) => alive && setError(errorText(e)));
    return () => { alive = false; };
  }, [agentId, chatId]);

  const shown = (entries ?? []).filter((e) => {
    const groups = FILTERS.find((f) => f.key === filter)?.groups as readonly string[] | null | undefined;
    if (filter === "failed") {
      if (e.status !== "failed" && !e.error) return false;
    } else if (groups && !groups.includes(e.group)) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return [e.label, e.title, e.meta, e.input, e.output, e.url].some((v) => v?.toLowerCase().includes(q));
  });

  return (
    <section className="glass flex min-h-0 w-full flex-col overflow-hidden rounded-2xl">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">
          Logs {entries && <span className="num font-normal normal-case tracking-normal">· {entries.length} entries</span>}
        </h2>
        <button type="button" onClick={() => void load()} title="Reload" className="text-ink-3 hover:text-ink">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
        <ExportMenu agentId={agentId} chatId={chatId} />
        <button type="button" onClick={onClose} title="Close logs" className="text-ink-3 hover:text-ink"><X className="h-4 w-4" /></button>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              "rounded-md border px-2 py-0.5 text-[10.5px] transition-colors",
              filter === f.key ? "border-brand/50 bg-brand/[0.14] text-ink" : "border-line text-ink-3 hover:text-ink"
            )}
          >
            {f.label}
          </button>
        ))}
        <label className="ms-auto flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line px-2 py-1">
          <Search className="h-3 w-3 shrink-0 text-ink-3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the log…"
            dir="auto"
            className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none placeholder:text-ink-3"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {entries === null && !error && <div className="flex items-center gap-2 p-3 text-[11.5px] text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the log…</div>}
        {error && <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11.5px] text-[#ff8ea3]">{error}</p>}
        {entries && !entries.length && (
          <p className="p-3 text-[11.5px] leading-relaxed text-ink-3">Nothing recorded yet. Every message, step, tool call and result lands here as the conversation happens.</p>
        )}
        {entries && entries.length > 0 && !shown.length && <p className="p-3 text-[11.5px] text-ink-3">Nothing matches that filter.</p>}
        {shown.map((e) => <LogRow key={`${e.id}-${e.at}-${e.kind}`} entry={e} />)}
      </div>
    </section>
  );
}

function LogRow({ entry }: { entry: ChatLogEntry }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const detailed = !!(entry.input || entry.output || entry.url || entry.guard || entry.usage);

  async function copy() {
    const text = [
      `[${entry.at}] ${entry.label} · ${entry.title}`,
      entry.meta ? `meta: ${entry.meta}` : "",
      entry.url ? `url: ${entry.url}` : "",
      entry.guard ? `guard: ${entry.guard.outcome}` : "",
      entry.input ? `\ninput:\n${entry.input}` : "",
      entry.output ? `\noutput:\n${entry.output}` : "",
    ].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div className={cn("rounded-lg border text-[11.5px]", entry.status === "failed" || entry.error ? "border-danger/30 bg-danger/[0.07]" : "border-line bg-white/[0.02]")}>
      <div className="flex items-start gap-1.5 px-2 py-1.5">
        <button type="button" onClick={() => detailed && setOpen((o) => !o)} className="flex min-w-0 flex-1 items-start gap-1.5 text-start">
          {detailed ? (
            open ? <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-ink-3" /> : <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-ink-3" />
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span className="min-w-0 flex-1">
            <span className="me-1.5 text-ink-3">{entry.label}</span>
            <span dir="auto" className="break-words text-ink-2">{entry.title || "(empty)"}</span>
            {entry.stopped && <span className="ms-1.5 rounded border border-warning/40 bg-warning/10 px-1 text-[10px] text-warning">stopped</span>}
            {entry.guard && entry.guard.outcome !== "executed" && (
              <span className="ms-1.5 rounded border border-operations/40 bg-operations/10 px-1 text-[10px] text-operations">{entry.guard.outcome}</span>
            )}
          </span>
        </button>
        <span className="num shrink-0 pt-px text-[10px] text-ink-3">{new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
        <button type="button" onClick={() => void copy()} title="Copy this entry" className="shrink-0 pt-px text-ink-3 hover:text-ink">
          {copied ? <Check className="h-3 w-3 text-[#5fe3a3]" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
      {open && (
        <div className="space-y-1.5 border-t border-line px-2 py-1.5">
          {entry.meta && <Field k="Context" v={entry.meta} />}
          {entry.url && <Field k="URL" v={entry.url} />}
          {entry.durationMs != null && <Field k="Took" v={entry.durationMs >= 1000 ? `${(entry.durationMs / 1000).toFixed(1)}s` : `${entry.durationMs}ms`} />}
          {entry.guard && <Field k="Guard" v={`${entry.guard.outcome}${entry.guard.class ? ` · ${entry.guard.class}` : ""}`} />}
          {entry.usage && <Field k="Usage" v={Object.entries(entry.usage).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(" · ")} />}
          {entry.input && <Block k="Input" v={entry.input} />}
          {entry.output && <Block k={entry.error ? "Error" : "Output"} v={entry.output} />}
        </div>
      )}
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2 text-[10.5px]">
      <span className="shrink-0 text-ink-3">{k}</span>
      <span className="min-w-0 break-words text-ink-2">{v}</span>
    </div>
  );
}

function Block({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[9.5px] uppercase tracking-wide text-ink-3">{k}</div>
      <pre dir="auto" className="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-1.5 text-[10.5px] text-ink-2">{v}</pre>
    </div>
  );
}
