"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Bell, Bot, Check, CheckCircle2, ChevronRight, Clock, CreditCard, Database, ExternalLink, Gauge, Hand, KeyRound, Loader2, ShieldCheck, Sparkles, X,
} from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Field, Input, Select, Textarea } from "@/components/ui/Form";
import { BrowserLiveView } from "@/components/agents/BrowserLiveView";
import { api, errorText, type OwnerAction, type OwnerActionKind, type OwnerField, type OwnerNotification } from "@/lib/client-api";
import { useLinkedRequestId } from "@/lib/use-request-focus";
import { cn } from "@/lib/utils";

type Data = { actions: OwnerAction[]; recent: OwnerAction[]; counts: { total: number; blocking: number }; notifications: OwnerNotification[]; unread: number };

const ICON: Record<OwnerActionKind, typeof Bell> = {
  data: Database, approval: ShieldCheck, payment: CreditCard, credential: KeyRound, capability: Sparkles,
  browser: Hand, captcha: Hand, otp: Hand, signature: ShieldCheck, turn_budget: Gauge, decision: ShieldCheck, other: Bell,
};

const when = (iso: string) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

/**
 * Needs You — every unresolved thing a human has to do, from every
 * subsystem, in one list. If this page is empty, nothing anywhere is waiting
 * on the owner.
 */
