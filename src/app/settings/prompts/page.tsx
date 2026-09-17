"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, FileText, Loader2, Search, Upload, X } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { SettingsTabs } from "@/components/layout/SettingsTabs";
import { Button } from "@/components/ui/Button";
import { CategoryTag, StatusTag, when } from "@/components/prompts/bits";
import { PromptEditor, download } from "@/components/prompts/PromptEditor";
import { ImportDialog } from "@/components/prompts/ImportDialog";
import { api, errorText, type PromptCounts, type PromptView } from "@/lib/client-api";
import { CATEGORY_LABELS, type PromptCategory } from "@/lib/prompts/types";
import { NARROW_WORKSPACE, useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";

type Filter = "all" | "built-in" | "customized" | "update";

const FILTERS: { key: Filter; label: string; match: (p: PromptView) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "built-in", label: "Built-in", match: (p) => !p.customized },
  { key: "customized", label: "Customized", match: (p) => p.customized },
  { key: "update", label: "Update available", match: (p) => p.updateAvailable },
];

/**
 * Settings → Prompts.
 *
 * Every static instruction Nexora sends to a model, in one place: what it
 * says now, what it shipped as, and who changed it. The built-in text is
 * never overwritten by an edit, so every prompt on this page can be put
 * back exactly as it was.
 */
