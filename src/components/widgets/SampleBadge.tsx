"use client";

/**
 * This panel is a placeholder.
 *
 * Nexora does not hold the company's revenue, KPIs or delivery figures, so
 * what is drawn here is sample data for the layout. Saying so is the only
 * honest option: an unlabelled chart of invented numbers is worse than no
 * chart at all.
 */
export function SampleBadge({ className }: { className?: string }) {
  return (
    <span
      title="Sample data — Nexora does not hold these figures yet"
      className={`rounded-md border border-line px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide text-ink-3 ${className ?? ""}`}
    >
      sample data
    </span>
  );
}
