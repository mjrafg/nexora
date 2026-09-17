"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ClipboardList, Hourglass, Loader2, Monitor, PanelLeft, Settings, ChevronRight, Hand } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { AgentAvatar } from "@/components/ui/Avatar";
import { AgentChat } from "@/components/agents/AgentChat";
import { BrowserDock } from "@/components/agents/BrowserDock";
import { ChatRail } from "@/components/agents/ChatRail";
import { LogsPanel } from "@/components/agents/LogsPanel";
import { MyWorkPanel } from "@/components/work/MyWorkPanel";
import { api, errorText, type ChatSummary } from "@/lib/client-api";
import { NARROW_WORKSPACE, useMediaQuery } from "@/lib/use-media-query";
import { useLinkedRequestId } from "@/lib/use-request-focus";
import type { AgentView } from "@/lib/runtime/types";
import { departments } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

/**
 * The agent workspace: a compact header, the conversation, and — when the
 * agent asks for it — its browser docked on the right. Configuration and
 * removing the agent live at /agents/:id/settings; nothing on this page edits
 * or deletes anything, so a mis-click next to the chat cannot destroy it.
 *
 * The page itself never scrolls: only the transcript does.
 */
export default function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const showBrowserParam = useLinkedRequestId("browser") !== null;
  const linkedChat = useLinkedRequestId("chat");
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wantsDock = showBrowserParam;
  const [dockOverride, setDockOverride] = useState<boolean | null>(null);
  const [working, setWorking] = useState(false);
  const [control, setControl] = useState<"agent" | "owner">("agent");
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [chosenChat, setChosenChat] = useState<string | null>(null);
  const [railPref, setRailPref] = useState<boolean | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [showWork, setShowWork] = useState(false);
  // on a narrow window the chat keeps the room: the rail and the logs become
  // overlays, and the rail starts closed
  const narrow = useMediaQuery(NARROW_WORKSPACE);
  const showRail = railPref ?? !narrow;

  const refresh = useCallback(() => api.agent(id).then((a) => { setAgent(a.agent); return a.agent; }).catch((e) => { setError(errorText(e)); return null; }), [id]);
  useEffect(() => { void refresh(); }, [refresh]);

  // the conversations held with this agent; the newest is opened by default
  const loadChats = useCallback(
    () =>
      api
        .chats(id)
        .then((r) => { setChats(r.chats); return r.chats; })
        .catch((e) => { setError(errorText(e)); return [] as ChatSummary[]; })
        .finally(() => setChatsLoading(false)),
    [id]
  );
  useEffect(() => { void loadChats(); }, [loadChats]);
  // whichever thread the owner picked, as long as it still exists; else the newest
  const activeChat =
    (chosenChat && chats.some((c) => c.id === chosenChat) ? chosenChat : null) ??
    (linkedChat && chats.some((c) => c.id === linkedChat) ? linkedChat : null) ??
    chats[0]?.id ?? null;

  async function newChat() {
    try {
      const r = await api.newChat(id);
      await loadChats();
      setChosenChat(r.chat.id);
    } catch (e) {
      setError(errorText(e));
    }
  }

  // the agent can pull the owner in: a handoff (or ?browser=1) opens the dock,
  // and the owner can still close or open it by hand afterwards
  const dock = dockOverride ?? (wantsDock || agent?.waiting?.kind === "browser");

  // keep the header's waiting/working state honest while a turn runs
  useEffect(() => {
    if (!agent) return;
    const t = setInterval(() => { void refresh(); }, working ? 4_000 : 15_000);
    return () => clearInterval(t);
  }, [agent, working, refresh]);

  if (error) {
    return <AppShell><div className="glass rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div></AppShell>;
  }
  if (!agent) {
    return (
      <AppShell>
        <div className="flex items-center gap-2 text-[12.5px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Loading agent…</div>
      </AppShell>
    );
  }

  const dept = departments[agent.dept];
  const waiting = agent.waiting;

  return (
    <AppShell workspace>
      {/* Header — stationary */}
      <header className="mb-3 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        <Link href="/agents" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line text-ink-3 hover:text-ink" title="All agents">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <AgentAvatar id={agent.id} dept={agent.dept} name={agent.name} online={agent.status} size={38} status ring />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[17px] font-semibold tracking-tight">{agent.name}</h1>
            <Badge color={dept.color}>{dept.shortName}</Badge>
            {agent.system === "capability-manager" && <Badge color="#2fd4e6" dot>System agent</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
            <span className="truncate">{agent.role} · {dept.name}</span>
            <StatusChip waiting={waiting} working={working} control={control} onOpenDock={() => setDockOverride(true)} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant={showRail ? "outline" : "ghost"} size="sm" onClick={() => setRailPref(!showRail)} title="Show the list of chats">
            <PanelLeft className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Chats</span>
          </Button>
          <Button variant={showWork ? "outline" : "ghost"} size="sm" onClick={() => setShowWork(!showWork)} title="The work assigned to this agent">
            <ClipboardList className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Work</span>
          </Button>
          <Button variant={dock ? "outline" : "ghost"} size="sm" onClick={() => setDockOverride(!dock)} title="Show this agent's browser">
            <Monitor className="h-3.5 w-3.5" /> Browser
          </Button>
          <Link href={`/agents/${agent.id}/settings`}><Button variant="ghost" size="sm"><Settings className="h-3.5 w-3.5" /> Settings</Button></Link>
        </div>
      </header>

      {/* Workspace — fills the rest; on a wide window every panel takes real
          width and none covers the chat, on a narrow one they slide over it */}
      <div className="relative flex min-h-0 flex-1 gap-3">
        {/* the rail is as tall as its list, never a tall empty box beside the chat */}
        {showRail && (
          <div className={cn("flex min-h-0", narrow ? "absolute inset-y-0 start-0 z-30 w-[min(280px,86%)] rounded-2xl bg-[#0d1119] shadow-2xl shadow-black/60" : "w-[236px] shrink-0 items-start")}>
            <ChatRail
              agentId={agent.id}
              chats={chats}
              activeId={activeChat}
              loading={chatsLoading}
              onSelect={(cid) => { setChosenChat(cid); if (narrow) setRailPref(false); }}
              onChanged={() => void loadChats()}
              onNew={() => { void newChat(); if (narrow) setRailPref(false); }}
            />
          </div>
        )}
        <section className="glass flex min-h-0 min-w-[280px] flex-1 flex-col overflow-hidden rounded-2xl">
          {activeChat ? (
            <AgentChat
              key={activeChat}
              agent={agent}
              chatId={activeChat}
              chatTitle={chats.find((c) => c.id === activeChat)?.title ?? "Conversation"}
              onBusyChange={setWorking}
              onAgentChanged={refresh}
              onChatChanged={() => void loadChats()}
              onToggleLogs={() => setShowLogs((v) => !v)}
              logsOpen={showLogs}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <p className="text-[12.5px] text-ink-3">{chatsLoading ? "Loading conversations…" : `No conversation with ${agent.name} yet.`}</p>
              {!chatsLoading && <Button variant="primary" size="sm" onClick={() => void newChat()}>Start a chat</Button>}
            </div>
          )}
        </section>
        {showWork && (
          <div className={cn("flex min-h-0", narrow ? "absolute inset-y-0 end-0 z-40 w-[min(340px,92%)] rounded-2xl bg-[#0d1119] shadow-2xl shadow-black/60" : "w-[300px] shrink-0 items-start")}>
            <MyWorkPanel agentId={agent.id} agentName={agent.name} onClose={() => setShowWork(false)} />
          </div>
        )}
        {showLogs && activeChat && (
          <div className={cn("flex min-h-0", narrow ? "absolute inset-0 z-40 rounded-2xl bg-[#0d1119] shadow-2xl shadow-black/60" : "w-[420px] shrink-0")}>
            <LogsPanel agentId={agent.id} chatId={activeChat} onClose={() => setShowLogs(false)} />
          </div>
        )}
        {dock && <BrowserDock agent={agent} onClose={() => setDockOverride(false)} onControlChange={setControl} />}
      </div>
    </AppShell>
  );
}

/** One concise status. When something is waiting, it is a link to the thing that unblocks it. */
function StatusChip({ waiting, working, control, onOpenDock }: { waiting: AgentView["waiting"]; working: boolean; control: "agent" | "owner"; onOpenDock: () => void }) {
  if (waiting?.kind === "browser") {
    return (
      <button type="button" onClick={onOpenDock} className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10.5px] font-medium text-warning hover:bg-warning/20">
        <Hand className="h-3 w-3" /> Browser handed to you
        <ChevronRight className="h-3 w-3" />
      </button>
    );
  }
  if (waiting) {
    return (
      <Link href={waiting.href} className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10.5px] font-medium text-warning hover:bg-warning/20" title={`${waiting.action} · ${waiting.surface}`}>
        <Hourglass className="h-3 w-3" /> {waiting.headline}: {waiting.label}
        <ChevronRight className="h-3 w-3" />
      </Link>
    );
  }
  if (control === "owner") return <Badge color="#f5b942" dot>You have the browser</Badge>;
  if (working) return <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand/10 px-2 py-0.5 text-[10.5px] font-medium text-brand")}><Loader2 className="h-3 w-3 animate-spin" /> Working</span>;
  return null;
}
