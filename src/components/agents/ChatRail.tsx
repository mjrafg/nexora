"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, MessageSquarePlus, MoreHorizontal, Pencil, Archive, ArchiveRestore, Trash2, OctagonX, AlertTriangle } from "lucide-react";
import { api, errorText, type ChatSummary } from "@/lib/client-api";
import { textDirection } from "@/lib/direction";
import { cn } from "@/lib/utils";

/**
 * The conversations you hold with one agent. A thread is a real boundary:
 * its own transcript, its own provider session, its own context.
 */
export function ChatRail({
  agentId,
  chats,
  activeId,
  loading,
  onSelect,
  onChanged,
  onNew,
}: {
  agentId: string;
  chats: ChatSummary[];
  activeId: string | null;
  loading: boolean;
  onSelect: (chatId: string) => void;
  onChanged: () => void;
  onNew: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = chats.filter((c) => (showArchived ? true : !c.archivedAt));
  const archivedCount = chats.filter((c) => c.archivedAt).length;

  // The card hugs its list and grows only as far as the column allows before it
  // scrolls: a half-empty full-height panel reads as a stray border beside the chat.
  return (
    <aside className="glass flex max-h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">Chats</h2>
        <button
          type="button"
          onClick={onNew}
          title="Start a new chat"
          className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:border-brand/50 hover:text-ink"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" /> New
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {loading && !chats.length && (
          <div className="flex items-center gap-2 px-2 py-3 text-[11.5px] text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
        )}
        {!loading && !visible.length && (
          <p className="px-2 py-3 text-[11.5px] leading-relaxed text-ink-3">No conversations yet. Start one and it appears here.</p>
        )}
        {visible.map((c) => (
          <ChatRow
            key={c.id}
            agentId={agentId}
            chat={c}
            active={c.id === activeId}
            onSelect={() => onSelect(c.id)}
            onChanged={onChanged}
            onError={setError}
          />
        ))}
      </div>

      {error && <p className="border-t border-line px-3 py-2 text-[11px] text-[#ff8ea3]">{error}</p>}
      {archivedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          className="border-t border-line px-3 py-2 text-start text-[11px] text-ink-3 transition-colors hover:text-ink"
        >
          {showArchived ? "Hide" : "Show"} {archivedCount} archived
        </button>
      )}
    </aside>
  );
}

function ChatRow({
  agentId,
  chat,
  active,
  onSelect,
  onChanged,
  onError,
}: {
  agentId: string;
  chat: ChatSummary;
  active: boolean;
  onSelect: () => void;
  onChanged: () => void;
  onError: (m: string | null) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setMenu(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    onError(null);
    try { await fn(); onChanged(); } catch (e) { onError(errorText(e)); } finally { setBusy(false); setMenu(false); }
  }

  if (editing) {
    return (
      <form
        className="flex items-center gap-1 rounded-xl border border-brand/50 bg-white/[0.04] px-2 py-1.5"
        onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.updateChat(agentId, chat.id, { title }); setEditing(false); }); }}
      >
        <input
          value={title}
          autoFocus
          dir="auto"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { setEditing(false); setTitle(chat.title); } }}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none"
        />
        <button type="submit" className="text-ink-3 hover:text-ink" title="Save"><Check className="h-3.5 w-3.5" /></button>
      </form>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "w-full rounded-xl border px-2.5 py-2 text-start transition-colors",
          active ? "border-brand/50 bg-brand/[0.12]" : "border-transparent hover:border-line hover:bg-white/[0.04]",
          chat.archivedAt && "opacity-60"
        )}
      >
        <div className="flex items-center gap-1.5">
          <span dir={textDirection(chat.title)} className={cn("min-w-0 flex-1 truncate text-[12.5px]", active ? "font-medium text-ink" : "text-ink-2")}>
            {chat.title}
          </span>
          {chat.lastStopped && <OctagonX className="h-3 w-3 shrink-0 text-warning" />}
          {chat.lastFailed && <AlertTriangle className="h-3 w-3 shrink-0 text-[#ff7d95]" />}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-3">
          <span className="num">{chat.messageCount}</span>
          <span>message{chat.messageCount === 1 ? "" : "s"}</span>
          {chat.lastMessageAt && <span>· {when(chat.lastMessageAt)}</span>}
        </div>
      </button>
      <button
        type="button"
        onClick={() => setMenu((m) => !m)}
        className="absolute end-1 top-1.5 grid h-6 w-6 place-items-center rounded-md text-ink-3 opacity-50 transition-opacity hover:bg-white/10 hover:text-ink hover:opacity-100 focus:opacity-100 data-[open=true]:opacity-100"
        data-open={menu}
        aria-label="Chat actions"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-3.5 w-3.5" />}
      </button>
      {menu && (
        <div className="absolute end-1 top-8 z-30 w-[170px] overflow-hidden rounded-xl border border-line-2 bg-[#141824] py-1 shadow-2xl shadow-black/50">
          <MenuItem icon={Pencil} label="Rename" onClick={() => { setMenu(false); setEditing(true); }} />
          <MenuItem
            icon={chat.archivedAt ? ArchiveRestore : Archive}
            label={chat.archivedAt ? "Unarchive" : "Archive"}
            onClick={() => void act(() => api.updateChat(agentId, chat.id, { archived: !chat.archivedAt }))}
          />
          <MenuItem
            icon={Trash2}
            label="Delete"
            danger
            onClick={() => {
              if (!window.confirm(`Delete "${chat.title}" and its transcript? Export it first if you need the log.`)) return;
              void act(() => api.deleteChat(agentId, chat.id));
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof Pencil; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-[12px] transition-colors hover:bg-white/[0.06]", danger ? "text-[#ff8ea3]" : "text-ink-2 hover:text-ink")}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function when(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}
