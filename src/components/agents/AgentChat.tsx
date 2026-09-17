"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Loader2, AlertTriangle, Wrench, ChevronDown, ChevronRight, CheckCircle2, XCircle, Sparkles, Hourglass, Lightbulb, Square, ScrollText, OctagonX } from "lucide-react";
import { AgentAvatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { api, errorText, type ActivityEvent, type AgentAssumption, type ChatContextUsage } from "@/lib/client-api";
import { ActivityFeed } from "./ActivityFeed";
import { ContextBanner, ContextMeter, fmtTokens } from "./ContextMeter";
import { CompactDialog } from "./CompactDialog";
import { ExportMenu } from "./ExportMenu";
import { Markdown } from "@/components/ui/Markdown";
import { textDirection } from "@/lib/direction";
import type { AgentView, ChatMessage } from "@/lib/runtime/types";
import { RUNTIMES, PROVIDERS, modelLabel } from "@/lib/runtime/catalog";
import { RUNTIME_COLORS } from "./RuntimeBadge";
import { cn } from "@/lib/utils";

/* The ledger the owner has already read, remembered per conversation in this browser. */
const DISMISSED_KEY = (chatId: string) => `nexora.assumptions.read.${chatId}`;

function readDismissed(chatId: string): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY(chatId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set(); // private window, blocked storage — the ledger just shows again
  }
}

function writeDismissed(chatId: string, ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY(chatId), JSON.stringify([...ids].slice(-200)));
  } catch {
    /* nothing to remember it with; the ledger reappears next time */
  }
}

