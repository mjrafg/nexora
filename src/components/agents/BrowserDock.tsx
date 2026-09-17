"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronsRight, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { BrowserLiveView } from "./BrowserLiveView";
import type { AgentView } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

const MIN_W = 340;
const MAX_W = 1100;
/** the chat never gets squeezed below this, however wide the dock is dragged */
const MIN_CHAT = 380;
const STORE_KEY = "nexora.browserDock.width";

const clampWidth = (w: number) => {
  const room = typeof window === "undefined" ? 1440 : window.innerWidth - MIN_CHAT - 300;
  return Math.max(Math.min(w, MAX_W, Math.max(room, MIN_W)), MIN_W);
};

/**
 * The agent's browser docked beside its chat. It takes real layout width —
 * the conversation shrinks rather than being covered — and opening, resizing
 * or closing it never touches the underlying session.
 *
 * `above` is for anything the caller needs to put over the frame — a session
 * has two agents who take turns at the browser, so it offers a choice of whose
 * to watch. It belongs in here rather than in a wrapper around the dock: the
 * width rules below are written against the row the dock sits in, and an extra
 * element in between makes "leave 320px for the page" measure the wrong box.
 */
export function BrowserDock({ agent, onClose, onControlChange, above }: { agent: AgentView; onClose: () => void; onControlChange?: (control: "agent" | "owner") => void; above?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return 520;
    const stored = Number(window.localStorage.getItem(STORE_KEY));
    return clampWidth(Number.isFinite(stored) && stored > 0 ? stored : 520);
  });
  const dragging = useRef(false);

  useEffect(() => {
    const move = (e: MouseEvent) => { if (dragging.current) setWidth(clampWidth(window.innerWidth - e.clientX - 24)); };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      try { window.localStorage.setItem(STORE_KEY, String(width)); } catch { /* private mode */ }
    };
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); window.removeEventListener("resize", onResize); };
  }, [width]);

  return (
    <aside className="relative flex min-h-0 shrink-0 flex-col" style={{ width: expanded ? "min(1100px, 68vw)" : width, maxWidth: "calc(100% - 320px)" }}>
      <div
        onMouseDown={() => { if (!expanded) { dragging.current = true; document.body.style.cursor = "col-resize"; } }}
        className={cn("absolute -left-3 top-0 z-10 h-full w-3", expanded ? "cursor-default" : "cursor-col-resize")}
        title={expanded ? undefined : "Drag to resize"}
      >
        <span className="absolute left-1 top-1/2 h-10 w-1 -translate-y-1/2 rounded-full bg-line-2" />
      </div>

      {above && <div className="mb-2 shrink-0">{above}</div>}

      <div className="glass relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl">
        <div className="absolute right-2 top-1.5 z-10 flex gap-1">
          <Button variant="ghost" size="xs" onClick={() => setExpanded((v) => !v)} title={expanded ? "Shrink" : "Expand"}>{expanded ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}</Button>
          <Button variant="ghost" size="xs" onClick={onClose} title="Close dock"><ChevronsRight className="h-3 w-3" /></Button>
        </div>
        <BrowserLiveView agentId={agent.id} agentName={agent.name} onControlChange={onControlChange} className="flex-1 pr-16 [&>header]:pr-16" />
      </div>
    </aside>
  );
}
