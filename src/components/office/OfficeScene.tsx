"use client";

import { ReactNode, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Crown, Settings2, Code2, BarChart3, Users, Headphones, Landmark } from "lucide-react";
import { iso, poly, S, VIEW_W, VIEW_H, pct, rgba, shade, mulberry32, floorRect } from "@/lib/iso";
import { departments, DeptId } from "@/lib/mock-data";
import type { Floor, FloorAgent } from "@/lib/office/floor";
import { cn } from "@/lib/utils";
import { deskSprites, seatPoint, seatsFor, type Seat } from "./people";
import { STATE_META } from "./states";
import {
  IsoBox, WallPlane, GlassWall, Plant, ConferenceTable, planeFloor,
} from "./primitives";
import {
  CodeScreen, KanbanBoard, BarChartScreen, FunnelScreen, TicketsScreen, MeetingScreen, LogoSign, TextScreen, Shelves,
} from "./screens";

/* --------------------------------- layout --------------------------------- */
type RoomId = DeptId | "lobby";
type Room = { id: RoomId; x: number; y: number; w: number; d: number; label?: [number, number, number] };

const ROOMS: Room[] = [
  { id: "ceo", x: 0, y: 0, w: 20, d: 16, label: [10, 8, 7] },
  { id: "operations", x: 20, y: 0, w: 22, d: 16, label: [31, 8, 7] },
  { id: "engineering", x: 42, y: 0, w: 22, d: 16, label: [53, 8, 7] },
  { id: "finance", x: 0, y: 16, w: 20, d: 16, label: [10, 24, 6.5] },
  { id: "conference", x: 20, y: 16, w: 22, d: 16, label: [31, 19, 8.6] },
  { id: "sales", x: 42, y: 16, w: 22, d: 16, label: [53, 24, 6.5] },
  { id: "support", x: 42, y: 32, w: 22, d: 12, label: [53, 38, 6] },
  { id: "lobby", x: 0, y: 32, w: 42, d: 12 },
];

const FLOOR_W = 64;
const FLOOR_D = 44;
const WALL_H = 4.2;
const OUTER_H = 8;

const DEPT_ICON: Record<DeptId, typeof Crown> = {
  ceo: Crown, operations: Settings2, engineering: Code2, sales: BarChart3, support: Headphones, finance: Landmark, conference: Users,
};

const SUITS = ["#1a2233", "#212a3f", "#2a2438", "#1c2a2e"];

type Sprite = { depth: number; el: ReactNode };

/** Glass partitions split into 2-unit segments (with door gaps) so depth sorting works. */
function wallSegments(): Sprite[] {
  const out: Sprite[] = [];
  const gapped = (v: number, gaps: [number, number][]) => gaps.some(([a, b]) => v >= a && v < b);
  const alongX = (y: number, gaps: [number, number][], h: number) => {
    for (let x = 0; x < FLOOR_W; x += 2) {
      if (gapped(x, gaps)) continue;
      out.push({ depth: x + 1 + y, el: <GlassWall key={`wy${y}-${x}`} x1={x} y1={y} x2={x + 2} y2={y} h={h} /> });
    }
  };
  const alongY = (x: number, from: number, to: number, gaps: [number, number][], h: number) => {
    for (let y = from; y < to; y += 2) {
      if (gapped(y, gaps)) continue;
      out.push({ depth: x + y + 1, el: <GlassWall key={`wx${x}-${y}`} x1={x} y1={y} x2={x} y2={y + 2} h={h} /> });
    }
  };
  alongX(16, [[8, 12], [28, 34], [50, 54]], WALL_H);
  alongX(32, [[6, 10], [28, 34], [50, 54]], WALL_H);
  alongY(20, 0, 32, [[6, 10], [22, 26]], WALL_H);
  alongY(42, 0, 44, [[6, 10], [22, 26], [36, 40]], WALL_H);
  return out;
}

