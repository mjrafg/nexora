"use client";

import { ReactNode } from "react";
import { motion } from "framer-motion";
import { iso, poly, S, shade, rgba } from "@/lib/iso";

/* ----------------------------- plane transforms ---------------------------- */
/** Vertical plane along the x axis (constant y). Local px: (u*S, -v*S). */
export function planeY(x: number, y: number, z: number) {
  const [sx, sy] = iso(x, y, z);
  return `matrix(1,0.5,0,1,${sx},${sy})`;
}
/** Vertical plane along the y axis (constant x). u runs from y2 toward smaller y. */
export function planeX(x: number, y2: number, z: number) {
  const [sx, sy] = iso(x, y2, z);
  return `matrix(1,-0.5,0,1,${sx},${sy})`;
}
/** Floor plane. Local px: (u*S, v*S). */
export function planeFloor(x: number, y: number, z: number) {
  const [sx, sy] = iso(x, y, z);
  return `matrix(1,0.5,-1,0.5,${sx},${sy})`;
}

/* --------------------------------- IsoBox --------------------------------- */
export function IsoBox({
  x, y, z = 0, w, d, h, color, top, left, right, opacity = 1, stroke,
}: {
  x: number; y: number; z?: number; w: number; d: number; h: number;
  color: string; top?: string; left?: string; right?: string; opacity?: number; stroke?: string;
}) {
  const t = top ?? shade(color, 0.16);
  const l = left ?? color;
  const r = right ?? shade(color, -0.3);
  return (
    <g opacity={opacity}>
      <polygon points={poly([iso(x, y + d, z), iso(x + w, y + d, z), iso(x + w, y + d, z + h), iso(x, y + d, z + h)])} fill={l} />
      <polygon points={poly([iso(x + w, y, z), iso(x + w, y + d, z), iso(x + w, y + d, z + h), iso(x + w, y, z + h)])} fill={r} />
      <polygon
        points={poly([iso(x, y, z + h), iso(x + w, y, z + h), iso(x + w, y + d, z + h), iso(x, y + d, z + h)])}
        fill={t}
        stroke={stroke ?? "rgba(255,255,255,0.10)"}
        strokeWidth={0.6}
      />
    </g>
  );
}

/* -------------------------------- WallPlane ------------------------------- */
export function WallPlane({
  axis, at, from, to, z = 0, h, fill = "rgba(10,16,32,0.92)", stroke = "rgba(255,255,255,0.14)", children, rx = 2,
}: {
  axis: "x" | "y"; at: number; from: number; to: number; z?: number; h: number;
  fill?: string; stroke?: string; rx?: number;
  children?: (W: number, H: number) => ReactNode;
}) {
  const W = (to - from) * S;
  const H = h * S;
  const transform = axis === "y" ? planeY(from, at, z) : planeX(at, to, z);
  return (
    <g transform={transform}>
      <rect x={0} y={-H} width={W} height={H} rx={rx} fill={fill} stroke={stroke} strokeWidth={0.8} />
      {children?.(W, H)}
    </g>
  );
}

/* ---------------------------- Glass wall segment --------------------------- */
export function GlassWall({
  x1, y1, x2, y2, h, opacity = 1, tint = "#8fb0ff",
}: { x1: number; y1: number; x2: number; y2: number; h: number; opacity?: number; tint?: string }) {
  const a = iso(x1, y1, 0), b = iso(x2, y2, 0), c = iso(x2, y2, h), d = iso(x1, y1, h);
  const a2 = iso(x1, y1, 0.7), b2 = iso(x2, y2, 0.7);
  return (
    <g opacity={opacity}>
      <polygon points={poly([a, b, c, d])} fill={rgba(tint, 0.06)} stroke={rgba(tint, 0.28)} strokeWidth={0.7} />
      <polygon points={poly([a, b, b2, a2])} fill="rgba(12,18,34,0.7)" />
      <line x1={d[0]} y1={d[1]} x2={c[0]} y2={c[1]} stroke={rgba(tint, 0.55)} strokeWidth={1} />
    </g>
  );
}

