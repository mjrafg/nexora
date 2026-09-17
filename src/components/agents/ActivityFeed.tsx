"use client";

import { useState } from "react";
import {
  TerminalSquare, FileEdit, Loader2, Sparkles, Activity, Brain, ChevronRight, ChevronDown, Plug,
  Globe, MousePointerClick, Keyboard, MoveVertical, Clock, Camera, Scan, SquareTerminal, ListTree, Braces, Search, AppWindow, Download, Upload, BookOpen, Power, RefreshCw, ShieldCheck, ShieldAlert,
} from "lucide-react";
import type { ActivityEvent, ActivityKind, BrowserActionMeta } from "@/lib/activity";
import { cn } from "@/lib/utils";

const ICONS: Record<ActivityKind, typeof Activity> = {
  command: TerminalSquare,
  file: FileEdit,
  tool: Plug,
  reasoning: Brain,
  result: Activity,
  status: Activity,
  model: Sparkles,
  browser: Globe,
};

/** The "Tool ·", "Shell ·", "Asked Claude" prefix, mirroring a build log. */
const LABELS: Record<ActivityKind, string> = {
  command: "Shell",
  file: "File",
  tool: "Tool",
  reasoning: "Thinking",
  result: "Result",
  status: "Status",
  model: "",
  browser: "Browser",
};

/** Per-action icons for browser rows (ported from Tandem's timeline). */
const BROWSER_ICONS: Record<string, typeof Globe> = {
  navigate: Globe, back: Globe, forward: Globe, reload: RefreshCw, state: ListTree,
  click: MousePointerClick, type: Keyboard, select: Keyboard, press: Keyboard, upload: Upload,
  scroll: MoveVertical, wait: Clock, screenshot: Camera, resize: Scan, read: BookOpen,
  console: SquareTerminal, snapshot: ListTree, evaluate: Braces, search: Search, tabs: AppWindow, downloads: Download,
  reset: Power, kill: Power, crash: Power,
};

function duration(ms?: number): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** A live (or persisted) log of what the agent did this turn. */
export function ActivityFeed({ events, live }: { events: ActivityEvent[]; live?: boolean }) {
  if (events.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-black/20">
      {events.map((e, i) => (
        <ActivityRow key={e.id} e={e} live={live} first={i === 0} />
      ))}
    </div>
  );
}

