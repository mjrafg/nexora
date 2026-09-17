import { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const control =
  "w-full rounded-lg border border-line bg-white/[0.04] px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-brand/60 focus:bg-white/[0.06] disabled:opacity-50";

export function Field({
  label,
  hint,
  children,
  className,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-[11.5px] font-medium text-ink-2">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] text-ink-3">{hint}</p>}
    </div>
  );
}

/** dir="auto" so a value typed in a right-to-left language reads correctly while it is entered. */
export function Input({ className, dir = "auto", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input dir={dir} className={cn(control, "h-9", className)} {...rest} />;
}

export function Textarea({ className, dir = "auto", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea dir={dir} className={cn(control, "py-2 leading-relaxed", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={cn(control, "h-9 appearance-none pr-8", className)} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-white/[0.02] px-3 py-2 hover:bg-white/[0.04]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 accent-[#6d7cff]"
      />
      <span className="min-w-0">
        <span className="block text-[12.5px] text-ink">{label}</span>
        {description && <span className="block text-[11px] text-ink-3">{description}</span>}
      </span>
    </label>
  );
}

export function TagInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  return (
    <div className={cn(control, "flex min-h-9 flex-wrap items-center gap-1.5 py-1.5")}>
      {value.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-md bg-brand/15 px-1.5 py-0.5 text-[11px] text-[#aab4ff]">
          {t}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} className="text-ink-3 hover:text-ink" aria-label={`Remove ${t}`}>
            ×
          </button>
        </span>
      ))}
      <input
        className="min-w-[120px] flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-3"
        placeholder={placeholder}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if ((e.key === "Enter" || e.key === ",") && el.value.trim()) {
            e.preventDefault();
            const v = el.value.trim().replace(/,$/, "");
            if (v && !value.includes(v)) onChange([...value, v]);
            el.value = "";
          } else if (e.key === "Backspace" && !el.value && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={(e) => {
          const v = e.currentTarget.value.trim();
          if (v && !value.includes(v)) onChange([...value, v]);
          e.currentTarget.value = "";
        }}
      />
    </div>
  );
}

/**
 * Why a save button is disabled.
 *
 * A dead button with no explanation is a dead end: the owner reads the form,
 * sees nothing wrong, and has no way to find the one field that is short. Every
 * dialog that gates its save on validation says here exactly what is still
 * missing.
 */
export function Missing({ problems, className }: { problems: string[]; className?: string }) {
  if (!problems.length) return null;
  return (
    <p className={cn("text-[11px] leading-snug text-warning", className)}>
      Still needed: {problems.join(" · ")}
    </p>
  );
}

/**
 * Descriptions are what an agent reads to pick the right credential or payment
 * method, so they have a minimum length. Say how much is left rather than
 * failing silently at the button.
 */
export function describeShortfall(label: string, value: string, min: number): string | null {
  const n = value.trim().length;
  if (n >= min) return null;
  const left = min - n;
  return n === 0 ? `${label}` : `${label} (${left} more character${left === 1 ? "" : "s"})`;
}

/** Live counter shown under a field with a minimum length. */
export function CharCount({ value, min }: { value: string; min: number }) {
  const n = value.trim().length;
  return (
    <span className={cn("num", n >= min ? "text-ink-3" : "text-warning")}>
      {n}/{min}
    </span>
  );
}