function furniture(floor: Floor): Sprite[] {
  const c = departments;
  const out: Sprite[] = [];
  const push = (depth: number, el: ReactNode) => out.push({ depth, el });
  // the wall screens carry the department's own real numbers, or nothing
  const room = (id: DeptId) => floor.departments.find((d) => d.id === id);
  const busy = (id: DeptId) => {
    const r = room(id);
    if (!r) return "";
    const open = r.agents.filter((a) => a.currentTask).length;
    const stuck = r.agents.filter((a) => a.state === "BLOCKED" || a.state === "STALLED").length;
    return `${r.agents.length} ${r.agents.length === 1 ? "person" : "people"} · ${open} on a task${stuck ? ` · ${stuck} stuck` : ""}`;
  };

  /* ---- CEO office ---- */
  push(3 + 8, <WallPlane key="ceo-screen" axis="y" at={0.35} from={3} to={12} z={2.5} h={3}>{(W, H) => <TextScreen W={W} H={H} color={c.ceo.color} lines={[
    "The company right now",
    `${floor.totals.agents} agents · ${floor.totals.openTasks} open tasks`,
    `${floor.totals.working} working · ${floor.totals.waiting} waiting · ${floor.totals.blocked} stuck`,
  ]} />}</WallPlane>);
  push(0.4 + 11, <WallPlane key="ceo-shelf" axis="x" at={0.4} from={8} to={14} z={0} h={3.4} fill="#1b2133">{(W, H) => <Shelves W={W} H={H} />}</WallPlane>);
  push(2 + 2, <Plant key="p-ceo1" x={2} y={2} size={1.1} />);
  push(17 + 3, <Plant key="p-ceo2" x={17.5} y={2.5} />);
  // rug
  push(0, <g key="rug" transform={planeFloor(9.5, 7.5, 0.02)}><ellipse rx={7 * S} ry={4.5 * S} fill={rgba(c.ceo.color, 0.08)} stroke={rgba(c.ceo.color, 0.18)} strokeWidth={0.8} /></g>);
  push(2 + 13, <Plant key="p-ceo3" x={2.2} y={13} />);

  /* ---- Operations ---- */
  push(31 + 0.35, <WallPlane key="ops-board" axis="y" at={0.35} from={24} to={37} z={2.3} h={3} fill="#e9edf5">{(W, H) => <KanbanBoard W={W} H={H} color={c.operations.color} />}</WallPlane>);
  push(39.5 + 14, <Plant key="p-ops1" x={39.8} y={14} />);
  push(21.5 + 14.5, <Plant key="p-ops2" x={21.6} y={14.4} size={0.9} />);

  /* ---- Engineering ---- */
  push(53 + 0.35, <WallPlane key="eng-screen" axis="y" at={0.35} from={46} to={60} z={2.5} h={3.2}>{(W, H) => <CodeScreen W={W} H={H} color={c.engineering.color} />}</WallPlane>);
  push(62 + 13, <g key="rack"><IsoBox x={61.6} y={12.2} w={1.6} d={1.6} h={3.4} color="#141b2c" top="#222c44" />{[0, 1, 2, 3].map((i) => (
    <motion.circle key={i} cx={iso(62.9, 13.85, 0.6 + i * 0.7)[0]} cy={iso(62.9, 13.85, 0.6 + i * 0.7)[1]} r={1.3} fill={i % 2 ? "#3dd68c" : "#4f8bff"} animate={{ opacity: [1, 0.2, 1] }} transition={{ duration: 0.8 + i * 0.3, repeat: Infinity }} />
  ))}</g>);
  push(43.5 + 14, <Plant key="p-eng1" x={43.6} y={14.2} />);

  /* ---- Finance ---- */
  push(0.4 + 24, <WallPlane key="fin-screen" axis="x" at={0.4} from={19} to={29} z={2.4} h={3}>{(W, H) => <BarChartScreen W={W} H={H} color={c.finance.color} title={`Finance · ${busy("finance")}`} />}</WallPlane>);
  push(16 + 19, <IsoBox key="cab" x={15.8} y={18.2} w={2.6} d={1.2} h={2.2} color="#1b2133" top="#2a3448" />);
  push(17.5 + 29.5, <Plant key="p-fin1" x={17.6} y={29.6} />);

  /* ---- Conference ---- */
  push(31 + 17.2, <WallPlane key="conf-screen" axis="y" at={17.2} from={25} to={37} z={0.2} h={3.6}>{(W, H) => <MeetingScreen W={W} H={H} color={c.conference.color} lines={["Meeting room", "Nexora does not hold meetings yet"]} />}</WallPlane>);
  // Meetings are not a thing Nexora does yet, so this room is simply a room:
  // a table and nobody at it, rather than a scene of a meeting that never
  // happened.
  push(31 + 25 - 0.01, <g key="ring" transform={planeFloor(31, 25, 0.03)}>
    <ellipse rx={6.6 * S} ry={3.6 * S} fill={rgba(c.conference.color, 0.07)} />
  </g>);
  push(31 + 25, <ConferenceTable key="table" cx={31} cy={25} rx={5.2} ry={2.4} />);
  // laptops on table
  [[27.5, 24.2], [30.2, 23.6], [33, 24], [29, 26.3], [33.2, 26.4]].forEach(([lx, ly], i) => {
    push(31 + 25 + 0.01 + i * 0.001, <g key={`lap${i}`}>
      <IsoBox x={lx} y={ly} z={1.1} w={0.9} d={0.7} h={0.06} color="#2a3448" />
      <IsoBox x={lx} y={ly} z={1.16} w={0.9} d={0.08} h={0.6} color="#0b1020" top="#1b2334" />
    </g>);
  });
  push(21.5 + 30.5, <Plant key="p-conf1" x={21.6} y={30.4} />);
  push(40.5 + 17.6, <Plant key="p-conf2" x={40.4} y={17.6} size={0.9} />);
  push(40.5 + 30.5, <Plant key="p-conf3" x={40.4} y={30.4} />);

  /* ---- Sales ---- */
  push(59 + 17.2, <WallPlane key="sales-board" axis="y" at={17.2} from={54.5} to={63.5} z={0.2} h={3.6}>{(W, H) => <FunnelScreen W={W} H={H} color={c.sales.color} title={`Sales · ${busy("sales")}`} />}</WallPlane>);
  push(62 + 30.5, <Plant key="p-sales1" x={62} y={30.4} />);

  /* ---- Support ---- */
  push(53 + 33.2, <WallPlane key="sup-board" axis="y" at={32.7} from={45} to={61} z={0.2} h={3.4}>{(W, H) => <TicketsScreen W={W} H={H} color={c.support.color} title={`Support · ${busy("support")}`} />}</WallPlane>);
  push(62.5 + 42.5, <Plant key="p-sup1" x={62.4} y={42.4} />);
  push(43.5 + 42.5, <Plant key="p-sup2" x={43.4} y={42.5} size={0.9} />);

  /* ---- Lobby ---- */
  push(0, <g key="lobby-logo" transform={planeFloor(21, 38, 0.02)}>
    <circle r={4.2 * S} fill={rgba("#6d7cff", 0.07)} stroke={rgba("#6d7cff", 0.22)} strokeWidth={0.8} />
    <circle r={2.6 * S} fill="none" stroke={rgba("#6d7cff", 0.14)} strokeWidth={0.8} />
  </g>);
  push(19 + 33.4, <WallPlane key="sign" axis="y" at={33.4} from={11} to={27} z={0.2} h={4.2} fill="#0d1428" stroke="rgba(255,255,255,0.18)">{(W, H) => <LogoSign W={W} H={H} />}</WallPlane>);
  push(6.5 + 37, <IsoBox key="recep" x={4} y={36.5} w={5} d={1.8} h={1.4} color="#1e2540" top="#2e3760" />);
  push(6.5 + 37.01, <IsoBox key="recep-top" x={4} y={36.5} z={1.4} w={5} d={0.25} h={0.5} color="#2c3566" top="#3b47ff" />);
  push(0.001, <g key="lobby-rug" transform={planeFloor(31.5, 41.5, 0.02)}><rect x={-5 * S} y={-2.2 * S} width={10 * S} height={4.4 * S} rx={6} fill={rgba("#6d7cff", 0.08)} stroke={rgba("#6d7cff", 0.2)} strokeWidth={0.8} /></g>);
  push(28 + 41.5, <g key="couch1"><IsoBox x={26} y={40.8} w={4} d={1.5} h={0.6} color="#252b40" top="#333b58" /><IsoBox x={26} y={40.8} z={0.6} w={4} d={0.35} h={0.7} color="#2c3350" top="#3b4468" />{[0, 1, 2].map((i) => <IsoBox key={i} x={26.15 + i * 1.3} y={41.15} z={0.6} w={1.2} d={1.1} h={0.25} color="#343c5c" top="#454f78" />)}</g>);
  push(35 + 41.5, <g key="couch2"><IsoBox x={33} y={40.8} w={4} d={1.5} h={0.6} color="#252b40" top="#333b58" /><IsoBox x={33} y={40.8} z={0.6} w={4} d={0.35} h={0.7} color="#2c3350" top="#3b4468" />{[0, 1, 2].map((i) => <IsoBox key={i} x={33.15 + i * 1.3} y={41.15} z={0.6} w={1.2} d={1.1} h={0.25} color="#343c5c" top="#454f78" />)}</g>);
  push(30.5 + 42.3, <IsoBox key="ctable" x={30.6} y={41.6} w={1.8} d={0.9} h={0.55} color="#1b2133" top="#2a3448" />);
  push(12.5 + 42, <Plant key="p-lob1" x={12.5} y={42} size={1.1} />);
  push(40.5 + 42.5, <Plant key="p-lob2" x={40.4} y={42.4} />);
  push(2 + 42.5, <Plant key="p-lob3" x={2} y={42.4} />);
  push(2 + 34, <Plant key="p-lob4" x={2} y={34} size={0.9} />);

  return out;
}



