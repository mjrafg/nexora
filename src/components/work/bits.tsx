"use client";

import { CheckCircle2, CircleDashed, Hand, Loader2, OctagonX, type LucideIcon } from "lucide-react";
import type { TaskPriority, TaskStatus } from "@/lib/client-api";
import { cn } from "@/lib/utils";

export const STATUS_META: Record<TaskStatus, { label: string; icon: LucideIcon; tint: string; ring: string; text: string }> = {
  TODO: { label: "To do", icon: CircleDashed, tint: "bg-white/[0.06]", ring: "border-line-2", text: "text-ink-3" },
  IN_PROGRESS: { label: "In progress", icon: Loader2, tint: "bg-brand/15", ring: "border-brand/40", text: "text-brand" },
  BLOCKED: { label: "Blocked", icon: Hand, tint: "bg-warning/15", ring: "border-warning/40", text: "text-warning" },
  DONE: { label: "Done", icon: CheckCircle2, tint: "bg-[#3dd68c]/14", ring: "border-[#3dd68c]/35", text: "text-[#5fe3a3]" },
  CANCELLED: { label: "Cancelled", icon: OctagonX, tint: "bg-white/[0.04]", ring: "border-line", text: "text-ink-3" },
};

/** The status of a piece of work, as one calm glyph. */
export function StatusDot({ status, size = 26 }: { status: TaskStatus; size?: number }) {
  const m = STATUS_META[status];
  const Icon = m.icon;
  return (
    <span
      className={cn("grid shrink-0 place-items-center rounded-full border", m.tint, m.ring, m.text)}
      style={{ width: size, height: size }}
      title={m.label}
    >
      <Icon className={cn(status === "IN_PROGRESS" && "animate-spin")} style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={2} />
    </span>
  );
}

/** Priority is only worth saying when it is not the default. */
export function PriorityTag({ priority, className }: { priority: TaskPriority; className?: string }) {
  if (priority === "NORMAL") return null;
  const tone =
    priority === "CRITICAL" ? "border-[#ff5c7a]/40 bg-[#ff5c7a]/12 text-[#ff8ea3]"
    : priority === "HIGH" ? "border-warning/40 bg-warning/10 text-warning"
    : "border-line text-ink-3";
  return (
    <span className={cn("rounded-md border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide", tone, className)}>
      {priority.toLowerCase()}
    </span>
  );
}

/** A folder name suggested from a task title: "Fix the login issue" → "fix-the-login-issue". */
export function folderNameFrom(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

export function when(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d} d ago` : new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}
