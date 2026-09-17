"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MotionConfig, useReducedMotion } from "framer-motion";
import { LayoutGrid, Loader2, Maximize2, Network, WifiOff } from "lucide-react";
import type { DeptId } from "@/lib/mock-data";
import { useMediaQuery } from "@/lib/use-media-query";
import type { Floor } from "@/lib/office/floor";
import { cn } from "@/lib/utils";
import { OfficeScene } from "./OfficeScene";
import { AgentCard } from "./AgentCard";
import { Directory, OrgChart } from "./Directory";

type View = "office" | "directory" | "org";

/**
 * The live office.
 *
 * It holds one copy of the real floor and three ways of looking at it. New
 * events do not patch that copy — they ask for it again — so a missed
 * event costs a refetch and never a wrong picture, and a reconnect is just
 * another refetch. When the stream is down it says so instead of quietly
 * showing an old snapshot forever.
 */
export function OfficeView({ className, compact = false }: { className?: string; compact?: boolean }) {
  const [floor, setFloor] = useState<Floor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  // null means "whatever suits this screen": the isometric floor needs room,
  // and on a phone the directory is the honest, usable way in
  const [view, setView] = useState<View | null>(null);
  const [dept, setDept] = useState<DeptId | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const reduced = useReducedMotion() ?? false;
  const narrow = useMediaQuery("(max-width: 700px)");
  const shown: View = view ?? (narrow ? "directory" : "office");
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const r = await fetch("/api/office", { cache: "no-store" });
      if (!r.ok) throw new Error(`office: ${r.status}`);
      setFloor(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inflight.current = false;
    }
  }, []);

  // the existing activity bus, with the office as one more subject
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // read the floor once straight away, whether or not the stream connects
    const first = setTimeout(() => void load(), 0);
    const es = new EventSource("/api/office/events");
    es.onopen = () => { setLive(true); void load(); };
    es.onmessage = () => {
      // several things often move at once; one refetch covers them all
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    };
    es.onerror = () => setLive(false);
    // a slow backstop, so a dropped stream degrades rather than freezes
    const poll = setInterval(() => void load(), 20_000);
    return () => { es.close(); clearInterval(poll); clearTimeout(first); if (timer) clearTimeout(timer); };
  }, [load]);

  const everyone = floor ? [...floor.departments.flatMap((d) => d.agents), ...floor.unassigned] : [];
  // an agent removed while its card was open simply stops being found, and
  // the card goes with it — no stale panel, nothing to clean up
  const chosen = everyone.find((a) => a.id === agentId) ?? null;

  return (
    <MotionConfig reducedMotion="user">
      <div className={cn("@container relative w-full", className)}>
        {!floor && !error && (
          <div className="flex aspect-[1360/790] items-center justify-center gap-2 text-[12.5px] text-ink-3">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the floor…
          </div>
        )}
        {error && !floor && (
          <div className="flex aspect-[1360/790] flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-[12.5px] text-[#ff8ea3]">The office could not be loaded: {error}</p>
            <button type="button" onClick={() => void load()} className="rounded-lg border border-line px-2.5 py-1 text-[11.5px] text-ink-2 hover:text-ink">Try again</button>
          </div>
        )}

        {floor && (
          <>
            {shown === "office" ? (
              <OfficeScene
                floor={floor}
                selected={dept}
                onSelect={(d) => { setDept(d); setAgentId(null); }}
                selectedAgentId={agentId}
                onSelectAgent={setAgentId}
                reduced={reduced}
                stale={!live}
              />
            ) : (
              // a readable, scrollable panel at any width — the isometric
              // floor's aspect ratio would leave a phone two rows tall
              <div className={cn("h-[520px]", compact ? "" : "@[1000px]:h-[720px]")}>
                {shown === "directory"
                  ? <Directory floor={floor} selected={dept} onSelect={setDept} onSelectAgent={setAgentId} />
                  : <OrgChart floor={floor} onSelectAgent={setAgentId} />}
              </div>
            )}

            {/* how you want to look at it */}
            <div className="absolute end-3 top-3 z-20 flex items-center gap-1 rounded-xl border border-line bg-[rgba(8,12,24,0.86)] p-1">
              {([["office", "Office", Maximize2], ["directory", "Directory", LayoutGrid], ["org", "Org chart", Network]] as const).map(([id, label, Icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setView(id)}
                  aria-pressed={shown === id}
                  className={cn("flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors", shown === id ? "bg-white/[0.1] text-ink" : "text-ink-3 hover:text-ink-2")}
                >
                  <Icon className="h-3 w-3" /> <span className="hidden @[620px]:inline">{label}</span>
                </button>
              ))}
              {!live && (
                <span className="ms-1 flex items-center gap-1 rounded-lg px-1.5 py-1 text-[10.5px] text-ink-3" title="Live updates are disconnected — this may be out of date">
                  <WifiOff className="h-3 w-3" />
                </span>
              )}
            </div>

            {chosen && (
              <div className="absolute bottom-3 end-3 z-30 max-w-[calc(100%-1.5rem)]">
                <AgentCard agent={chosen} onClose={() => setAgentId(null)} />
              </div>
            )}
          </>
        )}
      </div>
    </MotionConfig>
  );
}
