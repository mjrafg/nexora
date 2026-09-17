"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Hand, Loader2, MousePointer2, RefreshCw, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { api, errorText, type BrowserHandoff } from "@/lib/client-api";
import { cn } from "@/lib/utils";

export type Frame = {
  live: boolean;
  control: "agent" | "owner";
  handoff: BrowserHandoff | null;
  image?: string;
  url?: string | null;
  title?: string | null;
  viewport?: { width: number; height: number };
  error?: string;
};

/**
 * The agent's own browser, rendered same-origin.
 *
 * External sites cannot be framed (CSP and X-Frame-Options), so this is not an
 * iframe of the site: it streams frames of the session the agent is already
 * driving and forwards the owner's input back into it. Mounting, unmounting,
 * resizing or reopening it never touches the session — no new context, no lost
 * cookies, tabs or form state.
 */
export function BrowserLiveView({
  agentId,
  agentName,
  onControlChange,
  onReturned,
  className,
  compact,
}: {
  agentId: string;
  agentName: string;
  onControlChange?: (control: "agent" | "owner") => void;
  onReturned?: () => void;
  className?: string;
  compact?: boolean;
}) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const buffer = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const f = await api.agentBrowser(agentId);
      setFrame(f);
      setError(null);
      onControlChange?.(f.control);
    } catch (e) {
      setError(errorText(e));
    }
  }, [agentId, onControlChange]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (!alive) return;
      await poll();
      if (!alive) return;
      timer = setTimeout(loop, document.hidden ? 4_000 : 1_200);
    };
    void loop();
    return () => { alive = false; clearTimeout(timer); };
  }, [poll]);

  const mine = (frame?.control ?? "agent") === "owner";

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await api.agentBrowserAction(agentId, body);
      await poll();
      if (body.action === "return" || body.action === "cancel") onReturned?.();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  /* ----------------------------------------------------------------
     Real keyboard input.

     The page is a stream of frames, not an embedded document, so key
     presses would otherwise go to Nexora instead of the agent's browser.
     While the owner holds control and the stage has focus we capture
     them: printable characters are buffered and sent as one string after
     a short pause (so a typed address is one round trip), and everything
     else — Enter, Tab, Backspace, arrows, shortcuts — is sent as a key
     press to the same session.
     ---------------------------------------------------------------- */

  const send = useCallback(async (body: Record<string, unknown>) => {
    try { await api.agentBrowserAction(agentId, body); } catch (e) { setError(errorText(e)); }
  }, [agentId]);

  const flush = useCallback(async () => {
    const text = buffer.current;
    buffer.current = "";
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    if (!text) return;
    setTyping(true);
    await send({ action: "type", text });
    setTyping(false);
    void poll();
  }, [send, poll]);

  const queue = useCallback((chunk: string) => {
    buffer.current += chunk;
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => void flush(), 180);
  }, [flush]);

  async function onKeyDown(e: React.KeyboardEvent) {
    if (!mine) return;
    const { key, ctrlKey, metaKey, altKey, shiftKey } = e;
    // let the browser's own find/reload/devtools shortcuts through
    if ((ctrlKey || metaKey) && ["r", "R", "f", "F", "i", "I", "t", "T", "w", "W"].includes(key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (key.length === 1 && !ctrlKey && !metaKey && !altKey) { queue(key); return; }
    await flush();
    const named: Record<string, string> = { Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Escape: "Escape", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown" };
    const base = named[key] ?? (key.length === 1 ? key.toUpperCase() : "");
    if (!base) return;
    const combo = `${ctrlKey ? "Control+" : ""}${metaKey ? "Meta+" : ""}${altKey ? "Alt+" : ""}${shiftKey && base.length > 1 ? "Shift+" : ""}${base}`;
    await send({ action: "key", key: combo });
    void poll();
  }

  async function onPaste(e: React.ClipboardEvent) {
    if (!mine) return;
    e.preventDefault();
    const text = e.clipboardData.getData("text").slice(0, 2_000);
    if (text) { await flush(); await send({ action: "type", text }); void poll(); }
  }

  /** screenshot pixels → page pixels (the capture is CSS-sized, so one factor is enough) */
  function pageCoords(e: React.MouseEvent<HTMLImageElement>) {
    const img = imgRef.current;
    const vw = frame?.viewport?.width;
    if (!img || !vw) return null;
    const rect = img.getBoundingClientRect();
    const scale = rect.width / vw;
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
  }

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden", className)}>
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-md", mine ? "bg-warning/15 text-warning" : "bg-brand/15 text-brand")}>
          {mine ? <Hand className="h-3.5 w-3.5" /> : <MousePointer2 className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
            {mine ? "You have control" : `${agentName} is controlling`}
            {frame?.live === false && <Badge color="#6f7890" dot>No session</Badge>}
          </div>
          <div dir="ltr" className="truncate font-mono text-[10.5px] text-ink-3">{!frame ? "connecting…" : frame.url ?? (frame.live ? "loading…" : "no live browser session")}</div>
        </div>
        <Button variant="ghost" size="xs" onClick={() => void poll()} title="Refresh"><RefreshCw className="h-3 w-3" /></Button>
        {mine && (
          <Button variant="success" size="xs" disabled={busy} onClick={() => act({ action: "return" })}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowLeft className="h-3 w-3" />} Return control
          </Button>
        )}
      </header>

      <div
        ref={stageRef}
        tabIndex={mine ? 0 : -1}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="relative min-h-0 flex-1 overflow-auto bg-black/40 outline-none focus:ring-1 focus:ring-brand/50"
      >
        {error && <div className="m-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11.5px] text-[#ff8ea3]">{error}</div>}
        {!frame && !error && <div className="flex h-full items-center justify-center gap-2 py-10 text-[12px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Connecting to the browser…</div>}
        {frame && !frame.live && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center text-[12px] text-ink-3">
            <span>{agentName} has no browser open right now.</span>
            <span className="text-[11px]">This view shows the agent&apos;s own session; it never starts one.</span>
          </div>
        )}
        {frame?.image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imgRef}
            src={frame.image}
            alt={frame.title ?? "Agent browser"}
            className={cn("w-full select-none", mine ? "cursor-crosshair" : "cursor-not-allowed")}
            draggable={false}
            onClick={(e) => {
              if (!mine) return;
              stageRef.current?.focus(); // so the next keystroke goes to the page, not to Nexora
              const p = pageCoords(e);
              if (p) void act({ action: "click", x: p.x, y: p.y });
            }}
            onDoubleClick={(e) => { if (!mine) return; const p = pageCoords(e); if (p) void act({ action: "click", x: p.x, y: p.y, double: true }); }}
            onWheel={(e) => { if (mine) void act({ action: "scroll", dy: e.deltaY }); }}
          />
        )}
      </div>

      <footer className="shrink-0 border-t border-line px-3 py-2">
        {mine ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.currentTarget.elements.namedItem("keys") as HTMLInputElement) ?? null;
              const text = input?.value ?? "";
              if (!text) return;
              input.value = "";
              void act({ action: "type", text });
            }}
          >
            <input name="keys" dir="auto" placeholder={typing ? "sending…" : "Or type here and press Type"} className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-white/[0.04] px-2.5 text-[12px] text-ink outline-none placeholder:text-ink-3 focus:border-brand/60" autoComplete="off" />
            <Button type="submit" variant="ghost" size="xs" disabled={busy}>Type</Button>
            <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => act({ action: "key", key: "Enter" })}>Enter</Button>
            {!compact && <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => act({ action: "navigate", url: "reload" })} title="Reload"><RotateCw className="h-3 w-3" /></Button>}
            {!compact && <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => act({ action: "cancel" })} title="Dismiss this handoff"><X className="h-3 w-3" /></Button>}
          </form>
        ) : (
          <p className="text-[11px] text-ink-3">{agentName} is driving. It hands you the controls when it needs you.</p>
        )}
        {mine && <p className="mt-1 text-[10.5px] text-ink-3">Click a field in the page, then just type — your keyboard and paste go straight to {agentName}&apos;s browser.</p>}
      </footer>
    </div>
  );
}
