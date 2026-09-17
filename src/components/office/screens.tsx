"use client";

import { motion } from "framer-motion";
import { rgba, shade, mulberry32 } from "@/lib/iso";

/** Content drawn inside a WallPlane. Local px: origin bottom-left, y negative upward. */

export function CodeScreen({ W, H, color }: { W: number; H: number; color: string }) {
  const rnd = mulberry32(42);
  const rows = Math.floor((H - 16) / 7);
  return (
    <g>
      <rect x={4} y={-H + 4} width={W - 8} height={H - 8} rx={2} fill="#0a1226" />
      <rect x={4} y={-H + 4} width={W - 8} height={7} fill={rgba(color, 0.18)} />
      {[0, 1, 2].map((i) => <circle key={i} cx={9 + i * 5} cy={-H + 7.5} r={1.3} fill={["#ff5c7a", "#f5b942", "#3dd68c"][i]} />)}
      {Array.from({ length: rows }).map((_, i) => {
        const indent = Math.floor(rnd() * 3) * 8;
        const segs = 1 + Math.floor(rnd() * 3);
        let cx = 10 + indent;
        return (
          <g key={i}>
            {Array.from({ length: segs }).map((__, j) => {
              const w = 10 + rnd() * 26;
              const c = [color, "#2fd4e6", "#c7d2ff", "#a78bfa", "#8b93a7"][Math.floor(rnd() * 5)];
              const el = <rect key={j} x={cx} y={-H + 16 + i * 7} width={w} height={2.6} rx={1.3} fill={c} opacity={0.75} />;
              cx += w + 4;
              return el;
            })}
          </g>
        );
      })}
      <motion.rect x={10} y={-H + 16 + rows * 7} width={6} height={2.6} fill={color}
        animate={{ opacity: [1, 0, 1] }} transition={{ duration: 1, repeat: Infinity }} />
    </g>
  );
}

export function KanbanBoard({ W, H, color }: { W: number; H: number; color: string }) {
  const rnd = mulberry32(7);
  const cols = 3;
  const cw = (W - 16) / cols;
  const notes = ["#ff8a3d", "#f5b942", "#3dd68c", "#4f8bff", "#a78bfa", "#2fd4e6"];
  return (
    <g>
      <rect x={4} y={-H + 4} width={W - 8} height={H - 8} rx={2} fill="#f2f4f8" opacity={0.92} />
      {Array.from({ length: cols }).map((_, c) => {
        const x0 = 8 + c * cw;
        const n = 2 + Math.floor(rnd() * 3);
        return (
          <g key={c}>
            <rect x={x0} y={-H + 9} width={cw - 6} height={4} rx={1} fill={c === 1 ? color : "#c9d0de"} opacity={0.9} />
            {Array.from({ length: n }).map((__, i) => (
              <g key={i} transform={`rotate(${(rnd() - 0.5) * 6}, ${x0 + 4}, ${-H + 17 + i * 11})`}>
                <rect x={x0 + 1} y={-H + 16 + i * 11} width={cw - 9} height={8} rx={1} fill={notes[Math.floor(rnd() * notes.length)]} opacity={0.85} />
                <rect x={x0 + 3} y={-H + 18.5 + i * 11} width={(cw - 9) * 0.6} height={1.2} fill="rgba(0,0,0,0.35)" />
                <rect x={x0 + 3} y={-H + 21 + i * 11} width={(cw - 9) * 0.4} height={1.2} fill="rgba(0,0,0,0.25)" />
              </g>
            ))}
          </g>
        );
      })}
    </g>
  );
}