/* ---------------------------------- scene --------------------------------- */
export function OfficeScene({
  floor, selected, onSelect, selectedAgentId, onSelectAgent, reduced = false, stale = false, className,
}: {
  floor: Floor;
  selected: DeptId | null;
  onSelect: (d: DeptId | null) => void;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  reduced?: boolean;
  stale?: boolean;
  className?: string;
}) {
  const [hovered, setHovered] = useState<DeptId | null>(null);
  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);

  const staticSprites = useMemo(() => [...wallSegments(), ...furniture(floor)], [floor]);
  // one desk per real agent, in the room of the department they are in
  const rooms = useMemo(
    () => floor.departments.map((d) => ({ dept: d, ...seatsFor(d.id, d.agents) })),
    [floor]
  );
  const sprites = useMemo(() => {
    const people = rooms.flatMap((r) => deskSprites(r.dept.id, r.seats, r.dept.color, reduced));
    return [...staticSprites, ...people].sort((a, b) => a.depth - b.depth);
  }, [staticSprites, rooms, reduced]);

  const city = useMemo(() => {
    const rnd = mulberry32(2024);
    const b: Array<{ x: number; w: number; h: number; lit: number[] }> = [];
    let x = -20;
    while (x < VIEW_W + 40) {
      const w = 26 + rnd() * 58;
      const h = 70 + rnd() * 230;
      const lit: number[] = [];
      const cols = Math.floor(w / 9), rows = Math.floor(h / 11);
      for (let i = 0; i < cols * rows; i++) if (rnd() < 0.22) lit.push(i);
      b.push({ x, w, h, lit });
      x += w + 4 + rnd() * 10;
    }
    return b;
  }, []);

  const active = hovered ?? selected;

  return (
    <div className={cn("@container relative w-full select-none", className)} style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}>
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="absolute inset-0 h-full w-full" onClick={() => onSelect(null)}>
        <defs>
          <linearGradient id="sky" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#0c1330" />
            <stop offset="0.55" stopColor="#0a1024" />
            <stop offset="1" stopColor="#070b14" />
          </linearGradient>
          <linearGradient id="haze" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#0a1024" stopOpacity="0" />
            <stop offset="1" stopColor="#070b14" stopOpacity="1" />
          </linearGradient>
          <linearGradient id="head" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#f6f8fc" />
            <stop offset="1" stopColor="#b6bfd2" />
          </linearGradient>
          {SUITS.concat(["#3a2f1d"]).map((s) => (
            <linearGradient key={s} id={`suit-${s.slice(1)}`} x1="0" x2="1" y1="0" y2="1">
              <stop offset="0" stopColor={shade(s, 0.22)} />
              <stop offset="1" stopColor={shade(s, -0.2)} />
            </linearGradient>
          ))}
          <radialGradient id="tableTop" cx="0.4" cy="0.35" r="0.8">
            <stop offset="0" stopColor="#4a5680" />
            <stop offset="1" stopColor="#283354" />
          </radialGradient>
          <linearGradient id="signGrad" x1="0" x2="1">
            <stop offset="0" stopColor="#101a3a" />
            <stop offset="1" stopColor="#0b1228" />
          </linearGradient>
          <linearGradient id="meetGrad" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#4c4fe0" />
            <stop offset="1" stopColor="#0b1224" />
          </linearGradient>
          <filter id="softglow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.2" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="bigblur" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="28" />
          </filter>
          <pattern id="grid" width={S} height={S} patternUnits="userSpaceOnUse" patternTransform={`matrix(1,0.5,-1,0.5,${iso(0, 0)[0]},${iso(0, 0)[1]})`}>
            <path d={`M ${S} 0 L 0 0 0 ${S}`} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="0.6" />
          </pattern>
        </defs>

        {/* Backdrop */}
        <rect width={VIEW_W} height={VIEW_H} fill="url(#sky)" />
        <ellipse cx={680} cy={120} rx={520} ry={140} fill="#2a3a8a" opacity={0.18} filter="url(#bigblur)" />
        <g opacity={0.9}>
          {city.map((b, i) => {
            const cols = Math.floor(b.w / 9);
            return (
              <g key={i}>
                <rect x={b.x} y={430 - b.h} width={b.w} height={b.h} fill={i % 3 === 0 ? "#0e1631" : "#0b1228"} />
                {b.lit.map((k) => (
                  <rect key={k} x={b.x + 3 + (k % cols) * 9} y={434 - b.h + Math.floor(k / cols) * 11} width={3.5} height={5} fill={k % 5 === 0 ? "#f5b942" : "#8fa3ff"} opacity={0.35} />
                ))}
              </g>
            );
          })}
        </g>
        <rect x={0} y={250} width={VIEW_W} height={260} fill="url(#haze)" />

        {/* Ground glow + slab */}
        <ellipse cx={iso(32, 22)[0]} cy={iso(32, 22)[1] + 40} rx={560} ry={200} fill="#2b3f9a" opacity={0.22} filter="url(#bigblur)" />
        <polygon points={poly([iso(0, FLOOR_D, 0), iso(FLOOR_W, FLOOR_D, 0), iso(FLOOR_W, FLOOR_D, -1.6), iso(0, FLOOR_D, -1.6)])} fill="#0a0f1d" />
        <polygon points={poly([iso(FLOOR_W, 0, 0), iso(FLOOR_W, FLOOR_D, 0), iso(FLOOR_W, FLOOR_D, -1.6), iso(FLOOR_W, 0, -1.6)])} fill="#05080f" />
        <polygon points={floorRect(0, 0, FLOOR_W, FLOOR_D)} fill="#10172a" />
        <polygon points={floorRect(0, 0, FLOOR_W, FLOOR_D)} fill="url(#grid)" />

        {/* Room floors */}
        {ROOMS.map((r) => {
          const color = r.id === "lobby" ? "#6d7cff" : departments[r.id].color;
          const isActive = r.id !== "lobby" && active === r.id;
          const isDim = active !== null && !isActive;
          return (
            <g key={r.id}>
              <motion.polygon
                points={floorRect(r.x, r.y, r.w, r.d, 0.01)}
                fill={color}
                animate={{ opacity: isActive ? 0.22 : r.id === "lobby" ? 0.09 : isDim ? 0.06 : 0.11 }}
                transition={{ duration: 0.3 }}
                stroke={isActive ? rgba(color, 0.7) : rgba(color, 0.18)}
                strokeWidth={isActive ? 1.4 : 0.7}
                style={{ cursor: r.id === "lobby" ? "default" : "pointer" }}
                onMouseEnter={() => r.id !== "lobby" && setHovered(r.id)}
                onMouseLeave={() => setHovered(null)}
                onClick={(e) => { e.stopPropagation(); if (r.id !== "lobby") onSelect(selected === r.id ? null : r.id); }}
              />
              {isActive && (
                <ellipse cx={iso(r.x + r.w / 2, r.y + r.d / 2)[0]} cy={iso(r.x + r.w / 2, r.y + r.d / 2)[1]} rx={r.w * S * 0.9} ry={r.d * S * 0.45} fill={color} opacity={0.18} filter="url(#bigblur)" pointerEvents="none" />
              )}
            </g>
          );
        })}

        {/* Outer back walls (glass curtain wall with city behind) */}
        <g pointerEvents="none">
          <polygon points={poly([iso(0, 0, 0), iso(FLOOR_W, 0, 0), iso(FLOOR_W, 0, OUTER_H), iso(0, 0, OUTER_H)])} fill="rgba(11,17,36,0.78)" stroke="rgba(160,180,255,0.25)" strokeWidth={0.8} />
          <polygon points={poly([iso(0, 0, 0), iso(0, FLOOR_D, 0), iso(0, FLOOR_D, OUTER_H), iso(0, 0, OUTER_H)])} fill="rgba(11,17,36,0.78)" stroke="rgba(160,180,255,0.25)" strokeWidth={0.8} />
          {/* solid lower wall band */}
          <polygon points={poly([iso(0, 0, 0), iso(FLOOR_W, 0, 0), iso(FLOOR_W, 0, 2.2), iso(0, 0, 2.2)])} fill="#151d33" />
          <polygon points={poly([iso(0, 0, 0), iso(0, FLOOR_D, 0), iso(0, FLOOR_D, 2.2), iso(0, 0, 2.2)])} fill="#111827" />
          <line x1={iso(0, 0, 2.2)[0]} y1={iso(0, 0, 2.2)[1]} x2={iso(FLOOR_W, 0, 2.2)[0]} y2={iso(FLOOR_W, 0, 2.2)[1]} stroke="rgba(160,180,255,0.3)" strokeWidth={0.8} />
          <line x1={iso(0, 0, 2.2)[0]} y1={iso(0, 0, 2.2)[1]} x2={iso(0, FLOOR_D, 2.2)[0]} y2={iso(0, FLOOR_D, 2.2)[1]} stroke="rgba(160,180,255,0.3)" strokeWidth={0.8} />
          {Array.from({ length: FLOOR_W / 4 + 1 }).map((_, i) => (
            <line key={`mx${i}`} x1={iso(i * 4, 0, 0)[0]} y1={iso(i * 4, 0, 0)[1]} x2={iso(i * 4, 0, OUTER_H)[0]} y2={iso(i * 4, 0, OUTER_H)[1]} stroke="rgba(160,180,255,0.16)" strokeWidth={0.7} />
          ))}
          {Array.from({ length: FLOOR_D / 4 + 1 }).map((_, i) => (
            <line key={`my${i}`} x1={iso(0, i * 4, 0)[0]} y1={iso(0, i * 4, 0)[1]} x2={iso(0, i * 4, OUTER_H)[0]} y2={iso(0, i * 4, OUTER_H)[1]} stroke="rgba(160,180,255,0.16)" strokeWidth={0.7} />
          ))}
          {/* beams */}
          <polygon points={poly([iso(0, 0, OUTER_H), iso(FLOOR_W, 0, OUTER_H), iso(FLOOR_W, 0, OUTER_H + 0.5), iso(0, 0, OUTER_H + 0.5)])} fill="#1b2338" />
          <polygon points={poly([iso(0, 0, OUTER_H), iso(0, FLOOR_D, OUTER_H), iso(0, FLOOR_D, OUTER_H + 0.5), iso(0, 0, OUTER_H + 0.5)])} fill="#141b2c" />
          {/* wall glow strips */}
          <line x1={iso(0, 0, 0.15)[0]} y1={iso(0, 0, 0.15)[1]} x2={iso(FLOOR_W, 0, 0.15)[0]} y2={iso(FLOOR_W, 0, 0.15)[1]} stroke="#6d7cff" strokeWidth={1.2} opacity={0.6} style={{ filter: "url(#softglow)" }} />
          <line x1={iso(0, 0, 0.15)[0]} y1={iso(0, 0, 0.15)[1]} x2={iso(0, FLOOR_D, 0.15)[0]} y2={iso(0, FLOOR_D, 0.15)[1]} stroke="#6d7cff" strokeWidth={1.2} opacity={0.6} style={{ filter: "url(#softglow)" }} />
        </g>

        {/* Depth-sorted interior */}
        <g pointerEvents="none">{sprites.map((s) => s.el)}</g>

        {/* Front railings */}
        <g pointerEvents="none" opacity={0.9}>
          <polygon points={poly([iso(FLOOR_W, 0, 0), iso(FLOOR_W, FLOOR_D, 0), iso(FLOOR_W, FLOOR_D, 1), iso(FLOOR_W, 0, 1)])} fill="rgba(143,176,255,0.06)" stroke="rgba(160,180,255,0.35)" strokeWidth={0.8} />
          <polygon points={poly([iso(0, FLOOR_D, 0), iso(FLOOR_W, FLOOR_D, 0), iso(FLOOR_W, FLOOR_D, 1), iso(0, FLOOR_D, 1)])} fill="rgba(143,176,255,0.06)" stroke="rgba(160,180,255,0.35)" strokeWidth={0.8} />
        </g>
      </svg>

      {/* Department labels (HTML overlay for crisp text) */}
      {ROOMS.filter((r) => r.id !== "lobby" && r.label).map((r) => {
        const dept = departments[r.id as DeptId];
        const Icon = DEPT_ICON[r.id as DeptId];
        const p = pct(...(r.label as [number, number, number]));
        const isActive = active === r.id;
        const room = rooms.find((x) => x.dept.id === r.id);
        const headcount = room?.dept.agents.length ?? 0;
        return (
          <button
            key={r.id}
            onMouseEnter={() => setHovered(r.id as DeptId)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onSelect(selected === r.id ? null : (r.id as DeptId))}
            className={cn(
              // below this the chips collide with each other; the directory
              // view is the way in at that size
              "absolute -translate-x-1/2 -translate-y-1/2 hidden items-center gap-1.5 rounded-lg border px-2 py-1 text-[clamp(8px,1.05cqw,11.5px)] font-semibold tracking-tight transition-all @[640px]:flex",
              isActive ? "scale-110 shadow-[0_10px_30px_-8px_rgba(0,0,0,0.8)]" : "hover:scale-105"
            )}
            style={{
              left: p.left, top: p.top,
              background: isActive ? rgba(dept.color, 0.2) : "rgba(8,12,24,0.78)",
              borderColor: rgba(dept.color, isActive ? 0.9 : 0.45),
              color: "#eef1ff",
              boxShadow: isActive ? `0 0 0 3px ${rgba(dept.color, 0.15)}` : undefined,
            }}
          >
            <span className="grid h-4 w-4 place-items-center rounded" style={{ background: dept.color, color: "#0a0e1a" }}>
              <Icon className="h-2.5 w-2.5" strokeWidth={2.6} />
            </span>
            {dept.shortName === "Meeting" ? "Conference" : dept.name === "Executive Office" ? "CEO" : dept.name}
            {r.id !== "conference" && (
              <span className={cn("num ms-0.5 rounded px-1 py-px text-[9.5px]", headcount ? "bg-white/[0.08] text-ink-2" : "text-ink-3")}>
                {headcount || "empty"}
              </span>
            )}
            {!!room?.overflow && <span className="num ms-0.5 text-[9.5px] text-ink-3">+{room.overflow} more</span>}
          </button>
        );
      })}

      {/* One hit target per real agent, on top of their own desk */}
      {rooms.flatMap((r) =>
        r.seats.map((seat) => (
          <AgentHotspot
            key={seat.agent.id}
            seat={seat}
            color={r.dept.color}
            selected={selectedAgentId === seat.agent.id}
            hovered={hoveredAgent === seat.agent.id}
            dimmed={active !== null && active !== r.dept.id}
            onHover={setHoveredAgent}
            onSelect={onSelectAgent}
          />
        ))
      )}

      {/* Hero headline */}
      <div className="pointer-events-none absolute left-5 top-5 hidden max-w-[360px] @[900px]:block">
        <h1 className="text-[26px] xl:text-[30px] font-semibold leading-[1.05] tracking-tight text-gradient">
          A complete company.<br />Powered by AI.
        </h1>
        <p className="mt-2 text-[12.5px] text-ink-2">People. Projects. Progress. All in one place.</p>
      </div>

      {/* What is actually happening, counted from the same data as the avatars */}
      <div className="absolute bottom-4 left-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-[rgba(8,12,24,0.82)] px-3 py-2">
        <span className="flex items-center gap-2 text-[11.5px] text-ink">
          <span className={cn("h-2 w-2 rounded-full", stale ? "bg-ink-3" : "bg-operations")} />
          <span className="num font-semibold">{floor.totals.agents}</span> {floor.totals.agents === 1 ? "agent" : "agents"}
        </span>
        <span className="h-3 w-px bg-line-2" />
        <span className="text-[11px] text-ink-3">
          <span className="num" style={{ color: STATE_META.WORKING.color }}>{floor.totals.working}</span> working
          {" · "}
          <span className="num" style={{ color: STATE_META.WAITING_OWNER.color }}>{floor.totals.waiting}</span> waiting
          {" · "}
          <span className="num" style={{ color: STATE_META.BLOCKED.color }}>{floor.totals.blocked}</span> stuck
          {" · "}
          <span className="num">{floor.totals.idle}</span> free
        </span>
        {stale && <span className="text-[11px] text-ink-3">· live updates disconnected</span>}
      </div>
    </div>
  );
}

