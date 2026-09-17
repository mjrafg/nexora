import { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Panel({
  title,
  subtitle,
  action,
  children,
  className,
  bodyClassName,
  icon,
  elevated,
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** the panel floats above the page (a dialog): opaque, so nothing reads through it */
  elevated?: boolean;
}) {
  return (
    <section className={cn(elevated ? "glass-strong shadow-2xl shadow-black/60" : "glass", "rounded-2xl", className)}>
      {title && (
        <header className="flex items-start justify-between gap-3 px-4 pt-4 pb-2">
          <div className="flex items-center gap-2 min-w-0">
            {icon && <span className="text-ink-2">{icon}</span>}
            <div className="min-w-0">
              <h3 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h3>
              {subtitle && <p className="text-[11px] text-ink-3 truncate">{subtitle}</p>}
            </div>
          </div>
          {action}
        </header>
      )}
      <div className={cn("px-4 pb-4", !title && "pt-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function PanelLink({ children }: { children: ReactNode }) {
  return (
    <button className="text-[11px] font-medium text-brand hover:text-ink transition-colors inline-flex items-center gap-1">
      {children}
      <span aria-hidden>→</span>
    </button>
  );
}
