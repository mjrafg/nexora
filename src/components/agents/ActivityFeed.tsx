"use client";

import { useCallback, useState } from "react";
import {
  TerminalSquare, FileEdit, Loader2, Sparkles, Activity, Brain, ChevronRight, ChevronDown, Plug,
  Globe, MousePointerClick, Keyboard, MoveVertical, Clock, Camera, Scan, SquareTerminal, ListTree, Braces, Search, AppWindow, Download, Upload, BookOpen, Power, RefreshCw, ShieldCheck, ShieldAlert, MessageSquare,
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
  note: MessageSquare,
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
  note: "",
};

/** Per-action icons for browser rows (ported from Tandem's timeline). */
const BROWSER_ICONS: Record<string, typeof Globe> = {
  navigate: Globe, back: Globe, forward: Globe, reload: RefreshCw, state: ListTree,
  click: MousePointerClick, type: Keyboard, select: Keyboard, press: Keyboard, upload: Upload,
  scroll: MoveVertical, wait: Clock, screenshot: Camera, resize: Scan, read: BookOpen,
  console: SquareTerminal, snapshot: ListTree, evaluate: Braces, search: Search, tabs: AppWindow, downloads: Download,
  reset: Power, kill: Power, crash: Power,
};

/** Each hat gets a colour, so a mixed project stream stays readable. */
const ROLE_TINT: Record<string, string> = { Director: "#6d7cff", Builder: "#3dd68c", Reviewer: "#f5b942" };

function duration(ms?: number): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/* ---------------------------------------------------------------- grouping

   A build can emit thousands of steps. Read one by one they are noise; the
   shape of the work only appears when a run of the same kind of step collapses
   into one line — "Read 14 files", "Ran 6 commands" — that opens on demand.
   Only consecutive steps of the same kind, by the same actor, in the same turn
   are ever folded together, so nothing is grouped that did not happen together.
*/

const GROUPABLE = new Set<ActivityKind>(["command", "file", "tool", "browser"]);
// "note" is deliberately absent: the narration is what makes a run readable,
// so it is never folded away into a count.
/** What a folded run of each kind is called. */
const GROUP_VERB: Partial<Record<ActivityKind, string>> = { command: "command", file: "file step", tool: "tool call", browser: "browser step" };

/** Reading a file is not changing it — and saying so about a read-only
 *  Reviewer implies it wrote to the repository, which it cannot. */
const WRITES = /^(write|edit|multiedit|notebookedit|checkpoint|create|delete|move|rename)/i;
function fileNoun(events: ActivityEvent[]): string {
  const wrote = events.filter((e) => WRITES.test(e.title)).length;
  if (wrote === 0) return "file read";
  if (wrote === events.length) return "file change";
  return "file step";
}

type Item =
  | { key: string; kind: "one"; e: ActivityEvent }
  | { key: string; kind: "many"; of: ActivityKind; events: ActivityEvent[] };

function group(events: ActivityEvent[]): Item[] {
  const items: Item[] = [];
  for (const e of events) {
    const last = items[items.length - 1];
    const sameRun =
      last?.kind === "many" &&
      last.of === e.kind &&
      last.events[0].turnId === e.turnId &&
      last.events[0].actor?.agentId === e.actor?.agentId;
    if (GROUPABLE.has(e.kind) && sameRun) { (last as Extract<Item, { kind: "many" }>).events.push(e); continue; }
    if (GROUPABLE.has(e.kind)) { items.push({ key: e.id, kind: "many", of: e.kind, events: [e] }); continue; }
    items.push({ key: e.id, kind: "one", e });
  }
  return items;
}

/** A live (or persisted) log of what the agent did this turn. */
export function ActivityFeed({ events, live, grouped }: { events: ActivityEvent[]; live?: boolean; grouped?: boolean }) {
  /*
   * What the reader has opened is held HERE, not in each row.
   *
   * While work is running, steps stream in and a row that was standing alone
   * becomes the head of a group — a different component at the same position.
   * React tears the old one down, and anything it was holding goes with it, so
   * a panel the reader had just expanded would snap shut under them. Keeping
   * the open set in the list means a remount costs nothing.
   */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  if (events.length === 0) return null;
  const items = grouped ? group(events) : events.map((e) => ({ key: e.id, kind: "one" as const, e }));
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-black/20">
      {items.map((item, i) =>
        item.kind === "many" && item.events.length > 1
          // the prefix keeps a group and a lone row from sharing a key: they are
          // different rows, and React should be told so plainly
          ? <GroupRow key={`g:${item.key}`} id={`g:${item.key}`} of={item.of} events={item.events} live={live} first={i === 0} open={open.has(`g:${item.key}`)} onToggle={toggle} isOpen={(x) => open.has(x)} />
          : <ActivityRow key={`r:${item.key}`} id={`r:${item.key}`} e={item.kind === "many" ? item.events[0] : item.e} live={live} first={i === 0} open={open.has(`r:${item.key}`)} onToggle={toggle} />
      )}
    </div>
  );
}