/**
 * A real agent's hit target: a button over the seat, so the floor is
 * keyboard-reachable and finger-sized, and so the SVG underneath stays a
 * picture. The state marker is always there when the state is worth
 * knowing; the name appears on hover, focus or selection.
 */
function AgentHotspot({
  seat, color, selected, hovered, dimmed, onHover, onSelect,
}: {
  seat: Seat;
  color: string;
  selected: boolean;
  hovered: boolean;
  dimmed: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
}) {
  const [sx, sy] = seatPoint(seat);
  const agent: FloorAgent = seat.agent;
  const meta = STATE_META[agent.state];
  const show = selected || hovered;
  return (
    <button
      type="button"
      aria-label={`${agent.name}, ${agent.role} — ${meta.label}`}
      aria-pressed={selected}
      onMouseEnter={() => onHover(agent.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(agent.id)}
      onBlur={() => onHover(null)}
      onClick={(e) => { e.stopPropagation(); onSelect(selected ? null : agent.id); }}
      className={cn(
        "absolute z-10 -translate-x-1/2 rounded-full outline-none transition-opacity",
        dimmed && !show ? "opacity-40" : "opacity-100"
      )}
      style={{
        left: `${(sx / VIEW_W) * 100}%`,
        top: `${((sy - 44) / VIEW_H) * 100}%`,
        width: "clamp(30px, 3.2cqw, 44px)",
        height: "clamp(44px, 4.6cqw, 62px)",
      }}
    >
      {/* the marker sits above the head; "available" needs no decoration */}
      {agent.state !== "IDLE" && (
        <span
          className="absolute left-1/2 top-0 -translate-x-1/2 rounded-full border"
          style={{
            width: "clamp(7px, 0.75cqw, 10px)",
            height: "clamp(7px, 0.75cqw, 10px)",
            background: meta.color,
            borderColor: "rgba(6,10,20,0.75)",
            boxShadow: `0 0 0 3px ${rgba(meta.color, 0.18)}`,
          }}
        />
      )}
      {selected && (
        <span
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ width: "160%", height: "70%", border: `1.5px solid ${rgba(color, 0.9)}`, background: rgba(color, 0.12) }}
        />
      )}
      {show && (
        <span
          className="pointer-events-none absolute left-1/2 top-full z-20 mt-0.5 flex max-w-[180px] -translate-x-1/2 flex-col items-center whitespace-nowrap rounded-lg border px-1.5 py-0.5"
          style={{ background: "rgba(8,12,24,0.94)", borderColor: rgba(color, 0.6) }}
        >
          <span className="truncate text-[clamp(8px,0.95cqw,11px)] font-semibold text-ink">{agent.name}</span>
          <span className="truncate text-[clamp(7px,0.8cqw,10px)]" style={{ color: meta.color }}>{meta.short}</span>
        </span>
      )}
    </button>
  );
}