export default function PromptsPage() {
  const [prompts, setPrompts] = useState<PromptView[] | null>(null);
  const [counts, setCounts] = useState<PromptCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [category, setCategory] = useState<PromptCategory | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const narrow = useMediaQuery(NARROW_WORKSPACE);

  const load = useCallback(() => {
    api.prompts()
      .then((d) => { setPrompts(d.prompts); setCounts(d.counts); setError(null); })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (prompts ?? [])
      .filter((p) => FILTERS.find((f) => f.key === filter)!.match(p))
      .filter((p) => !category || p.category === category)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q) || p.description.toLowerCase().includes(q) || CATEGORY_LABELS[p.category].toLowerCase().includes(q));
  }, [prompts, filter, category, query]);

  const groups = useMemo(() => {
    const by = new Map<PromptCategory, PromptView[]>();
    for (const p of shown) by.set(p.category, [...(by.get(p.category) ?? []), p]);
    return [...by.entries()];
  }, [shown]);

  const categories = useMemo(() => {
    const by = new Map<PromptCategory, number>();
    for (const p of prompts ?? []) by.set(p.category, (by.get(p.category) ?? 0) + 1);
    return [...by.entries()].sort((a, b) => CATEGORY_LABELS[a[0]].localeCompare(CATEGORY_LABELS[b[0]]));
  }, [prompts]);

  async function exportFile(body: { ids?: string[]; category?: string }) {
    const r = await fetch("/api/prompts/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "nexora-prompts.json";
    download(await r.blob(), name);
  }

  const applyUpdated = (p: PromptView) => setPrompts((list) => (list ?? []).map((x) => (x.id === p.id ? p : x)));

  return (
    <AppShell>
      <h1 className="text-[20px] font-semibold tracking-tight">Settings</h1>
      <p className="mb-3 text-[12.5px] text-ink-3">Company tools and integrations.</p>
      <SettingsTabs />

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Prompts</h2>
          <p className="max-w-[78ch] text-[12.5px] leading-relaxed text-ink-3">
            Every static instruction Nexora gives a model — what each agent is told about autonomy, money, logins, company data, delegation and the work itself.
            Edit any of them here; the text that ships stays in Nexora and one click puts it back.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="md" onClick={() => setImporting(true)}><Upload className="h-4 w-4" /> Import</Button>
          <Button variant="primary" size="md" onClick={() => void exportFile({})}><Download className="h-4 w-4" /> Export all</Button>
        </div>
      </div>

      {counts && (
        <div className="mb-4 flex flex-wrap gap-2">
          {([["All prompts", counts.all], ["Customized", counts.customized], ["Update available", counts.updateAvailable], ["Categories", counts.categories]] as const).map(([label, n]) => (
            <div key={label} className="rounded-xl border border-line bg-white/[0.02] px-3 py-2">
              <div className="num text-[17px] font-semibold leading-none text-ink">{n}</div>
              <div className="mt-1 text-[10.5px] uppercase tracking-[0.12em] text-ink-3">{label}</div>
            </div>
          ))}
        </div>
      )}

      {error && <div className="glass mb-4 rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div>}
      {!prompts && !error && <div className="flex items-center gap-2 text-[12.5px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Loading prompts…</div>}

      {prompts && (
        <div className={cn("grid gap-4", !narrow && openId && "xl:grid-cols-[minmax(0,1fr)_minmax(420px,560px)]")}>
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <label className="flex h-9 min-w-[200px] flex-1 items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3 focus-within:border-brand/50">
                <Search className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, id or description…"
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-ink-3"
                />
                {query && <button type="button" onClick={() => setQuery("")} className="text-ink-3 hover:text-ink" aria-label="Clear search"><X className="h-3.5 w-3.5" /></button>}
              </label>
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    "rounded-lg border px-2.5 py-1.5 text-[11.5px] transition-colors",
                    filter === f.key ? "border-brand/50 bg-brand/[0.14] text-ink" : "border-line text-ink-3 hover:text-ink"
                  )}
                >
                  {f.label} <span className="num text-[10.5px]">{(prompts ?? []).filter(f.match).length}</span>
                </button>
              ))}
            </div>

            <div className="mb-3 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setCategory(null)}
                className={cn("rounded-lg border px-2.5 py-1 text-[11.5px] transition-colors", !category ? "border-brand/50 bg-brand/[0.14] text-ink" : "border-line text-ink-3 hover:text-ink")}
              >
                Every category
              </button>
              {categories.map(([id, n]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setCategory(category === id ? null : id)}
                  className={cn("rounded-lg border px-2.5 py-1 text-[11.5px] transition-colors", category === id ? "border-brand/50 bg-brand/[0.14] text-ink" : "border-line text-ink-3 hover:text-ink")}
                >
                  {CATEGORY_LABELS[id]} <span className="num text-[10.5px]">{n}</span>
                </button>
              ))}
            </div>

            {!shown.length && (
              <div className="glass flex flex-col items-center gap-2 rounded-2xl px-6 py-12 text-center">
                <span className="grid h-11 w-11 place-items-center rounded-2xl border border-line bg-white/[0.03] text-ink-3"><FileText className="h-5 w-5" /></span>
                <h3 className="text-[13.5px] font-semibold">Nothing matches that</h3>
                <p className="max-w-[44ch] text-[12px] text-ink-3">Try a different search, or clear the filters to see all {prompts.length} prompts.</p>
                <Button variant="outline" size="sm" onClick={() => { setQuery(""); setFilter("all"); setCategory(null); }}>Clear filters</Button>
              </div>
            )}

            <div className="space-y-4">
              {groups.map(([cat, rows]) => (
                <section key={cat}>
                  <h3 className="mb-1.5 flex items-center gap-2 px-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">
                    {CATEGORY_LABELS[cat]}
                    <span className="num font-normal">{rows.length}</span>
                    <button type="button" onClick={() => void exportFile({ category: cat })} className="ms-auto text-[10.5px] normal-case tracking-normal text-ink-3 hover:text-brand">
                      Export category
                    </button>
                  </h3>
                  <ul className="space-y-1.5">
                    {rows.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => setOpenId(p.id)}
                          className={cn(
                            "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-start transition-all",
                            openId === p.id ? "border-brand/50 bg-brand/[0.10]" : "border-line bg-white/[0.02] hover:border-line-2 hover:bg-white/[0.045]"
                          )}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-[13px] font-medium text-ink">{p.name}</span>
                              <StatusTag customized={p.customized} updateAvailable={p.updateAvailable} />
                            </span>
                            <span className="mt-0.5 block truncate text-[11.5px] text-ink-3">{p.description}</span>
                            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-ink-3">
                              <code className="font-mono text-[10px] text-ink-3">{p.id}</code>
                              <span>· v{p.version}</span>
                              {p.lastModifiedAt && <span>· edited {when(p.lastModifiedAt)}</span>}
                            </span>
                          </span>
                          <CategoryTag category={p.category} className="mt-0.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>

          {openId && !narrow && (
            <div className="xl:sticky xl:top-4 xl:max-h-[calc(100dvh-120px)]">
              <PromptEditor key={openId} id={openId} onClose={() => setOpenId(null)} onChanged={applyUpdated} />
            </div>
          )}
        </div>
      )}

      {openId && narrow && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-[#080d19] p-3">
          <div className="mx-auto max-w-2xl">
            <PromptEditor key={openId} id={openId} onClose={() => setOpenId(null)} onChanged={applyUpdated} />
          </div>
        </div>
      )}

      {importing && <ImportDialog onClose={() => setImporting(false)} onImported={load} />}
    </AppShell>
  );
}
