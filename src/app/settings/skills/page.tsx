"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, ExternalLink, Loader2, X } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { SettingsTabs } from "@/components/layout/SettingsTabs";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Markdown } from "@/components/ui/Markdown";
import { when } from "@/components/prompts/bits";
import { api, errorText, type SkillCounts, type SkillDeliveryShown, type SkillSourceMeta, type SkillView } from "@/lib/client-api";
import { NARROW_WORKSPACE, useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";

const PHASE_COLOR: Record<string, string> = { planning: "#6d7cff", build: "#3dd68c", review: "#f5b942", repair: "#ff8ea3" };

/**
 * Settings → Skills.
 *
 * Imported engineering documents, exactly as they were published. The
 * owner does not edit them here — Nexora's own instruction text is edited
 * in Settings → Prompts, and a document from outside is something you read
 * and allow, or turn off. What this page answers is: what is in the
 * library, what does an agent actually receive, and where did it come from.
 */
export default function SkillsPage() {
  const [skills, setSkills] = useState<SkillView[] | null>(null);
  const [counts, setCounts] = useState<SkillCounts | null>(null);
  const [source, setSource] = useState<SkillSourceMeta | null>(null);
  const [deliveries, setDeliveries] = useState<SkillDeliveryShown[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const narrow = useMediaQuery(NARROW_WORKSPACE);

  const load = useCallback(() => {
    api.skills()
      .then((d) => { setSkills(d.skills); setCounts(d.counts); setSource(d.source); setDeliveries(d.deliveries); setError(null); })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function toggle(s: SkillView, enabled: boolean) {
    setBusy(s.id);
    try {
      const r = await api.setSkillEnabled(s.id, enabled);
      setSkills((list) => (list ?? []).map((x) => (x.id === r.skill.id ? r.skill : x)));
      setCounts((c) => (c ? { ...c, available: c.available + (enabled ? 1 : -1), tokens: c.tokens + (enabled ? r.skill.approxTokens : -r.skill.approxTokens) } : c));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const recent = useMemo(() => deliveries.slice(0, 12), [deliveries]);

  return (
    <AppShell>
      <h1 className="text-[20px] font-semibold tracking-tight">Settings</h1>
      <p className="mb-3 text-[12.5px] text-ink-3">Company tools and integrations.</p>
      <SettingsTabs />

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Skills</h2>
          <p className="max-w-[78ch] text-[12.5px] leading-relaxed text-ink-3">
            Engineering methods an agent can be handed for one piece of work. The Director picks the few that fit each session; nothing here is
            appended to every agent all the time. A skill is guidance only — it grants no shell, no files, no browser and no spending.
          </p>
        </div>
      </div>

      {counts && (
        <div className="mb-4 flex flex-wrap gap-2">
          {([["In the library", counts.all], ["Available", counts.available], ["Nexora-adapted", counts.adapted], ["Tokens if all delivered", counts.tokens]] as const).map(([label, n]) => (
            <div key={label} className="rounded-xl border border-line bg-white/[0.02] px-3 py-2">
              <div className="num text-[17px] font-semibold leading-none text-ink">{n.toLocaleString()}</div>
              <div className="mt-1 text-[10.5px] uppercase tracking-[0.12em] text-ink-3">{label}</div>
            </div>
          ))}
        </div>
      )}

      {error && <div className="glass mb-4 rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div>}
      {!skills && !error && <div className="flex items-center gap-2 text-[12.5px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Loading skills…</div>}

      {skills && (
        <div className={cn("grid gap-4", !narrow && openId && "xl:grid-cols-[minmax(0,1fr)_minmax(420px,620px)]")}>
          <div className="min-w-0 space-y-2">
            {skills.map((s) => (
              <div key={s.id} className={cn("glass rounded-2xl p-3.5", openId === s.id && "ring-1 ring-brand/40", !s.enabled && "opacity-70")}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-medium text-ink">{s.name}</span>
                      {s.phases.map((p) => <Badge key={p} color={PHASE_COLOR[p] ?? "#aab2c5"}>{p}</Badge>)}
                      {s.adaptation && <Badge color="#6d7cff" dot>adapted for Nexora</Badge>}
                      {s.overridden && <Badge color="#f5b942">changed from default</Badge>}
                    </div>
                    <p className="mt-1 max-w-[84ch] text-[12px] leading-relaxed text-ink-3">{s.use}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
                      {/* upstream names these documents by their id, so only show it when it adds something */}
                      {s.name !== s.id && <code className="text-[10.5px] text-ink-2">{s.id}</code>}
                      <span>~{s.approxTokens.toLocaleString()} tokens</span>
                      <span>{s.source.repo} @ {s.source.revision.slice(0, 7)}</span>
                      <a href={s.source.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-ink-2 hover:text-ink">
                        source <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    {!s.enabled && s.disabledReason && (
                      <p className="mt-2 max-w-[84ch] rounded-lg border border-line bg-white/[0.02] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-ink-3">{s.disabledReason}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setOpenId(openId === s.id ? null : s.id)}>
                      <BookOpen className="h-3.5 w-3.5" /> {openId === s.id ? "Close" : "Read"}
                    </Button>
                    <Button
                      variant={s.enabled ? "ghost" : "primary"}
                      size="sm"
                      disabled={busy === s.id}
                      onClick={() => void toggle(s, !s.enabled)}
                    >
                      {busy === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                      {s.enabled ? "Turn off" : "Make available"}
                    </Button>
                  </div>
                </div>
              </div>
            ))}

            {source && (
              <p className="pt-1 text-[11px] leading-relaxed text-ink-3">
                Imported from <a className="text-ink-2 hover:text-ink" href={source.url} target="_blank" rel="noreferrer noopener">{source.repo}</a> at
                revision <code className="text-[10.5px]">{source.revision.slice(0, 12)}</code> on {when(source.importedAt)}, under the {source.license} license.
                Document text is stored verbatim and is not edited by Nexora; where Nexora needs to say something different, it says it separately, above the document.
              </p>
            )}

            {recent.length > 0 && (
              <div className="glass mt-4 rounded-2xl p-3.5">
                <div className="text-[12.5px] font-medium text-ink">Recently delivered</div>
                <p className="mb-2 text-[11px] text-ink-3">What actually reached a model, and how it got there.</p>
                <div className="space-y-1">
                  {recent.map((d, i) => (
                    <div key={`${d.scopeId}-${d.skillId}-${i}`} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[11.5px] text-ink-3">
                      <span className="text-ink-2">{d.skillName}</span>
                      <Badge color={d.via === "tool" ? "#3dd68c" : "#6d7cff"}>{d.via === "tool" ? "read by the agent" : "sent in the brief"}</Badge>
                      <span className="text-ink-3">to {d.agentName}</span>
                      <span className="min-w-0 truncate">· {d.where}</span>
                      <span>· {when(d.at)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {openId && <SkillReader key={openId} id={openId} onClose={() => setOpenId(null)} />}
        </div>
      )}
    </AppShell>
  );
}

/** The document as an agent receives it — the same bytes, not a summary of them. */
function SkillReader({ id, onClose }: { id: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // keyed by id at the call site, so a different skill mounts a fresh reader
  // rather than needing the previous one's state cleared here
  useEffect(() => {
    let live = true;
    api.skill(id).then((d) => { if (live) setText(d.delivered); }).catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [id]);

  return (
    <div className="glass max-h-[calc(100vh-180px)] overflow-auto rounded-2xl p-4 xl:sticky xl:top-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-medium text-ink">What the agent receives</div>
          <p className="text-[11px] text-ink-3">Nexora&rsquo;s note first, then the document unchanged.</p>
        </div>
        <button onClick={onClose} className="rounded-lg p-1 text-ink-3 hover:bg-white/[0.06] hover:text-ink" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      {error && <div className="text-[12.5px] text-[#ff8ea3]">{error}</div>}
      {!text && !error && <div className="flex items-center gap-2 text-[12.5px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>}
      {text && <div className="text-[12.5px] leading-relaxed"><Markdown>{text}</Markdown></div>}
    </div>
  );
}