function ActivityRow({ e, live, first }: { e: ActivityEvent; live?: boolean; first: boolean }) {
  const [open, setOpen] = useState(false);
  const b = e.browser;
  const Icon = e.kind === "browser" ? BROWSER_ICONS[b?.action ?? ""] ?? Globe : ICONS[e.kind] ?? Activity;
  const label = LABELS[e.kind] ?? "";
  const running = e.status === "running";
  const failed = e.status === "failed";
  const g = e.guard;
  const dedup = g?.outcome === "deduplicated" || g?.outcome === "in_flight_reused";
  const uncertain = g?.outcome === "uncertain_blocked" || g?.status === "UNCERTAIN";
  const expandable = !!(e.detail || e.output || b?.screenshotUrl || b?.console?.length || b?.error || dedup || uncertain);

  return (
    <div className={cn(!first && "border-t border-line/70", failed && "bg-danger/[0.07]")}>
      <button
        type="button"
        onClick={() => expandable && setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors",
          expandable ? "hover:bg-white/[0.04]" : "cursor-default"
        )}
      >
        {expandable ? (
          open ? <ChevronDown className="h-3 w-3 shrink-0 text-ink-3" /> : <ChevronRight className="h-3 w-3 shrink-0 text-ink-3" />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <Icon className={cn("h-3.5 w-3.5 shrink-0", failed ? "text-[#ff7d95]" : e.kind === "model" ? "text-ceo" : e.kind === "browser" ? "text-support" : "text-ink-3")} strokeWidth={1.8} />
        {label && <span className="shrink-0 text-ink-2">{label} ·</span>}
        <span className={cn("truncate", e.kind === "model" || e.kind === "browser" ? "text-ink" : "font-mono text-[11.5px] text-ink")}>{e.title}</span>
        {dedup && <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-operations/40 bg-operations/10 px-1.5 py-px text-[10px] text-operations"><ShieldCheck className="h-3 w-3" /> Already completed — duplicate prevented</span>}
        {uncertain && <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-1.5 py-px text-[10px] text-warning"><ShieldAlert className="h-3 w-3" /> Outcome uncertain — not repeated</span>}
        {!dedup && !uncertain && g?.class === "FINANCIAL" && <span className="shrink-0 rounded-md border border-warning/40 px-1.5 py-px text-[10px] text-warning">financial</span>}
        {running && live && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ceo pulse-ring" />}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-ink-3">
          {e.kind === "browser" && b?.url ? <span className="hidden max-w-[220px] truncate font-mono text-[10.5px] sm:inline" title={b.title}>{b.url}</span> : e.meta && <span className="max-w-[160px] truncate">{e.meta}</span>}
          {running ? (
            <Loader2 className="h-3 w-3 animate-spin text-ink-3" />
          ) : (
            <span className={cn("num", failed && "text-[#ff7d95]")}>{failed ? "failed" : duration(e.durationMs)}</span>
          )}
        </span>
      </button>
      {open && expandable && (
        <div className="space-y-1.5 border-t border-line/70 bg-black/20 px-3 py-2">
          {g && (dedup || uncertain) && (
            <div className="rounded-md border border-line px-2 py-1.5 text-[11px] text-ink-2">
              <div className="text-[9.5px] uppercase tracking-wide text-ink-3">Side-effect guard</div>
              <div>{dedup ? "This exact action already completed in the current work scope; the original result was returned." : "An earlier attempt has an unknown external outcome; the action was not repeated."}</div>
              <div className="mt-0.5 font-mono text-[10.5px] text-ink-3">
                {g.originalAt && <>original {new Date(g.originalAt).toLocaleString()} · </>}
                {g.originalAgentId && <>by {g.originalAgentId} · </>}
                {g.executionId && <>execution {g.executionId.slice(0, 8)}</>}
                {g.externalReference && <> · {g.externalReference}</>}
              </div>
            </div>
          )}
          {b && <BrowserDetail b={b} />}
          {e.detail && e.kind !== "browser" && (
            <div>
              <div className="text-[9.5px] uppercase tracking-wide text-ink-3">Input</div>
              <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10.5px] leading-relaxed text-ink-2">{e.detail}</pre>
            </div>
          )}
          {e.output && (
            <div>
              <div className="text-[9.5px] uppercase tracking-wide text-ink-3">Output</div>
              <pre className="mt-0.5 max-h-52 overflow-auto whitespace-pre-wrap break-words text-[10.5px] leading-relaxed text-ink-2">{e.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Sanitized browser facts: URL, viewport, entered value (already redacted), console, screenshot. */
function BrowserDetail({ b }: { b: BrowserActionMeta }) {
  return (
    <div className="space-y-1">
      {(b.url || b.viewport) && (
        <div className="flex flex-wrap items-baseline gap-x-3 text-[11px] text-ink-3">
          {b.url && <span className="min-w-0 max-w-full truncate font-mono" title={b.title}>{b.url}</span>}
          {b.viewport && <span className="shrink-0 num">{b.viewport.width}×{b.viewport.height}{b.viewport.deviceScaleFactor && b.viewport.deviceScaleFactor !== 1 ? ` @${b.viewport.deviceScaleFactor}x` : ""}</span>}
        </div>
      )}
      {b.value && <div className="font-mono text-[11px] text-ink-2">↳ {b.value}</div>}
      {b.error && <div className="text-[11.5px] text-[#ffb3ae]">{b.error}</div>}
      {b.console && b.console.length > 0 && (
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-[#0e1013] px-2 py-1.5 font-mono text-[10.5px] leading-[1.55] text-[#c3c9d4]">
          {b.console.map((c, i) => (
            <span key={i} className={c.level === "error" ? "text-[#ff9a94]" : c.level === "warning" ? "text-warning" : ""}>[{c.level}] {c.text}{"\n"}</span>
          ))}
        </pre>
      )}
      {b.screenshotUrl && (
        <a href={b.screenshotUrl} target="_blank" rel="noreferrer" className="block" title="Open full size">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={b.screenshotUrl} alt={b.title ?? "screenshot"} loading="lazy" className="max-h-[260px] max-w-full rounded-lg border border-line transition-opacity hover:opacity-90" />
        </a>
      )}
    </div>
  );
}
