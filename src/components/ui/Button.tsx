import { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "ghost" | "success" | "danger" | "outline";

export function Button({
  variant = "ghost",
  size = "sm",
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "xs" | "sm" | "md"; children: ReactNode }) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap";
  const sizes = { xs: "h-7 px-2.5 text-[11px]", sm: "h-8 px-3 text-[12px]", md: "h-9 px-4 text-[13px]" };
  const variants: Record<Variant, string> = {
    primary:
      "bg-gradient-to-b from-[#7d8bff] to-[#5a6bff] text-white shadow-[0_8px_20px_-8px_rgba(109,124,255,0.8),inset_0_1px_0_rgba(255,255,255,0.25)] hover:brightness-110",
    ghost: "bg-surface-2 text-ink-2 hover:text-ink hover:bg-white/10 border border-line",
    outline: "bg-transparent text-ink-2 hover:text-ink border border-line-2 hover:bg-white/5",
    success: "bg-[rgba(61,214,140,0.14)] text-[#5fe3a3] border border-[rgba(61,214,140,0.3)] hover:bg-[rgba(61,214,140,0.22)]",
    danger: "bg-[rgba(255,92,122,0.12)] text-[#ff7d95] border border-[rgba(255,92,122,0.28)] hover:bg-[rgba(255,92,122,0.2)]",
  };
  return (
    <button className={cn(base, sizes[size], variants[variant], className)} {...rest}>
      {children}
    </button>
  );
}