export default function ActionCenterPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const linked = useLinkedRequestId("action");
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.actionCenter().then((d) => { setData(d); setError(null); }).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // live: new actions, resolutions and notifications all arrive on one stream
  useEffect(() => {
    const es = new EventSource("/api/action-center/events");
    let t: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = () => { if (t) clearTimeout(t); t = setTimeout(refresh, 250); };
    return () => { es.close(); if (t) clearTimeout(t); };
  }, [refresh]);

  const actions = useMemo(() => data?.actions ?? [], [data]);
  const focused = linked && actions.some((a) => a.id === linked) ? linked : null;
  const expanded = openId ?? focused ?? actions[0]?.id ?? null;

  const blocking = useMemo(() => actions.filter((a) => a.blocking), [actions]);
  const review = useMemo(() => actions.filter((a) => !a.blocking), [actions]);

  return (
    <AppShell>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">Owner</div>
          <h1 className="mt-0.5 flex items-center gap-2 text-[22px] font-semibold tracking-tight">
            Needs You
            {actions.length > 0 && <Badge color={blocking.length ? "#f5b942" : "#6d7cff"} dot>{actions.length}</Badge>}
          </h1>
          <p className="mt-0.5 max-w-2xl text-[12.5px] text-ink-3">
            Everything across Nexora that is waiting on a human — approvals, information, logins, human checks in a browser. Agents handle everything else themselves.
          </p>
        </div>
        {data && data.unread > 0 && (
          <Button variant="ghost" size="sm" onClick={() => api.readNotifications({ all: true }).then(refresh)}>
            <Bell className="h-3.5 w-3.5" /> Mark {data.unread} read
          </Button>
        )}
      </div>

      {error && <div className="mb-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-[#ff8ea3]">{error}</div>}
      {!data && !error && <div className="flex items-center gap-2 text-[12.5px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Checking every agent…</div>}

      {data && actions.length === 0 && (
        <div className="glass grid place-items-center rounded-2xl px-6 py-16 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-operations/15 text-operations"><CheckCircle2 className="h-6 w-6" /></span>
          <h2 className="mt-4 text-[16px] font-semibold">Nothing needs your attention</h2>
          <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-ink-3">
            Your agents are working normally. Anything that genuinely requires you — an approval, a value only you know, a human check in a browser — appears here and notifies you.
          </p>
          {data.recent.length > 0 && (
            <div className="mt-5 w-full max-w-md text-left">
              <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">Recently handled</div>
              <ul className="glass divide-y divide-line/70 rounded-xl">
                {data.recent.slice(0, 4).map((a) => (
                  <li key={a.id} className="flex items-center gap-2 px-3 py-2 text-[12px] text-ink-3">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-operations" />
                    <span className="min-w-0 flex-1 truncate text-ink-2">{a.title}</span>
                    <span className="shrink-0">{when(a.resolvedAt ?? a.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {data && actions.length > 0 && (
        <div className="space-y-5">
          {blocking.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-warning">
                <Clock className="h-3.5 w-3.5" /> Blocking an agent · {blocking.length}
              </h2>
              <div className="space-y-3">
                {blocking.map((a) => <ActionCard key={a.id} action={a} expanded={expanded === a.id} onToggle={() => setOpenId(expanded === a.id ? "" : a.id)} onDone={refresh} />)}
              </div>
            </section>
          )}
          {review.length > 0 && (
            <section>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">For review · {review.length}</h2>
              <div className="space-y-3">
                {review.map((a) => <ActionCard key={a.id} action={a} expanded={expanded === a.id} onToggle={() => setOpenId(expanded === a.id ? "" : a.id)} onDone={refresh} />)}
              </div>
            </section>
          )}
        </div>
      )}
    </AppShell>
  );
}

/* ---------------------------------------------------------------- one action */

function ActionCard({ action, expanded, onToggle, onDone }: { action: OwnerAction; expanded: boolean; onToggle: () => void; onDone: () => void }) {
  const Icon = ICON[action.kind] ?? Bell;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [save, setSave] = useState<Record<string, boolean>>(() => Object.fromEntries((action.payload.fields ?? []).map((f) => [f.key, f.saveForFuture !== false])));
  const [note, setNote] = useState("");
  const [custom, setCustom] = useState("");

  const isBrowser = action.kind === "browser" || action.kind === "captcha" || action.kind === "otp";
  const fields = action.payload.fields ?? [];
  const choices = action.payload.choices ?? [];
  const complete = fields.every((f) => !f.required || (values[f.key] ?? "").trim());

  async function submit(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    try { await api.resolveOwnerAction(action.id, body); onDone(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }

  return (
    <article className={cn("glass overflow-hidden rounded-2xl", action.blocking && "border border-warning/30")}>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 px-4 py-3 text-left">
        <span className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl", action.blocking ? "bg-warning/15 text-warning" : "bg-white/[0.06] text-ink-2")}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold tracking-tight text-ink">{action.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-ink-3">
            <Link href={`/agents/${action.agentId}`} className="inline-flex items-center gap-1 hover:text-ink" onClick={(e) => e.stopPropagation()}><Bot className="h-3 w-3" /> {action.agentName}</Link>
            <span>· {when(action.createdAt)}</span>
            {!action.blocking && <Badge color="#6f7890">Not blocking</Badge>}
          </span>
        </span>
        <ChevronRight className={cn("mt-1 h-4 w-4 shrink-0 text-ink-3 transition-transform", expanded && "rotate-90")} />
      </button>

      {expanded && (
        <div className="border-t border-line px-4 py-3">
          <p dir="auto" className="text-[12.5px] leading-relaxed text-ink-2">{action.reason}</p>

          {(action.payload.details?.length ?? 0) > 0 && (
            <dl className="mt-3 grid grid-cols-[120px_1fr] gap-y-1.5 text-[12.5px]">
              {action.payload.details!.map((d) => (
                <div key={d.label} className="contents">
                  <dt className="text-ink-3">{d.label}</dt>
                  <dd dir="auto" className="min-w-0 break-words text-ink">{d.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {action.payload.turns && (
            <div className="mt-3 rounded-xl border border-line bg-white/[0.03] px-3 py-2 text-[12px] text-ink-2">
              <span className="num text-ink">{action.payload.turns.used}</span> steps used{action.payload.turns.step ? ` · last step: ${action.payload.turns.step}` : ""}
            </div>
          )}

          {isBrowser && (
            <div className="mt-3">
              <div className="overflow-hidden rounded-xl border border-line">
                <BrowserLiveView agentId={action.agentId} agentName={action.agentName} onReturned={onDone} compact />
              </div>
              {/* a phone needs the whole screen for a real page */}
              <Link
                href={`/browser/sessions/agent_${action.agentId}/live`}
                target="_blank"
                className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] text-brand hover:text-ink sm:hidden"
              >
                Open full screen <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          )}

          {fields.length > 0 && (
            <div className="mt-3 space-y-3">
              {fields.map((f) => (
                <div key={f.key}>
                  <FieldInput field={f} value={values[f.key] ?? ""} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
                  {f.saveForFuture !== false && (
                    <label className="mt-1 flex cursor-pointer items-center gap-2 text-[11.5px] text-ink-3">
                      <input type="checkbox" checked={save[f.key] ?? true} onChange={(e) => setSave((s) => ({ ...s, [f.key]: e.target.checked }))} className="h-3.5 w-3.5 accent-[#6d7cff]" />
                      Save for future tasks <span className="font-mono text-[10.5px] text-ink-3">{f.key}</span>
                    </label>
                  )}
                </div>
              ))}
            </div>
          )}

          {action.kind === "turn_budget" && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Input value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="custom steps" className="h-8 w-36" inputMode="numeric" />
              <Button variant="ghost" size="sm" disabled={!custom || !!busy} onClick={() => submit({ choice: "continue", values: { grant: custom } }, "custom")}>
                {busy === "custom" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Continue with {custom || "…"} steps
              </Button>
            </div>
          )}

          {error && <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-[#ff8ea3]">{error}</div>}

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            {fields.length > 0 && (
              <Button variant="primary" size="sm" disabled={!complete || !!busy} onClick={() => submit({ values, save, note }, "submit")}>
                {busy === "submit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Submit
              </Button>
            )}
            {choices.map((c) => (
              <Button
                key={c.value}
                variant={c.style === "danger" ? "danger" : c.style === "ghost" ? "ghost" : "primary"}
                size="sm"
                disabled={!!busy}
                title={c.note}
                onClick={() => submit({ choice: c.value, note }, c.value)}
              >
                {busy === c.value ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} {c.label}
              </Button>
            ))}
            {action.payload.href && (
              <Link href={action.payload.href} className="inline-flex items-center gap-1 text-[12px] text-brand hover:text-ink">
                Open {action.kind === "credential" ? "Credentials" : action.kind === "payment" ? "Payments" : action.kind === "capability" ? "Capabilities" : action.kind === "data" ? "Company" : "details"} <ExternalLink className="h-3 w-3" />
              </Link>
            )}
            <Button variant="ghost" size="sm" className="ml-auto" disabled={!!busy} onClick={() => submit({ dismiss: true, note }, "dismiss")}>
              {busy === "dismiss" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />} Dismiss
            </Button>
          </div>

          {(choices.length > 0 || fields.length > 0) && (
            <input value={note} onChange={(e) => setNote(e.target.value)} dir="auto" placeholder="Optional note for the agent" className="mt-2 h-8 w-full rounded-lg border border-line bg-white/[0.04] px-2.5 text-[12px] text-ink outline-none placeholder:text-ink-3 focus:border-brand/60" />
          )}
        </div>
      )}
    </article>
  );
}

function FieldInput({ field, value, onChange }: { field: OwnerField; value: string; onChange: (v: string) => void }) {
  const common = { value, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onChange(e.target.value) };
  return (
    <Field label={`${field.label}${field.required === false ? " (optional)" : ""}`} hint={field.help}>
      {field.type === "textarea" || field.type === "json" ? (
        <Textarea rows={3} {...common} placeholder={field.placeholder} />
      ) : field.type === "select" || field.type === "multi_select" ? (
        <Select {...common}>
          <option value="">Choose…</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      ) : field.type === "boolean" ? (
        <Select {...common}>
          <option value="">Choose…</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      ) : (
        <Input
          {...common}
          type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "email" ? "email" : field.type === "phone" ? "tel" : "text"}
          placeholder={field.placeholder ?? (field.type === "date" ? "YYYY-MM-DD" : undefined)}
        />
      )}
    </Field>
  );
}