/* ---------------------------------- Plant --------------------------------- */
export function Plant({ x, y, size = 1 }: { x: number; y: number; size?: number }) {
  const [cx, cy] = iso(x, y, 0);
  const s = size;
  return (
    <g>
      <ellipse cx={cx} cy={cy + 1} rx={6 * s} ry={2.5 * s} fill="rgba(0,0,0,0.35)" />
      <IsoBox x={x - 0.45 * s} y={y - 0.45 * s} w={0.9 * s} d={0.9 * s} h={0.9 * s} color="#2a3142" />
      <g transform={`translate(${cx}, ${cy - 11 * s})`}>
        <ellipse cx={-4 * s} cy={-2 * s} rx={5 * s} ry={4 * s} fill="#1f6b4a" />
        <ellipse cx={4 * s} cy={-3 * s} rx={5 * s} ry={4.5 * s} fill="#2a8a5d" />
        <ellipse cx={0} cy={-7 * s} rx={4.5 * s} ry={4 * s} fill="#37a771" />
        <ellipse cx={1 * s} cy={-4 * s} rx={2 * s} ry={1.4 * s} fill="rgba(255,255,255,0.15)" />
      </g>
    </g>
  );
}

/* ---------------------------------- Desk ---------------------------------- */
export function Desk({
  x, y, w = 3.2, d = 1.6, color, monitors = 1, screenColor, delay = 0, wood = false,
}: { x: number; y: number; w?: number; d?: number; color?: string; monitors?: number; screenColor: string; delay?: number; wood?: boolean }) {
  const c = color ?? (wood ? "#3a2f1d" : "#1c2436");
  const top = wood ? "#5a4a2c" : "#2a3448";
  const positions = monitors === 2 ? [x + w * 0.3, x + w * 0.68] : [x + w / 2];
  return (
    <g>
      <IsoBox x={x} y={y} w={w} d={d} h={1.25} color={c} top={top} />
      {positions.map((mx, i) => (
        <g key={i}>
          {/* stand */}
          <IsoBox x={mx - 0.15} y={y + d * 0.55} z={1.25} w={0.3} d={0.2} h={0.35} color="#0f1524" />
          {/* panel */}
          <IsoBox x={mx - 0.65} y={y + d * 0.55} z={1.6} w={1.3} d={0.12} h={0.85} color="#0b1020" top="#1b2334" />
          {/* glowing screen on the front face */}
          <motion.polygon
            points={poly([iso(mx - 0.58, y + d * 0.67, 1.66), iso(mx + 0.58, y + d * 0.67, 1.66), iso(mx + 0.58, y + d * 0.67, 2.39), iso(mx - 0.58, y + d * 0.67, 2.39)])}
            fill={screenColor}
            animate={{ opacity: [0.75, 1, 0.85, 1] }}
            transition={{ duration: 3.2, repeat: Infinity, delay, ease: "easeInOut" }}
            style={{ filter: "url(#softglow)" }}
          />
        </g>
      ))}
    </g>
  );
}

/* --------------------------------- Agent ---------------------------------- */
const SKIN = ["#f3d2b3", "#e6b791", "#c98f62", "#9c633f", "#6a4530"];
const HAIR = ["#1e1a1d", "#3b2417", "#7a4a22", "#d6b06a", "#2a2d3a", "#8c3b2a"];

export function AgentFigure({
  x, y, color, seated = false, facing = "front", suit, delay = 0, headset = false, idle = true, scale = 1, variant = 0,
}: {
  x: number; y: number; color: string; seated?: boolean; facing?: "front" | "back"; suit?: string;
  delay?: number; headset?: boolean; idle?: boolean; scale?: number; variant?: number;
}) {
  const [cx, cy] = iso(x, y, 0);
  return (
    <g transform={`translate(${cx}, ${cy}) scale(${scale})`}>
      <Figure color={color} seated={seated} facing={facing} suit={suit} delay={delay} headset={headset} idle={idle} variant={variant} />
    </g>
  );
}