export function BarChartScreen({ W, H, color, title }: { W: number; H: number; color: string; title?: string }) {
  const rnd = mulberry32(11);
  const n = 9;
  const bw = (W - 24) / n;
  return (
    <g>
      <rect x={4} y={-H + 4} width={W - 8} height={H - 8} rx={2} fill="#0b1224" />
      {title && <text x={10} y={-H + 14} fontSize={7} fill="#c7d2ff" fontWeight={600} fontFamily="var(--font-geist-sans)">{title}</text>}
      {Array.from({ length: n }).map((_, i) => {
        const h = (H - 34) * (0.3 + (i / n) * 0.55 + rnd() * 0.15);
        return (
          <motion.rect key={i} x={12 + i * bw} y={-8 - h} width={bw - 3} height={h} rx={1} fill={i === n - 1 ? color : rgba(color, 0.45)}
            style={{ originX: 0.5, originY: 1 }} animate={{ scaleY: [1, 0.92, 1] }} transition={{ duration: 4, repeat: Infinity, delay: i * 0.2 }} />
        );
      })}
      <polyline
        points={Array.from({ length: n }).map((_, i) => `${12 + i * bw + bw / 2},${-12 - (H - 34) * (0.35 + (i / n) * 0.5)}`).join(" ")}
        fill="none" stroke="#2fd4e6" strokeWidth={1.2} strokeLinejoin="round"
      />
    </g>
  );
}

export function FunnelScreen({ W, H, color, title }: { W: number; H: number; color: string; title?: string }) {
  const stages = [["Leads", 1], ["Qualified", 0.74], ["Proposal", 0.52], ["Negotiation", 0.33], ["Won", 0.18]] as const;
  const rowH = (H - 20) / stages.length;
  return (
    <g>
      <rect x={4} y={-H + 4} width={W - 8} height={H - 8} rx={2} fill="#0b1224" />
      <text x={10} y={-H + 13} fontSize={6.5} fill="#c7d2ff" fontWeight={600} fontFamily="var(--font-geist-sans)">{title ?? "Sales"}</text>
      {stages.map(([label, f], i) => (
        <g key={label}>
          <rect x={10} y={-H + 18 + i * rowH} width={(W - 20) * f} height={rowH - 3} rx={1.5} fill={i === 3 ? color : rgba(color, 0.35 + i * 0.1)} />
          <text x={12} y={-H + 18 + i * rowH + rowH * 0.62} fontSize={5} fill="#0b1224" fontWeight={600} fontFamily="var(--font-geist-sans)">{label}</text>
        </g>
      ))}
    </g>
  );
}

export function TicketsScreen({ W, H, color, title }: { W: number; H: number; color: string; title?: string }) {
  const rows = Math.floor((H - 22) / 9);
  const st = ["#3dd68c", "#3dd68c", color, "#f5b942", "#3dd68c", "#ff5c7a"];
  return (
    <g>
      <rect x={4} y={-H + 4} width={W - 8} height={H - 8} rx={2} fill="#0b1224" />
      <text x={10} y={-H + 13} fontSize={6.5} fill="#c7d2ff" fontWeight={600} fontFamily="var(--font-geist-sans)">{title ?? "Support"}</text>
      {Array.from({ length: rows }).map((_, i) => (
        <g key={i}>
          <rect x={10} y={-H + 18 + i * 9} width={W - 20} height={7} rx={1.5} fill="rgba(255,255,255,0.05)" />
          <motion.circle cx={15} cy={-H + 21.5 + i * 9} r={1.8} fill={st[i % st.length]}
            animate={i === 2 ? { opacity: [1, 0.3, 1] } : undefined} transition={{ duration: 1.4, repeat: Infinity }} />
          <rect x={21} y={-H + 20.4 + i * 9} width={(W - 40) * (0.4 + ((i * 37) % 50) / 100)} height={2.2} rx={1.1} fill="#8b93a7" opacity={0.8} />
          <rect x={W - 26} y={-H + 20.4 + i * 9} width={12} height={2.2} rx={1.1} fill={rgba(st[i % st.length], 0.6)} />
        </g>
      ))}
    </g>
  );
}

/**
 * The meeting room's screen.
 *
 * Nexora does not run meetings, so this is a dark screen with the room's
 * name on it — not a live agenda for a meeting that never happened.
 */
