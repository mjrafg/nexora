import { DollarSign } from "lucide-react";
import { revenueSnapshot as r } from "@/lib/mock-data";
import { Panel } from "@/components/ui/Panel";
import { SampleBadge } from "./SampleBadge";

export function RevenueSnapshot() {
  const W = 260, H = 96;
  const max = Math.max(...r.series), min = Math.min(...r.series) * 0.85;
  const pts = r.series.map((v, i) => [(i / (r.series.length - 1)) * (W - 8) + 4, H - 14 - ((v - min) / (max - min)) * (H - 24)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <Panel title="Revenue Snapshot" subtitle="Trailing 12 months" icon={<DollarSign className="h-4 w-4 text-operations" strokeWidth={1.8} />} action={<SampleBadge />}>
      <div className="grid grid-cols-3 gap-2">
        {[["MRR", r.mrr], ["ARR", r.arr], ["Growth", r.growth]].map(([l, v]) => (
          <div key={l} className="rounded-lg bg-white/[0.03] px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-wider text-ink-3">{l}</div>
            <div className={`text-[15px] font-semibold num ${l === "Growth" ? "text-operations" : ""}`}>{v}</div>
          </div>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full">
        <defs>
          <linearGradient id="revfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#6d7cff" stopOpacity="0.4" />
            <stop offset="1" stopColor="#6d7cff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={4} x2={W - 4} y1={H - 14 - f * (H - 24)} y2={H - 14 - f * (H - 24)} stroke="rgba(255,255,255,0.06)" />)}
        <path d={`${d} L${W - 4},${H - 12} L4,${H - 12} Z`} fill="url(#revfill)" />
        <path d={d} fill="none" stroke="#8fa3ff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {pts.map(([x, y], i) => i % 3 === 2 && <circle key={i} cx={x} cy={y} r={2.5} fill="#0b1220" stroke="#8fa3ff" strokeWidth={1.5} />)}
        {r.months.map((m, i) => i % 2 === 0 && <text key={m} x={pts[i][0]} y={H - 2} fontSize={8} fill="#6f7890" textAnchor="middle" fontFamily="var(--font-geist-sans)">{m}</text>)}
      </svg>
    </Panel>
  );
}
