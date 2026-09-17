import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { rgba } from "@/lib/iso";

export function Badge({
  children,
  color = "#aab2c5",
  className,
  dot,
}: {
  children: ReactNode;
  color?: string;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium tracking-wide whitespace-nowrap",
        className
      )}
      style={{ background: rgba(color, 0.12), color, border: `1px solid ${rgba(color, 0.25)}` }}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
      {children}
    </span>
  );
}

export const riskColor = { low: "#3dd68c", medium: "#f5b942", high: "#ff5c7a" } as const;