/** One line standing for several consecutive steps of the same kind. */
function GroupRow({ of, events, live, first, open, onToggle, isOpen, id }: { of: ActivityKind; events: ActivityEvent[]; live?: boolean; first: boolean; open: boolean; onToggle: (id: string) => void; isOpen: (id: string) => boolean; id: string }) {
  const Icon = ICONS[of] ?? Activity;
  const failed = events.filter((e) => e.status === "failed").length;
  const running = events.some((e) => e.status === "running");
  const total = events.reduce((n, e) => n + (e.durationMs ?? 0), 0);
  const noun = of === "file" ? fileNoun(events) : GROUP_VERB[of] ?? "step";
  const actor = events[0].actor;
  return (
    <div className={cn(!first && "border-t border-line/70", failed > 0 && "bg-danger/[0.07]")}>
      <button type="button" onClick={() => onToggle(id)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-white/[0.04]">
        {open ? <ChevronDown className="h-3 w-3 shrink-0 text-ink-3" /> : <ChevronRight className="h-3 w-3 shrink-0 text-ink-3" />}
        <Icon className="h-3.5 w-3.5 shrink-0 text-ink-3" strokeWidth={1.8} />
        {actor && (
          <span className="shrink-0 rounded-md border px-1.5 py-px text-[10px] font-medium"
            style={{ borderColor: `${ROLE_TINT[actor.role] ?? "#aab2c5"}55`, color: ROLE_TINT[actor.role] ?? "#aab2c5" }}>
            {actor.name}
          </span>
        )}
        <span className="shrink-0 text-ink">{events.length} {noun}{events.length === 1 ? "" : "s"}</span>
        <span className="truncate font-mono text-[11px] text-ink-3" title={events.map((e) => subject(e) || e.title).join("\n")}>
          {events.map((e) => subject(e) || e.title).filter(Boolean).slice(0, 3).join(" · ")}
        </span>
        {failed > 0 && <span className="shrink-0 text-[11px] text-[#ff7d95]">{failed} failed</span>}
        {running && live && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ceo" />}
        <span className="ml-auto shrink-0 num text-[11px] text-ink-3">{duration(total)}</span>
      </button>
      {open && (
        <div className="border-t border-line/70 bg-black/20">
          {/* the steps inside an open group keep their own expansion in the
              same list-level set, so they survive a remount too */}
          {events.map((e, i) => <ActivityRow key={e.id} id={e.id} e={e} live={live} first={i === 0} open={isOpen(e.id)} onToggle={onToggle} />)}
        </div>
      )}
    </div>
  );
}

/** The thing a step acted on — the command, the path — shown beside the verb.
 *  Without it a timeline reads "Bash · Bash · Bash" and says nothing. */
function subject(e: ActivityEvent): string {
  if (e.kind === "model" || e.kind === "browser" || e.kind === "note") return "";
  const d = (e.detail ?? "").trim();
  if (!d || d.startsWith("{")) return "";
  return d.split("\n")[0].slice(0, 120);
}

/** What the agent said, in its own words, between the things it did. */
function NoteRow({ e, first, open, onToggle, id }: { e: ActivityEvent; first: boolean; open: boolean; onToggle: (id: string) => void; id: string }) {
  const long = e.title.length > 240;
  return (
    <div className={cn(!first && "border-t border-line/70", "px-2.5 py-2")}>
      <div className="flex items-start gap-2">
        {e.actor && (
          <span className="mt-px shrink-0 rounded-md border px-1.5 py-px text-[10px] font-medium"
            style={{ borderColor: `${ROLE_TINT[e.actor.role] ?? "#aab2c5"}55`, color: ROLE_TINT[e.actor.role] ?? "#aab2c5" }}>
            {e.actor.name}
          </span>
        )}
        <p className={cn("min-w-0 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2", !open && long && "line-clamp-3")}>{e.title}</p>
      </div>
      {long && (
        <button type="button" onClick={() => onToggle(id)} className="mt-1 text-[10.5px] text-ink-3 hover:text-ink-2">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function ActivityRow({ e, live, first, open, onToggle, id }: { e: ActivityEvent; live?: boolean; first: boolean; open: boolean; onToggle: (id: string) => void; id: string }) {
  if (e.kind === "note") return <NoteRow e={e} first={first} open={open} onToggle={onToggle} id={id} />;
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
        onClick={() => expandable && onToggle(id)}
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
        {e.actor && (
          <span
            className="shrink-0 rounded-md border px-1.5 py-px text-[10px] font-medium"
            style={{ borderColor: `${ROLE_TINT[e.actor.role] ?? "#aab2c5"}55`, color: ROLE_TINT[e.actor.role] ?? "#aab2c5" }}
            title={`${e.actor.name} — ${e.actor.role}${e.actor.sessionKey ? ` · ${e.actor.sessionKey}` : ""}`}
          >
            {e.actor.name}
          </span>
        )}
        {label && <span className="shrink-0 text-ink-2">{label} ·</span>}
        <span className={cn("shrink-0", e.kind === "model" || e.kind === "browser" ? "text-ink" : "font-mono text-[11.5px] text-ink")}>{e.title}</span>
        {subject(e) && <span className="truncate font-mono text-[11px] text-ink-3" title={subject(e)}>{subject(e)}</span>}
        {dedup && <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-operations/40 bg-operations/10 px-1.5 py-px text-[10px] text-operations"><ShieldCheck className="h-3 w-3" /> Already completed — duplicate prevented</span>}
        {uncertain && <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-1.5 py-px text-[10px] text-warning"><ShieldAlert className="h-3 w-3" /> Outcome uncertain — not repeated</span>}
        {!dedup && !uncertain && g?.class === "FINANCIAL" && <span className="shrink-0 rounded-md border border-warning/40 px-1.5 py-px text-[10px] text-warning">financial</span>}
        {running && live && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ceo" />}
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