export function MeetingScreen({ W, H, color, lines }: { W: number; H: number; color: string; lines?: string[] }) {
  const body = lines ?? ["Meeting room", "Free"];
  return (
    <g>
      <rect x={4} y={-H + 4} width={W - 8} height={H - 8} rx={2} fill="#0b1224" />
      <rect x={4} y={-H + 4} width={W - 8} height={H - 8} rx={2} fill={`url(#meetGrad)`} opacity={0.2} />
      <text x={12} y={-H + 17} fontSize={7.5} fill="#e8ecf8" fontWeight={700} fontFamily="var(--font-geist-sans)">{body[0]}</text>
      {body.slice(1).map((l, i) => (
        <text key={i} x={12} y={-H + 28 + i * 9} fontSize={5.5} fill="#aab2c5" fontFamily="var(--font-geist-sans)">{l}</text>
      ))}
      <rect x={12} y={-H + H - 16} width={(W - 24) * 0.35} height={2} rx={1} fill={rgba(color, 0.5)} />
    </g>
  );
}

export function LogoSign({ W, H }: { W: number; H: number }) {
  return (
    <g>
      <rect x={0} y={-H} width={W} height={H} rx={2} fill="url(#signGrad)" />
      <rect x={0} y={-H} width={W} height={1.2} fill="rgba(255,255,255,0.35)" />
      <g transform={`translate(${W * 0.12}, ${-H * 0.66})`}>
        <path d="M0 14V-6l14 20V-6" stroke="#8fa3ff" strokeWidth={4.5} fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ filter: "url(#softglow)" }} />
      </g>
      <text x={W * 0.22} y={-H * 0.5} fontSize={H * 0.36} fill="#eef1ff" fontWeight={700} letterSpacing={-0.5} fontFamily="var(--font-geist-sans)">Nexora</text>
      <text x={W * 0.22} y={-H * 0.22} fontSize={H * 0.13} fill="#aab2c5" fontFamily="var(--font-geist-sans)">People · Ideas · AI · A brighter tomorrow</text>
    </g>
  );
}

export function TextScreen({ W, H, color, lines }: { W: number; H: number; color: string; lines: string[] }) {
  return (
    <g>
      <rect x={4} y={-H + 4} width={W - 8} height={H - 8} rx={2} fill="#0b1224" />
      <rect x={4} y={-H + 4} width={3} height={H - 8} fill={color} />
      {lines.map((l, i) => (
        <text key={i} x={12} y={-H + 15 + i * 10} fontSize={i === 0 ? 7.5 : 5.5} fill={i === 0 ? "#f4f6fb" : "#aab2c5"} fontWeight={i === 0 ? 700 : 400} fontFamily="var(--font-geist-sans)">{l}</text>
      ))}
      {[0.82, 0.64, 0.71].map((f, i) => (
        <g key={i}>
          <rect x={12} y={-16 + i * 4} width={W - 24} height={2} rx={1} fill="rgba(255,255,255,0.08)" />
          <rect x={12} y={-16 + i * 4} width={(W - 24) * f} height={2} rx={1} fill={shade(color, i * 0.15)} />
        </g>
      ))}
    </g>
  );
}

export function Shelves({ W, H }: { W: number; H: number }) {
  const rnd = mulberry32(99);
  const rows = 3;
  return (
    <g>
      <rect x={0} y={-H} width={W} height={H} rx={1} fill="#1b2133" />
      {Array.from({ length: rows }).map((_, r) => {
        const y = -H + 6 + r * (H / rows);
        let x = 4;
        const books: React.ReactNode[] = [];
        while (x < W - 8) {
          const w = 2 + rnd() * 3;
          const h = 8 + rnd() * 5;
          books.push(<rect key={x} x={x} y={y + (H / rows) - 4 - h} width={w} height={h} fill={["#4f8bff", "#a78bfa", "#f5b942", "#2fd4e6", "#ff8a3d", "#c7d2ff"][Math.floor(rnd() * 6)]} opacity={0.8} />);
          x += w + 1;
        }
        return (
          <g key={r}>
            {books}
            <rect x={2} y={y + H / rows - 4} width={W - 4} height={1.5} fill="#2a3448" />
          </g>
        );
      })}
    </g>
  );
}
