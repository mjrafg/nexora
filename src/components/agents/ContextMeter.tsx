"use client";

import { useEffect, useRef, useState } from "react";
import { Archive, Info } from "lucide-react";
import type { ChatContextUsage } from "@/lib/client-api";
import { RUNTIMES } from "@/lib/runtime/catalog";
import { cn } from "@/lib/utils";

export const fmtTokens = (n: number | null | undefined): string =>
  n == null ? "—" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

const WARN = 70;
const CRIT = 88;

function tone(pct: number | null): "ok" | "warn" | "crit" {
  if (pct == null) return "ok";
  return pct >= CRIT ? "crit" : pct >= WARN ? "warn" : "ok";
}

const COLOR = { ok: "var(--color-ink-3, #8b93ab)", warn: "#f5b942", crit: "#ff5c7a" } as const;

/**
 * How full the conversation's provider context is. A provider-reported number
 * is shown as it was reported; anything Nexora had to estimate is marked "~"
 * and named as an estimate in the popover. Nothing here is invented.
 */
export function ContextMeter({ usage, onCompact }: { usage: ChatContextUsage | null; onCompact: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  if (!usage || usage.source === "none") return null;
  const t = tone(usage.pct);
  const color = COLOR[t];
  const ring = Math.min(100, usage.pct ?? 0);
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const approx = usage.source !== "provider" || usage.pendingTokens > 0;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Conversation context"
        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:border-line-2 hover:text-ink"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" className="-rotate-90">
          <circle cx="8" cy="8" r={r} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="2.5" />
          {usage.pct != null && (
            <circle cx="8" cy="8" r={r} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${(ring / 100) * c} ${c}`} />
          )}
        </svg>
        <span className="num" style={{ color: t === "ok" ? undefined : color }}>
          {approx ? "~" : ""}{fmtTokens(usage.total)}
          <span className="hidden text-ink-3 sm:inline"> / {usage.windowTokens ? fmtTokens(usage.windowTokens) : "?"}</span>
        </span>
      </button>

      {open && (
        <div className="absolute end-0 top-9 z-40 w-[300px] max-w-[calc(100vw-24px)] rounded-xl border border-line-2 bg-[#141824] p-3.5 shadow-2xl shadow-black/60">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[12.5px] font-medium text-ink">Context</span>
            {usage.pct != null && <span className="num text-[12px]" style={{ color }}>{usage.pct}%</span>}
          </div>
          <div className="mb-2.5 h-[6px] overflow-hidden rounded-full bg-white/[0.08]">
            <div className="h-full rounded-full transition-all" style={{ width: `${ring}%`, background: usage.pct != null ? color : "transparent" }} />
          </div>
          <div className="space-y-1 text-[11.5px]">
            <Row k="In the session" v={`${usage.source === "provider" ? "" : "~"}${fmtTokens(usage.usedTokens)} tokens`} />
            {usage.pendingTokens > 0 && <Row k="Since that report" v={`+ ~${fmtTokens(usage.pendingTokens)} (estimate)`} />}
            <Row k="Provider window" v={usage.windowTokens ? `${fmtTokens(usage.windowTokens)} tokens` : "not reported yet"} />
            <Row k="Turns" v={String(usage.turns)} />
            <div className="my-1.5 border-t border-line" />
            <Row k="Source" v={usage.source === "provider" ? `${RUNTIMES[usage.runtimeType]?.label ?? usage.runtimeType} reported` : "Nexora estimate"} />
            {usage.model && <Row k="Model" v={usage.model} />}
            {usage.autoCompact.enabled && usage.compact.available && (
              <Row k="Auto compact" v={`at ${usage.autoCompact.pct}% or ${Math.round(usage.autoCompact.maxTokens / 1000)}k`} />
            )}
            {usage.lastCompaction && (
              <Row k="Last compaction" v={`${fmtTokens(usage.lastCompaction.beforeTokens)} → ${fmtTokens(usage.lastCompaction.afterTokens)}`} />
            )}
          </div>
          <p className="mt-2 flex gap-1.5 text-[10.5px] leading-snug text-ink-3">
            <Info className="mt-px h-3 w-3 shrink-0" />
            {usage.source === "provider"
              ? "The size the runtime itself reported for this session. Anything recorded since is a separate Nexora estimate."
              : usage.compact.available
                ? "No report from the runtime for this conversation yet — this is Nexora's estimate of the transcript, replaced by the real number after the next turn."
                : "This runtime does not report its session size, so the whole figure is a Nexora estimate of the transcript."}
          </p>
          {usage.compact.available && usage.compact.worthwhile ? (
            <button
              type="button"
              onClick={() => { setOpen(false); onCompact(); }}
              className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-line-2 px-3 py-1.5 text-[12px] text-ink-2 transition-colors hover:bg-white/[0.06] hover:text-ink"
            >
              <Archive className="h-3.5 w-3.5" /> Compact context…
            </button>
          ) : (
            <p className="mt-3 rounded-lg border border-line bg-white/[0.03] px-2.5 py-2 text-[10.5px] leading-relaxed text-ink-3">{usage.compact.reason}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-ink-3">{k}</span>
      <span className="num text-ink-2">{v}</span>
    </div>
  );
}

/** A quiet line above the composer once the thread is genuinely full. */
export function ContextBanner({ usage, onCompact }: { usage: ChatContextUsage | null; onCompact: () => void }) {
  if (!usage || usage.pct == null) return null;
  const t = tone(usage.pct);
  if (t === "ok") return null;
  const crit = t === "crit";
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-center gap-2 border-t px-4 py-1.5 text-[11.5px]",
        crit ? "border-[#ff5c7a]/30 bg-[#ff5c7a]/[0.09] text-[#ffb3ae]" : "border-warning/25 bg-warning/[0.07] text-warning"
      )}
    >
      <span>
        {crit ? "This conversation is nearly full" : "This conversation is getting long"} — {usage.pct}% of the{" "}
        {usage.windowTokens ? fmtTokens(usage.windowTokens) : ""} window.
      </span>
      {usage.compact.available && usage.compact.worthwhile ? (
        <button type="button" onClick={onCompact} className="rounded-md bg-white/10 px-2 py-0.5 font-medium transition-colors hover:bg-white/20">
          Compact
        </button>
      ) : (
        <span className="text-ink-3">Start a new chat to reset it.</span>
      )}
    </div>
  );
}
