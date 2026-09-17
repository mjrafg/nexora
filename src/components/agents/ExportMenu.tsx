"use client";

import { useEffect, useRef, useState } from "react";
import { Braces, Check, Copy, Download, FileCode, FileText, Loader2 } from "lucide-react";
import { api } from "@/lib/client-api";

const FORMATS = [
  { key: "markdown", label: "Markdown (.md)", icon: FileText, note: "readable" },
  { key: "json", label: "JSON (.json)", icon: Braces, note: "everything, machine-readable" },
  { key: "html", label: "HTML (.html)", icon: FileCode, note: "self-contained page" },
] as const;

/** Download or copy the complete log of this conversation. */
export function ExportMenu({ agentId, chatId }: { agentId: string; chatId: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy(key: (typeof FORMATS)[number]["key"]) {
    setBusy(key);
    setError(null);
    const text = fetch(`${api.exportUrl(agentId, chatId, key)}&inline=1`, { credentials: "same-origin" }).then((r) => {
      if (!r.ok) throw new Error(`Export failed (${r.status})`);
      return r.text();
    });
    try {
      // Safari keeps the user gesture alive only if the clipboard write is
      // issued straight away — hand it the pending text, do not await first.
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
      } else {
        await navigator.clipboard.writeText(await text);
      }
      setCopied(key);
    } catch {
      try {
        const t = await text;
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("rejected");
        setCopied(key);
      } catch {
        setError("Could not copy — download the file instead.");
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Export this chat's full log"
        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:border-line-2 hover:text-ink"
      >
        <Download className="h-3.5 w-3.5" /> Export
      </button>
      {open && (
        <div className="absolute end-0 top-9 z-40 w-[290px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-line-2 bg-[#141824] py-1.5 shadow-2xl shadow-black/60">
          <div className="px-3 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">Export full log</div>
          {FORMATS.map((f) => (
            <div key={f.key} className="flex items-stretch transition-colors hover:bg-white/[0.05]">
              <a
                href={api.exportUrl(agentId, chatId, f.key)}
                download
                onClick={() => setOpen(false)}
                className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pe-1 ps-3 text-[12px] text-ink-2 hover:text-ink"
                title={`Download ${f.label}`}
              >
                <f.icon className="h-3.5 w-3.5 shrink-0" />
                <span className="shrink-0">{f.label}</span>
                <span className="ms-auto min-w-0 truncate text-end text-[10px] text-ink-3">{f.note}</span>
              </a>
              <button
                type="button"
                onClick={() => void copy(f.key)}
                disabled={busy === f.key}
                aria-label={`Copy ${f.label} to the clipboard`}
                title={`Copy ${f.label} to the clipboard`}
                className={`flex w-9 shrink-0 items-center justify-center border-s border-line transition-colors ${
                  copied === f.key ? "text-[#5fe3a3]" : "text-ink-3 hover:bg-white/[0.06] hover:text-ink"
                }`}
              >
                {busy === f.key ? <Loader2 className="h-3 w-3 animate-spin" /> : copied === f.key ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          ))}
          {error && <p className="px-3 py-1.5 text-[10.5px] text-[#ff8ea3]">{error}</p>}
          <p className="border-t border-line px-3 pb-1 pt-1.5 text-[10px] leading-snug text-ink-3">
            Messages, every step, tool inputs and outputs, guard verdicts, usage and compactions — nothing collapsed away.
            Secrets are never recorded.
          </p>
        </div>
      )}
    </div>
  );
}