export function AgentChat({
  agent,
  chatId,
  chatTitle,
  onBusyChange,
  onAgentChanged,
  onChatChanged,
  onToggleLogs,
  logsOpen,
}: {
  agent: AgentView;
  chatId: string;
  chatTitle: string;
  onBusyChange?: (busy: boolean) => void;
  onAgentChanged?: () => void;
  onChatChanged?: () => void;
  onToggleLogs?: () => void;
  logsOpen?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [usage, setUsage] = useState<ChatContextUsage | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveActivity, setLiveActivity] = useState<ActivityEvent[]>([]);
  const [assumptions, setAssumptions] = useState<AgentAssumption[]>([]);
  // Hiding the ledger sticks: the same assumptions never come back, only new ones do.
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed(chatId));
  const [compacting, setCompacting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => {
    return Promise.all([
      api.messages(agent.id, chatId).then((r) => { setMessages(r.messages); setUsage(r.usage); }),
      api.agentAssumptionsForChat(agent.id, chatId).then((r) => setAssumptions(r.assumptions)).catch(() => undefined),
    ]);
  }, [agent.id, chatId]);

  useEffect(() => {
    let alive = true;
    api.messages(agent.id, chatId).then((r) => { if (alive) { setMessages(r.messages); setUsage(r.usage); } }).catch((e) => alive && setError(errorText(e)));
    api.agentAssumptionsForChat(agent.id, chatId).then((r) => alive && setAssumptions(r.assumptions)).catch(() => undefined);
    return () => { alive = false; };
  }, [agent.id, chatId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages?.length, sending, liveActivity.length]);

  // Live activity (tools and commands as they run). A finished "model" event
  // means a turn ended — including turns Nexora started itself (auto-resume) —
  // so the transcript is reloaded then.
  useEffect(() => {
    const es = new EventSource(`/api/agents/${agent.id}/activity`);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as ActivityEvent;
        setLiveActivity((cur) => {
          const i = cur.findIndex((x) => x.id === ev.id);
          if (i >= 0) { const next = cur.slice(); next[i] = ev; return next; }
          return [...cur, ev];
        });
        if (ev.kind === "model" && ev.status && ev.status !== "running") {
          setTimeout(() => {
            void reload().then(() => setLiveActivity([]));
            onAgentChanged?.();
            onChatChanged?.();
          }, 300);
        }
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, [agent.id, reload, onAgentChanged, onChatChanged]);

  const systemWorking = !sending && liveActivity.some((e) => e.status === "running");
  const working = sending || systemWorking;
  useEffect(() => { onBusyChange?.(working); }, [working, onBusyChange]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    setSending(true);
    setStopping(false);
    setError(null);
    const optimistic: ChatMessage = { id: `tmp-${Date.now()}`, agentId: agent.id, chatId, role: "user", content: text, createdAt: new Date().toISOString() };
    setMessages((m) => [...(m ?? []), optimistic]);
    try {
      const r = await api.send(agent.id, text, chatId);
      setMessages((m) => [...(m ?? []).filter((x) => x.id !== optimistic.id), r.user, r.assistant]);
      setUsage(r.usage);
      setLiveActivity([]);
      onChatChanged?.();
      // what the agent decided on its own during this task — collected, not narrated
      api.agentAssumptionsForChat(agent.id, chatId).then((x) => setAssumptions(x.assumptions)).catch(() => undefined);
    } catch (e) {
      setError(errorText(e));
      setMessages((m) => (m ?? []).filter((x) => x.id !== optimistic.id));
      setDraft(text);
    } finally {
      setSending(false);
      setStopping(false);
    }
  }

  /** Stop the running turn. The turn ends as stopped — nothing is lost. */
  async function stop() {
    setStopping(true);
    try {
      await api.stopAgent(agent.id);
      // a turn Nexora started itself has no promise here to settle it
      if (!sending) setTimeout(() => void reload().then(() => { setLiveActivity([]); setStopping(false); }), 800);
    } catch (e) {
      setError(errorText(e));
      setStopping(false);
    }
  }

  // what the owner has not dismissed yet — a new assumption reopens the ledger
  const unread = assumptions.filter((a) => !dismissed.has(a.id));

  function dismissAssumptions() {
    const next = new Set(dismissed);
    for (const a of assumptions) next.add(a.id);
    setDismissed(next);
    writeDismissed(chatId, next);
  }

  const rt = agent.runtime.runtimeType;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Thread strip: what runs this conversation, how full it is, how to take it with you */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: RUNTIME_COLORS[rt] }} />
        <div className="min-w-0 flex-1">
          <div dir="auto" className="truncate text-[12px] font-medium text-ink">{chatTitle}</div>
          <div className="truncate text-[10.5px] text-ink-3">
            {RUNTIMES[rt].label} · {PROVIDERS[agent.connection.providerType].label} · {modelLabel(agent.connection.providerType, rt, agent.runtime.model)}
          </div>
        </div>
        <ContextMeter usage={usage} onCompact={() => setCompacting(true)} />
        <button
          type="button"
          onClick={onToggleLogs}
          title="Every log entry for this chat"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition-colors",
            logsOpen ? "border-brand/50 bg-brand/[0.12] text-ink" : "border-line text-ink-2 hover:border-line-2 hover:text-ink"
          )}
        >
          <ScrollText className="h-3.5 w-3.5" /> Logs
        </button>
        <ExportMenu agentId={agent.id} chatId={chatId} />
      </div>

      {/* Transcript — the only scrollable area of the workspace */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages === null && !error && (
          <div className="flex items-center gap-2 text-[12px] text-ink-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading conversation…
          </div>
        )}
        {messages?.length === 0 && (
          <div className="rounded-xl border border-dashed border-line-2 p-6 text-center text-[12.5px] text-ink-3">
            Start a private conversation with {agent.name}. Each reply executes through the runtime above, and everything it does is logged here.
          </div>
        )}
        {messages?.map((m) => <Bubble key={m.id} m={m} agent={agent} />)}
        {agent.waiting && !working && (
          <div className="flex justify-center">
            <div className="inline-flex max-w-[92%] flex-wrap items-center justify-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-center text-[11px] text-warning">
              <Hourglass className="h-3 w-3" /> {agent.waiting.headline}: {agent.waiting.label} — {agent.waiting.action}.{" "}
              <Link href={agent.waiting.href} className="underline underline-offset-2 hover:text-ink">Open {agent.waiting.surface}</Link>
              {" "}· {agent.name} resumes automatically.
            </div>
          </div>
        )}
        {working && (
          <div className="flex items-start gap-2.5">
            <AgentAvatar id={agent.id} dept={agent.dept} name={agent.name} size={26} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="inline-flex items-center gap-2 rounded-2xl rounded-tl-sm border border-line bg-white/[0.04] px-3 py-2 text-[12px] text-ink-3">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {stopping ? `Stopping ${agent.name}…` : `${agent.name} is working via ${RUNTIMES[rt].label}…`}
              </div>
              {liveActivity.length > 0 && <ActivityFeed events={liveActivity.filter((e) => e.kind !== "status")} live />}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-[#ff8ea3]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span className="break-words">{error}</span>
        </div>
      )}

      {/* What the agent decided on its own during this task */}
      {unread.length > 0 && !working && (
        <div className="shrink-0 border-t border-line bg-white/[0.02] px-4 py-2.5">
          <div className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">
            <Lightbulb className="h-3 w-3" />
            <span title={`Choices ${agent.name} made alone instead of interrupting you. Correct any of them by saying so.`}>
              Assumptions {agent.name} made · {unread.length}
            </span>
            <button
              type="button"
              onClick={dismissAssumptions}
              title="Hide these. They stay hidden; only new assumptions appear here again."
              className="ms-auto text-[10.5px] font-normal normal-case tracking-normal text-ink-3 hover:text-ink"
            >
              Hide
            </button>
          </div>
          <ul className="space-y-1">
            {unread.slice(-5).map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 text-[11.5px] text-ink-2">
                <span dir="auto">{a.summary}</span>
                {a.detail && <span className="text-ink-3">— {a.detail}</span>}
                {a.customDataKey && <Link href="/company" className="font-mono text-[10.5px] text-brand hover:text-ink">{a.customDataKey}</Link>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ContextBanner usage={usage} onCompact={() => setCompacting(true)} />

      {/* Composer — Send while idle, Stop while a turn is running */}
      <form
        className="flex shrink-0 items-end gap-2 border-t border-line p-3"
        onSubmit={(e) => { e.preventDefault(); void send(); }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!working) void send();
            }
          }}
          rows={2}
          dir="auto"
          placeholder={working ? `${agent.name} is working — press Stop to interrupt` : `Message ${agent.name}… (Enter to send, Shift+Enter for a new line)`}
          className="min-h-[44px] flex-1 resize-none rounded-xl border border-line bg-white/[0.04] px-3 py-2 text-[13px] outline-none placeholder:text-ink-3 focus:border-brand/60"
          disabled={working}
        />
        {working ? (
          <Button type="button" variant="danger" size="md" onClick={() => void stop()} disabled={stopping} title="Stop this turn">
            {stopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />}
            <span className="hidden sm:inline">Stop</span>
          </Button>
        ) : (
          <Button type="submit" variant="primary" size="md" disabled={!draft.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        )}
      </form>

      <CompactDialog
        agentId={agent.id}
        chatId={chatId}
        agentName={agent.name}
        usage={usage}
        open={compacting}
        onClose={() => setCompacting(false)}
        onDone={() => { void reload(); }}
      />
    </div>
  );
}

function Bubble({ m, agent }: { m: ChatMessage; agent: AgentView }) {
  const mine = m.role === "user";
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (mine && m.origin === "system") {
    // Nexora itself spoke (auto-resume after a capability was granted, manager wake-ups)
    return (
      <div className="flex justify-center">
        <div className="max-w-[88%] rounded-xl border border-dashed border-support/40 bg-support/[0.06] px-3 py-2 text-[11.5px] leading-relaxed text-ink-2">
          <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-support"><Sparkles className="h-3 w-3" /> Nexora · {time}</div>
          <div dir={textDirection(m.content)} className="whitespace-pre-wrap">{m.content}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={cn("flex items-start gap-2.5", mine && "flex-row-reverse")}>
      {mine ? (
        <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[#f5b942] to-[#ff8a3d] text-[10px] font-semibold text-[#1a1206]">
          AC
        </span>
      ) : (
        <AgentAvatar id={agent.id} dept={agent.dept} name={agent.name} size={26} />
      )}
      <div className={cn("min-w-0", mine ? "max-w-[78%] text-right" : "max-w-[88%]")}>
        <div
          dir={mine || m.error ? textDirection(m.content) : undefined}
          className={cn(
            "break-words rounded-2xl px-3 py-2 text-start text-[13px] leading-relaxed",
            mine
              ? "whitespace-pre-wrap rounded-tr-sm bg-gradient-to-b from-[#6d7cff] to-[#5563e8] text-white"
              : m.error
                ? "whitespace-pre-wrap rounded-tl-sm border border-danger/30 bg-danger/10 text-[#ff8ea3]"
                : m.stopped
                  ? "whitespace-pre-wrap rounded-tl-sm border border-warning/30 bg-warning/[0.07] text-warning"
                  : "rounded-tl-sm border border-line bg-white/[0.04] text-ink-2"
          )}
        >
          {m.stopped && (
            <span className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide">
              <OctagonX className="h-3 w-3" /> Stopped by you
            </span>
          )}
          {mine || m.error || m.stopped ? m.content : <Markdown>{m.content}</Markdown>}
        </div>
        {!mine && m.activity && m.activity.filter((e) => e.kind !== "status").length > 0 && (
          <div className="mt-1.5"><ActivityFeed events={m.activity.filter((e) => e.kind !== "status")} /></div>
        )}
        {!mine && (!m.activity || m.activity.length === 0) && m.toolCalls && m.toolCalls.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {m.toolCalls.map((tc, i) => (
              <ToolCallChip key={i} tc={tc} />
            ))}
          </div>
        )}
        <div className={cn("mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-3", mine && "justify-end")}>
          <span className="num">{time}</span>
          {m.runtime && (
            <>
              <span>·</span>
              <span style={{ color: RUNTIME_COLORS[m.runtime.runtimeType] }}>{RUNTIMES[m.runtime.runtimeType].label}</span>
              <span>· {m.runtime.model}</span>
            </>
          )}
          {m.usage?.durationMs ? <span className="num">· {(m.usage.durationMs / 1000).toFixed(1)}s</span> : null}
          {m.usage?.costUsd ? <span className="num">· ${m.usage.costUsd.toFixed(4)}</span> : null}
          {m.usage?.contextTokens ? <span className="num" title="Session context after this turn, as the runtime reported it">· ctx {fmtTokens(m.usage.contextTokens)}</span> : null}
        </div>
      </div>
    </div>
  );
}

function ToolCallChip({ tc }: { tc: NonNullable<ChatMessage["toolCalls"]>[number] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("rounded-lg border text-[11px]", tc.ok ? "border-line bg-white/[0.03]" : "border-danger/30 bg-danger/10")}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 px-2 py-1 text-left">
        {open ? <ChevronDown className="h-3 w-3 text-ink-3" /> : <ChevronRight className="h-3 w-3 text-ink-3" />}
        <Wrench className="h-3 w-3 text-brand" />
        <span className="text-ink-2">Used tool</span>
        <span className="font-medium text-ink">{tc.server} → {tc.tool}</span>
        {tc.ok ? <CheckCircle2 className="h-3 w-3 text-[#5fe3a3]" /> : <XCircle className="h-3 w-3 text-[#ff7d95]" />}
        {(tc.guard?.outcome === "deduplicated" || tc.guard?.outcome === "in_flight_reused") && <span className="rounded-md border border-operations/40 bg-operations/10 px-1.5 text-[10px] text-operations">Already completed — duplicate prevented</span>}
        {tc.guard?.outcome === "uncertain_blocked" && <span className="rounded-md border border-warning/40 bg-warning/10 px-1.5 text-[10px] text-warning">Outcome uncertain — not repeated</span>}
        <span className="ml-auto num text-[10px] text-ink-3">{(tc.durationMs / 1000).toFixed(2)}s</span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-line px-2 py-1.5">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-3">Input</div>
            <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-1.5 text-[10.5px] text-ink-2">{JSON.stringify(tc.args, null, 2)}</pre>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-3">{tc.ok ? "Result" : "Error"}</div>
            <pre className="mt-0.5 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-1.5 text-[10.5px] text-ink-2">{tc.ok ? tc.result || "(no output)" : tc.error}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The agent's current conversation, for surfaces that show one chat without a
 * chat list (the Capability Manager's own panel). It opens the newest thread,
 * and starts one if the agent has never been spoken to.
 */
export function CurrentAgentChat({ agent }: { agent: AgentView }) {
  const [chat, setChat] = useState<{ id: string; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .chats(agent.id)
      .then(async (r) => {
        const first = r.chats[0] ?? (await api.newChat(agent.id)).chat;
        if (alive) setChat({ id: first.id, title: first.title });
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => { alive = false; };
  }, [agent.id]);

  if (error) return <div className="p-4 text-[12px] text-[#ff8ea3]">{error}</div>;
  if (!chat) return <div className="flex items-center gap-2 p-4 text-[12px] text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading chat…</div>;
  return <AgentChat agent={agent} chatId={chat.id} chatTitle={chat.title} />;
}
