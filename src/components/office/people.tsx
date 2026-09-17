"use client";

import type { ReactNode } from "react";
import { iso } from "@/lib/iso";
import type { DeptId } from "@/lib/mock-data";
import type { FloorAgent, FloorState } from "@/lib/office/floor";
import { AgentFigure, ChairBack, Desk } from "./primitives";

/* ------------------------------------------------------------------
   Real people at real desks.

   One avatar per agent, in the room of the department the agent is
   actually in, at a seat decided by a rule rather than by hand — so
   hiring someone adds a desk, removing them takes one away, and nobody
   is ever drawn twice because they hold two tasks.
   ------------------------------------------------------------------ */

export type Seat = { agent: FloorAgent; x: number; y: number; deskX: number; deskY: number; index: number };

/** The part of each room that desks may occupy. Everything else is furniture. */
const AREAS: Record<DeptId, { x: number; y: number; w: number; d: number; monitors?: number; headset?: boolean }> = {
  ceo: { x: 4.5, y: 3.5, w: 12, d: 9 },
  operations: { x: 23, y: 3.5, w: 17, d: 10 },
  engineering: { x: 44.5, y: 3.5, w: 17.5, d: 10, monitors: 2 },
  finance: { x: 3, y: 19.5, w: 14, d: 9 },
  sales: { x: 44.5, y: 20, w: 17.5, d: 9 },
  support: { x: 44, y: 35, w: 18, d: 6.5, headset: true },
  // the meeting room has a table, not desks: nobody is seated there unless a
  // meeting is a real thing in Nexora, and today it is not
  conference: { x: 0, y: 0, w: 0, d: 0 },
};

const DESK_W = 3.2;
const DESK_D = 1.6;
const MIN_PITCH_X = 5.2;
const MIN_PITCH_Y = 4.4;

/**
 * Where everyone sits, and how many did not fit. Deterministic in the order
 * the floor gives, so an avatar keeps its desk between refreshes.
 */
export function seatsFor(dept: DeptId, agents: FloorAgent[]): { seats: Seat[]; overflow: number } {
  const area = AREAS[dept];
  if (!area || !area.w || !agents.length) return { seats: [], overflow: agents.length };
  const maxCols = Math.max(1, Math.floor(area.w / MIN_PITCH_X));
  const maxRows = Math.max(1, Math.floor(area.d / MIN_PITCH_Y));
  const cols = Math.min(maxCols, Math.max(1, Math.ceil(agents.length / maxRows)));
  const capacity = cols * maxRows;
  const shown = agents.slice(0, capacity);
  const rows = Math.max(1, Math.ceil(shown.length / cols));
  const pitchX = cols > 1 ? (area.w - DESK_W) / (cols - 1) : 0;
  const pitchY = rows > 1 ? (area.d - DESK_D) / (rows - 1) : 0;
  const seats = shown.map((agent, i) => {
    const deskX = area.x + (i % cols) * pitchX;
    const deskY = area.y + Math.floor(i / cols) * pitchY;
    return { agent, deskX, deskY, x: deskX + DESK_W / 2, y: deskY - 0.9, index: i };
  });
  return { seats, overflow: agents.length - shown.length };
}

/** A stable, repeatable look per agent — same person, same face, every render. */
function variantOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 9973;
  return h;
}

const SUITS = ["#1a2233", "#212a3f", "#2a2438", "#1c2a2e"];

/** Is anything actually happening? Only a running turn animates. */
export const isLively = (s: FloorState) => s === "WORKING";

export type Sprite = { depth: number; el: ReactNode };

export function deskSprites(dept: DeptId, seats: Seat[], color: string, reduced: boolean): Sprite[] {
  const area = AREAS[dept];
  const out: Sprite[] = [];
  for (const s of seats) {
    const v = variantOf(s.agent.id);
    out.push({ depth: s.x + s.y - 0.6, el: <ChairBack key={`cb-${s.agent.id}`} x={s.x} y={s.y} /> });
    out.push({
      depth: s.x + s.y,
      el: (
        <AgentFigure
          key={`ag-${s.agent.id}`}
          x={s.x}
          y={s.y}
          color={color}
          seated
          suit={SUITS[v % SUITS.length]}
          variant={v}
          headset={area?.headset}
          idle={!reduced && isLively(s.agent.state)}
          delay={(s.index * 0.37) % 2}
        />
      ),
    });
    out.push({
      depth: s.deskX + DESK_W / 2 + s.deskY + DESK_D / 2,
      el: (
        <Desk
          key={`dk-${s.agent.id}`}
          x={s.deskX}
          y={s.deskY}
          w={DESK_W}
          d={DESK_D}
          screenColor={color}
          monitors={area?.monitors ?? 1}
          delay={reduced || !isLively(s.agent.state) ? 0 : (s.index * 0.61) % 3}
        />
      ),
    });
  }
  return out;
}

/** Screen position of a seat, for the HTML layer that handles clicks. */
export function seatPoint(seat: Seat): [number, number] {
  return iso(seat.x, seat.y, 0);
}