/** A small human figure (~36px tall) drawn at its feet position (0,0). */
export function Figure({
  color, seated = false, facing = "front", suit = "#1a2233", delay = 0, headset = false, idle = true, walking = false, variant = 0,
}: {
  color: string; seated?: boolean; facing?: "front" | "back"; suit?: string; delay?: number; headset?: boolean;
  idle?: boolean; walking?: boolean; variant?: number;
}) {
  const skin = SKIN[variant % SKIN.length];
  const hair = HAIR[(variant * 5 + 1) % HAIR.length];
  const style = variant % 4; // 0 short, 1 bob, 2 bun, 3 long
  const lift = seated ? 7 : 0;
  const front = facing === "front";
  const trousers = shade(suit, -0.3);
  const legTr = { duration: 0.55, repeat: Infinity, ease: "easeInOut" as const };
  const bodyTr = idle ? { duration: 2.4 + (delay % 1.3), repeat: Infinity, delay, ease: "easeInOut" as const } : undefined;
  return (
    <g>
      <ellipse cx={0} cy={1} rx={6.5} ry={2.6} fill="rgba(0,0,0,0.38)" />
      {!seated && (
        <g>
          <motion.g style={{ originX: 0.5, originY: 0 }} animate={walking ? { rotate: [-18, 18, -18] } : { rotate: 0 }} transition={walking ? legTr : { duration: 0.3 }}>
            <rect x={-4.4} y={-12} width={3.7} height={12} rx={1.6} fill={trousers} />
            <rect x={-4.8} y={-1.6} width={4.4} height={2} rx={0.8} fill="#0b0e17" />
          </motion.g>
          <motion.g style={{ originX: 0.5, originY: 0 }} animate={walking ? { rotate: [18, -18, 18] } : { rotate: 0 }} transition={walking ? legTr : { duration: 0.3 }}>
            <rect x={0.7} y={-12} width={3.7} height={12} rx={1.6} fill={trousers} />
            <rect x={0.4} y={-1.6} width={4.4} height={2} rx={0.8} fill="#0b0e17" />
          </motion.g>
        </g>
      )}
      <motion.g animate={walking ? { y: [0, -1.2, 0] } : idle ? { y: [0, -0.8, 0] } : undefined} transition={walking ? { duration: 0.55, repeat: Infinity, ease: "easeInOut" } : bodyTr}>
        {/* long hair (back) */}
        {style === 3 && <rect x={-5.3} y={-36 + lift} width={10.6} height={15} rx={4} fill={hair} />}
        {/* torso */}
        <rect x={-6.2} y={-25 + lift} width={12.4} height={13.5} rx={3.5} fill={`url(#suit-${suit.slice(1)})`} />
        {front && (
          <>
            <path d={`M-2.6 ${-25 + lift} L0 ${-20.4 + lift} L2.6 ${-25 + lift} Z`} fill="#eef1f7" />
            <path d={`M-2.6 ${-25 + lift} L0 ${-20.4 + lift} M2.6 ${-25 + lift} L0 ${-20.4 + lift}`} stroke={shade(suit, -0.35)} strokeWidth={0.6} fill="none" />
            <rect x={2.9} y={-21.6 + lift} width={2.2} height={3} rx={0.6} fill={color} />
          </>
        )}
        {/* arms */}
        <motion.g style={{ originX: 0.5, originY: 0 }} animate={walking ? { rotate: [14, -14, 14] } : { rotate: 0 }} transition={walking ? legTr : { duration: 0.3 }}>
          <rect x={-8.9} y={-24.6 + lift} width={3.1} height={11} rx={1.5} fill={suit} />
          <circle cx={-7.35} cy={-13.2 + lift} r={1.7} fill={skin} />
        </motion.g>
        <motion.g style={{ originX: 0.5, originY: 0 }} animate={walking ? { rotate: [-14, 14, -14] } : { rotate: 0 }} transition={walking ? legTr : { duration: 0.3 }}>
          <rect x={5.8} y={-24.6 + lift} width={3.1} height={11} rx={1.5} fill={suit} />
          <circle cx={7.35} cy={-13.2 + lift} r={1.7} fill={skin} />
        </motion.g>
        {/* neck + head */}
        <rect x={-1.7} y={-27.6 + lift} width={3.4} height={3.4} fill={shade(skin, -0.12)} />
        {style === 1 && <rect x={-5.6} y={-36.8 + lift} width={11.2} height={10.6} rx={3.6} fill={hair} />}
        <rect x={-4.5} y={-36.4 + lift} width={9} height={10.2} rx={4} fill={skin} />
        {front ? (
          <>
            <path
              d={`M-4.6 ${-31.6 + lift} C-4.6 ${-35.6 + lift} -2.8 ${-36.9 + lift} 0 ${-36.9 + lift} C2.8 ${-36.9 + lift} 4.6 ${-35.6 + lift} 4.6 ${-31.6 + lift} L4.6 ${-30.8 + lift} C3.2 ${-32.6 + lift} 1.6 ${-33.1 + lift} 0.2 ${-32.9 + lift} C-1.6 ${-32.7 + lift} -3.2 ${-31.8 + lift} -4.6 ${-30.2 + lift} Z`}
              fill={hair}
            />
            <circle cx={-1.7} cy={-30.1 + lift} r={0.75} fill="#1f1610" />
            <circle cx={1.7} cy={-30.1 + lift} r={0.75} fill="#1f1610" />
            <path d={`M-1.1 ${-28 + lift} Q0 ${-27.2 + lift} 1.1 ${-28 + lift}`} stroke="#a85f4d" strokeWidth={0.6} fill="none" strokeLinecap="round" />
          </>
        ) : (
          <rect x={-4.7} y={-36.6 + lift} width={9.4} height={style === 0 ? 7.5 : 9.5} rx={4} fill={hair} />
        )}
        {style === 2 && <circle cx={0} cy={-37.6 + lift} r={2.2} fill={hair} />}
        {headset && (
          <g>
            <path d={`M-5.2 ${-31 + lift} a5.2 5.2 0 0 1 10.4 0`} stroke={color} strokeWidth={1.2} fill="none" />
            <circle cx={-5} cy={-30 + lift} r={1.2} fill={color} />
            {front && <path d={`M-5 ${-29 + lift} Q-4.6 ${-26.6 + lift} -2.4 ${-27.2 + lift}`} stroke={color} strokeWidth={0.7} fill="none" />}
          </g>
        )}
      </motion.g>
    </g>
  );
}

