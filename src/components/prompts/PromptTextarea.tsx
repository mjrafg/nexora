"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A text editor for prompts, not a form field.
 *
 * Line numbers that stay in step with the text, a monospace measure wide
 * enough to read a paragraph without wrapping into soup, ⌘/Ctrl+S to save,
 * and an honest character count. It is deliberately plain about what it is:
 * these are instructions to a model, not code, so there is nothing to
 * syntax-highlight — but they are long, and the gutter is what makes a long
 * text navigable.
 */
export function PromptTextarea({
  value, onChange, onSave, readOnly = false, placeholders, minRows = 18,
}: {
  value: string;
  onChange?: (v: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  placeholders?: string[];
  minRows?: number;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const lines = value.split("\n").length;

  // the gutter follows the text rather than scrolling on its own
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const sync = () => { if (gutter.current) gutter.current.scrollTop = el.scrollTop; };
    el.addEventListener("scroll", sync);
    return () => el.removeEventListener("scroll", sync);
  }, []);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-[#0b1020] transition-colors",
        focused ? "border-brand/50" : "border-line"
      )}
    >
      <div className="flex max-h-[58vh] min-h-0">
        <div
          ref={gutter}
          aria-hidden
          className="shrink-0 select-none overflow-hidden border-e border-line bg-white/[0.015] py-3 text-end font-mono text-[11.5px] leading-[1.7] text-ink-3/60"
          style={{ width: `${Math.max(2, String(lines).length) + 1.6}ch` }}
        >
          {Array.from({ length: lines }, (_, i) => (
            <div key={i} className="pe-2">{i + 1}</div>
          ))}
        </div>
        <textarea
          ref={area}
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); onSave?.(); }
          }}
          rows={minRows}
          className="min-h-0 flex-1 resize-none bg-transparent px-3 py-3 font-mono text-[12.5px] leading-[1.7] text-ink outline-none placeholder:text-ink-3"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-white/[0.02] px-3 py-1.5 text-[10.5px] text-ink-3">
        <span className="num">{value.length.toLocaleString()} characters · {lines} lines</span>
        {placeholders?.length ? (
          <span className="flex flex-wrap items-center gap-1">
            Nexora fills in:
            {placeholders.map((p) => (
              <code key={p} className="rounded border border-line bg-white/[0.04] px-1 py-px font-mono text-[10px] text-ink-2">{`{{${p}}}`}</code>
            ))}
          </span>
        ) : null}
        {!readOnly && <span className="ms-auto hidden sm:inline">⌘S to save</span>}
      </div>
    </div>
  );
}
