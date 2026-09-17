"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { textDirection } from "@/lib/direction";

/**
 * Assistant replies rendered as designed markdown: headings, lists, tables, code.
 *
 * The whole block follows the language of the reply, so a Persian, Arabic or
 * Hebrew answer reads right-to-left (tables and list markers included), while
 * each paragraph still carries dir="auto" so an English passage inside it
 * stays left-to-right. Code keeps its own direction in every case.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  const dir = textDirection(children);
  return (
    <div dir={dir} className={cn("md", dir === "rtl" && "text-right", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 dir="auto" className="mb-1.5 mt-3 text-[15px] font-semibold tracking-tight text-ink first:mt-0" {...p} />,
          h2: (p) => <h2 dir="auto" className="mb-1.5 mt-3 text-[14px] font-semibold tracking-tight text-ink first:mt-0" {...p} />,
          h3: (p) => <h3 dir="auto" className="mb-1 mt-2.5 text-[13px] font-semibold text-ink first:mt-0" {...p} />,
          p: (p) => <p dir="auto" className="my-1.5 leading-relaxed first:mt-0 last:mb-0" {...p} />,
          ul: (p) => <ul className="my-1.5 list-disc space-y-0.5 ps-5 marker:text-ink-3" {...p} />,
          ol: (p) => <ol className="my-1.5 list-decimal space-y-0.5 ps-5 marker:text-ink-3" {...p} />,
          li: (p) => <li dir="auto" className="leading-relaxed" {...p} />,
          strong: (p) => <strong className="font-semibold text-ink" {...p} />,
          em: (p) => <em className="italic text-ink-2" {...p} />,
          a: (p) => <a className="text-brand underline underline-offset-2 hover:text-ink" target="_blank" rel="noreferrer" {...p} />,
          hr: () => <hr className="my-2.5 border-line" />,
          blockquote: (p) => <blockquote dir="auto" className="my-2 border-s-2 border-line-2 ps-3 text-ink-2" {...p} />,
          code: ({ className, children, ...rest }) => {
            const isBlock = /language-/.test(className ?? "");
            if (isBlock) {
              return (
                <code className="block whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-2" {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <code dir="ltr" className="rounded bg-white/[0.08] px-1 py-px font-mono text-[11.5px] text-[#c7d2ff]" {...rest}>
                {children}
              </code>
            );
          },
          pre: (p) => <pre dir="ltr" className="my-2 overflow-x-auto rounded-lg border border-line bg-black/30 p-2.5 text-left" {...p} />,
          table: (p) => (
            <div className="my-2 overflow-x-auto rounded-lg border border-line">
              <table className="w-full border-collapse text-[11.5px]" {...p} />
            </div>
          ),
          thead: (p) => <thead className="bg-white/[0.05]" {...p} />,
          th: (p) => <th dir="auto" className="border-b border-line px-2.5 py-1.5 text-start font-semibold text-ink" {...p} />,
          td: (p) => <td dir="auto" className="border-b border-line/60 px-2.5 py-1.5 align-top text-start text-ink-2" {...p} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