/* --------------------------------- Chair ---------------------------------- */
export function ChairBack({ x, y, color = "#242c3f" }: { x: number; y: number; color?: string }) {
  return <IsoBox x={x - 0.5} y={y - 0.55} w={1} d={0.18} h={1.5} color={color} top={shade(color, 0.2)} />;
}

/* ----------------------------- Conference table ---------------------------- */
export function ConferenceTable({ cx, cy, rx, ry, h = 1.1 }: { cx: number; cy: number; rx: number; ry: number; h?: number }) {
  return (
    <g>
      <g transform={planeFloor(cx, cy, 0)}>
        <ellipse cx={0} cy={0} rx={rx * S} ry={ry * S} fill="rgba(0,0,0,0.35)" />
      </g>
      {/* pedestal */}
      <IsoBox x={cx - 1.2} y={cy - 0.6} w={2.4} d={1.2} h={h - 0.2} color="#161d2e" />
      {/* side (thickness) */}
      <g transform={planeFloor(cx, cy, h - 0.22)}>
        <ellipse cx={0} cy={0} rx={rx * S} ry={ry * S} fill="#222b45" />
      </g>
      <g transform={planeFloor(cx, cy, h)}>
        <ellipse cx={0} cy={0} rx={rx * S} ry={ry * S} fill="url(#tableTop)" stroke="rgba(255,255,255,0.12)" strokeWidth={0.8} />
        <ellipse cx={0} cy={0} rx={rx * S * 0.55} ry={ry * S * 0.55} fill="none" stroke="rgba(129,140,248,0.25)" strokeWidth={0.8} />
      </g>
    </g>
  );
}
