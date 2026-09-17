"use client";

import { CATEGORY_LABELS, type PromptCategory } from "@/lib/prompts/types";
import { cn } from "@/lib/utils";

const TINT: Record<PromptCategory, string> = {
  executive: "#f5b942",
  management: "#8b9cff",
  task: "#4f8bff",
  engineering: "#2fd4e6",
  capability: "#3dd68c",
  browser: "#a78bfa",
  credentials: "#f5b942",
  payments: "#3dd68c",
  company: "#6d7cff",
  runtime: "#ff8a3d",
  project: "#2fd4e6",
  other: "#7c8699",
};

export const categoryColor = (c: PromptCategory) => TINT[c] ?? TINT.other;

export function CategoryTag({ category, className }: { category: PromptCategory; className?: string }) {
  const c = categoryColor(category);
  return (
    <span
      className={cn("shrink-0 rounded-md border px-1.5 py-px text-[10px] font-medium", className)}
      style={{ borderColor: `${c}55`, background: `${c}14`, color: c }}
    >
      {CATEGORY_LABELS[category]}
    </span>
  );
}

/** Built-in, customized, or customized from a built-in that has since moved on. */
export function StatusTag({ customized, updateAvailable }: { customized: boolean; updateAvailable?: boolean }) {
  if (updateAvailable) {
    return (
      <span className="shrink-0 rounded-md border border-warning/45 bg-warning/[0.12] px-1.5 py-px text-[10px] font-medium text-warning" title="You customized an older built-in version; a newer default exists">
        update available
      </span>
    );
  }
  if (customized) {
    return <span className="shrink-0 rounded-md border border-brand/45 bg-brand/[0.12] px-1.5 py-px text-[10px] font-medium text-brand">customized</span>;
  }
  return <span className="shrink-0 rounded-md border border-line px-1.5 py-px text-[10px] text-ink-3">built-in</span>;
}

export function when(iso?: string): string {
  if (!iso) return "";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d} d ago` : new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

/* ---------------------------------------------------------------- diff */

type Row = { kind: "same" | "add" | "remove"; text: string };

/**
 * A plain line diff, enough to see what an edit or an import changes.
 * Longest-common-subsequence over lines; prompts are short enough that the
 * quadratic table costs nothing and the result is easy to read.
 */
export function lineDiff(before: string, after: string): Row[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length, m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const rows: Row[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { rows.push({ kind: "remove", text: a[i] }); i++; }
    else { rows.push({ kind: "add", text: b[j] }); j++; }
  }
  while (i < n) rows.push({ kind: "remove", text: a[i++] });
  while (j < m) rows.push({ kind: "add", text: b[j++] });
  return rows;
}

export function DiffView({ before, after, labels }: { before: string; after: string; labels?: [string, string] }) {
  const rows = lineDiff(before, after);
  const changed = rows.some((r) => r.kind !== "same");
  if (!changed) return <p className="px-3 py-6 text-center text-[12px] text-ink-3">No difference — the two texts are identical.</p>;
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="flex items-center gap-3 border-b border-line bg-white/[0.02] px-3 py-1.5 text-[10.5px] uppercase tracking-[0.12em] text-ink-3">
        <span className="text-[#ff8ea3]">− {labels?.[0] ?? "before"}</span>
        <span className="text-[#5fe3a3]">+ {labels?.[1] ?? "after"}</span>
      </div>
      <div className="max-h-[52vh] overflow-auto">
        <pre className="min-w-full text-[12px] leading-[1.6]">
          {rows.map((r, k) => (
            <div
              key={k}
              className={cn(
                "flex gap-2 px-3 font-mono whitespace-pre-wrap break-words",
                r.kind === "add" && "bg-[#3dd68c]/[0.10] text-[#8ff0bd]",
                r.kind === "remove" && "bg-[#ff5c7a]/[0.10] text-[#ffa8b9]",
                r.kind === "same" && "text-ink-3"
              )}
            >
              <span className="select-none opacity-60">{r.kind === "add" ? "+" : r.kind === "remove" ? "−" : " "}</span>
              <span className="min-w-0 flex-1">{r.text || " "}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
