"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Loader2, ShieldCheck, Sparkles, Info } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { api, errorText, type PaymentMethod, type PaymentSettings } from "@/lib/client-api";
import { ErrorBox, Loading, MethodGlyph, PaymentsHeader, methodSummary, money, usePaymentsLive } from "@/components/payments/shared";
import { cn } from "@/lib/utils";

export default function PaymentSettingsPage() {
  const [settings, setSettings] = useState<PaymentSettings | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [limit, setLimit] = useState("");
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(() => {
    api.paymentSettings().then((r) => { setSettings(r.settings); setMethods(r.methods); setLimit(r.settings.autoApproveLimit.toFixed(2)); setDefaultId(r.settings.defaultPaymentMethodId); }).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  usePaymentsLive(refresh);

  const limitNum = Number(limit);
  const dirty = settings ? Math.round(limitNum * 100) !== Math.round(settings.autoApproveLimit * 100) || defaultId !== settings.defaultPaymentMethodId : false;

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const r = await api.updatePaymentSettings({ autoApproveLimit: limitNum, defaultPaymentMethodId: defaultId });
      setSettings(r.settings);
      setLimit(r.settings.autoApproveLimit.toFixed(2));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setError(errorText(e)); } finally { setSaving(false); }
  }

  return (
    <AppShell>
      <PaymentsHeader title="Settings" subtitle="The two rules that govern autonomous spending. Only you can change them." />
      {error && <div className="mb-4"><ErrorBox text={error} /></div>}
      {!settings && !error && <Loading />}
      {settings && (
        <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,640px)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            <Panel title="Automatic Spending Limit" subtitle="Payments at or below this amount may proceed automatically. Payments above this amount require your approval." icon={<Sparkles className="h-4 w-4 text-operations" />}>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex h-12 items-center gap-1 rounded-xl border border-line bg-white/[0.04] px-3 text-[20px] font-semibold tracking-tight focus-within:border-brand/60">
                  <span className="text-ink-3">$</span>
                  <input value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" className="w-28 bg-transparent text-ink outline-none num" aria-label="Automatic spending limit in US dollars" />
                  <span className="text-[12px] font-medium text-ink-3">USD</span>
                </label>
                <div className="flex gap-1">
                  {[0, 5, 20, 50].map((v) => (
                    <button key={v} type="button" onClick={() => setLimit(v.toFixed(2))} className={cn("rounded-lg border px-2.5 py-1 text-[11.5px] num", Math.round(limitNum * 100) === v * 100 ? "border-brand/60 bg-brand/15 text-ink" : "border-line text-ink-3 hover:text-ink-2")}>{money(v)}</button>
                  ))}
                </div>
              </div>
              <ul className="mt-4 grid gap-1.5 text-[12px] text-ink-2 sm:grid-cols-2">
                <li className="flex items-center gap-2 rounded-lg border border-line bg-white/[0.02] px-3 py-2"><Sparkles className="h-3.5 w-3.5 text-operations" /> Up to <span className="num text-ink">{money(Number.isFinite(limitNum) ? limitNum : 0)}</span> → automatic</li>
                <li className="flex items-center gap-2 rounded-lg border border-line bg-white/[0.02] px-3 py-2"><ShieldCheck className="h-3.5 w-3.5 text-warning" /> Above → asks you first</li>
              </ul>
            </Panel>

            <Panel title="Default Payment Method" subtitle="Shown to agents as the default hint. They still pick the method whose usage description fits the checkout." icon={<ShieldCheck className="h-4 w-4 text-brand" />}>
              {methods.length === 0 ? (
                <p className="text-[12.5px] text-ink-3">No payment method yet. <Link href="/payments/methods" className="text-brand hover:text-ink">Add one</Link> to enable automatic payments.</p>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {methods.map((m) => (
                    <li key={m.id}>
                      <button type="button" onClick={() => setDefaultId(m.id)} className={cn("flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors", defaultId === m.id ? "border-brand/60 bg-brand/10" : "border-line bg-white/[0.02] hover:bg-white/[0.05]")}>
                        <MethodGlyph type={m.type} brand={m.brand} size={36} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-ink">{m.displayName}</span>
                          <span className="block truncate text-[11.5px] text-ink-3">{methodSummary(m)}</span>
                        </span>
                        <span className={cn("grid h-5 w-5 place-items-center rounded-full border", defaultId === m.id ? "border-brand bg-brand text-white" : "border-line-2")}>{defaultId === m.id && <Check className="h-3 w-3" />}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Currency" subtitle="Requests and history are recorded in this currency.">
              <div className="flex items-center gap-3 text-[13px]"><span className="rounded-lg border border-line bg-white/[0.04] px-3 py-1.5 font-semibold">USD</span><span className="text-[12px] text-ink-3">US Dollar · other currencies and conversion come later</span></div>
            </Panel>

            <div className="flex items-center justify-end gap-3">
              {saved && <span className="flex items-center gap-1 text-[12px] text-operations"><Check className="h-3.5 w-3.5" /> Saved</span>}
              <Button variant="primary" size="md" disabled={!dirty || saving || !Number.isFinite(limitNum)} onClick={save}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save settings</Button>
            </div>
          </div>

          <div className="glass h-fit rounded-2xl p-4 text-[12.5px] leading-relaxed text-ink-2">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-ink"><Info className="h-4 w-4 text-brand" /> How agents pay</div>
            <ol className="list-decimal space-y-1.5 pl-4">
              <li>An agent at a checkout calls <span className="font-mono text-[11.5px]">request_payment</span> with merchant, amount and reason.</li>
              <li>Nexora applies the limit above — deterministically, never by the model.</li>
              <li>At or below the limit the request is auto-approved; above it, an approval card appears in Requests and the agent waits.</li>
              <li>An approved agent gets a 30-minute authorization and enters the details with the browser. Secrets never appear in activity or logs.</li>
              <li>The outcome is recorded in History with the method, reason and approval path. Duplicate executions are blocked by the side-effect guard.</li>
            </ol>
          </div>
        </div>
      )}
    </AppShell>
  );
}
