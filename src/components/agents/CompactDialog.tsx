"use client";

import { useState } from "react";
import { ArrowRight, Loader2, X } from "lucide-react";
import { api, errorText, type ChatContextUsage, type CompactOutcome } from "@/lib/client-api";
import { RUNTIMES } from "@/lib/runtime/catalog";
import { Button } from "@/components/ui/Button";
import { fmtTokens } from "./ContextMeter";

/**
 * Provider-native compaction. The runtime that owns this thread's session
 * summarizes its own context and keeps the same session; Nexora never
 * summarizes the conversation itself and never sends it to another model.
 * The transcript, the logs and the exports stay complete either way.
 */
type Props = {
  agentId: string;
  chatId: string;
  agentName: string;
  usage: ChatContextUsage | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
};

/** Mounted only while open, so every run starts from a clean state. */
export function CompactDialog(props: Props) {
  return props.open ? <Dialog {...props} /> : null;
}

function Dialog({ agentId, chatId, agentName, usage, onClose, onDone }: Props) {
  const [phase, setPhase] = useState<"confirm" | "running" | "done" | "error">("confirm");
  const [outcome, setOutcome] = useState<CompactOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const label = RUNTIMES[usage?.runtimeType ?? "claude-code"]?.label ?? "the runtime";

  async function run() {
    setPhase("running");
    try {
      const r = await api.compactChat(agentId, chatId);
      if (!r.outcome.ok) { setError(r.outcome.error ?? "Compaction failed."); setPhase("error"); return; }
      setOutcome(r.outcome);
      setPhase("done");
      onDone();
    } catch (e) {
      setError(errorText(e));
      setPhase("error");
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onMouseDown={() => phase !== "running" && onClose()}>
      <div className="glass-strong w-full max-w-[520px] rounded-2xl p-5 shadow-2xl shadow-black/60" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold tracking-tight">Compact context</h2>
          {phase !== "running" && (
            <button type="button" onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close"><X className="h-4 w-4" /></button>
          )}
        </div>

        {phase === "confirm" && (
          <div className="space-y-3 text-[12.5px] leading-relaxed text-ink-2">
            <p>
              {label} compacts its own session context — it summarizes internally and the same session continues with {agentName}.
              Nothing is sent to another model.
            </p>
            {usage?.usedTokens != null && (
              <p className="text-ink-3">
                Right now: {usage.source === "provider" ? "" : "~"}{fmtTokens(usage.total)}
                {usage.windowTokens ? ` of ${fmtTokens(usage.windowTokens)}` : ""} tokens
                {usage.source === "provider" ? ` (${label}-reported)` : " (estimated)"}.
              </p>
            )}
            <p className="text-[11.5px] text-ink-3">The full transcript, the logs and every export stay complete — only what the runtime keeps in its head shrinks.</p>
          </div>
        )}

        {phase === "running" && (
          <div className="flex items-center justify-center gap-3 py-8 text-[13px] text-ink-3">
            <Loader2 className="h-4 w-4 animate-spin" /> {label} is compacting its own session…
          </div>
        )}

        {phase === "error" && (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] leading-relaxed text-[#ff8ea3]">{error}</p>
        )}

        {phase === "done" && outcome && (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-5 py-2">
              <Stat label="Before" value={outcome.beforeTokens} />
              <ArrowRight className="h-4 w-4 text-ink-3" />
              <Stat label="After" value={outcome.afterTokens} accent />
            </div>
            <p className="text-center text-[11.5px] leading-relaxed text-ink-3">
              Compacted by {label} · {outcome.model} — values {outcome.source === "provider" ? `${label}-reported` : "estimated"}. The session continues.
            </p>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          {phase === "confirm" ? (
            <>
              <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={() => void run()}>Compact via {label}</Button>
            </>
          ) : phase === "running" ? (
            <span className="text-[11.5px] text-ink-3">This can take a while on a long conversation…</span>
          ) : (
            <Button variant="primary" size="sm" onClick={onClose}>Done</Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value?: number; accent?: boolean }) {
  return (
    <div className="text-center">
      <div className={`num text-[22px] font-semibold ${accent ? "text-brand" : "text-ink"}`}>{value == null ? "—" : fmtTokens(value)}</div>
      <div className="text-[10px] uppercase tracking-wide text-ink-3">{label}</div>
    </div>
  );
}
