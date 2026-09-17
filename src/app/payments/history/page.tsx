"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { History, CreditCard } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { api, errorText, type PaymentTransaction } from "@/lib/client-api";
import { ApprovalLabel, EmptyState, ErrorBox, Loading, MethodGlyph, PaymentsHeader, StatusBadge, TransactionDetail, amountLabel, dayLabel, money, usePaymentsLive } from "@/components/payments/shared";
import { cn } from "@/lib/utils";

type Filter = "all" | "paid" | "failed" | "rejected" | "cancelled";

export default function PaymentHistoryPage() {
  const [tx, setTx] = useState<PaymentTransaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<PaymentTransaction | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const refresh = useCallback(() => { api.paymentHistory().then((r) => setTx(r.transactions)).catch((e) => setError(errorText(e))); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  usePaymentsLive(refresh);

  const shown = useMemo(() => (tx ?? []).filter((t) => filter === "all" || (filter === "paid" && t.status === "SUCCEEDED") || (filter === "failed" && t.status === "FAILED") || (filter === "rejected" && t.status === "REJECTED") || (filter === "cancelled" && t.status === "CANCELLED")), [tx, filter]);
  const groups = useMemo(() => {
    const map = new Map<string, PaymentTransaction[]>();
    for (const t of shown) { const k = dayLabel(t.completedAt); map.set(k, [...(map.get(k) ?? []), t]); }
    return [...map.entries()];
  }, [shown]);
  const paidTotal = shown.filter((t) => t.status === "SUCCEEDED").reduce((s, t) => s + t.amount, 0);

  return (
    <AppShell>
      <PaymentsHeader title="History" subtitle="Every payment and attempt — who asked, why, with which method, and how it was approved." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1">
          {([["all", "All"], ["paid", "Paid"], ["failed", "Failed"], ["rejected", "Rejected"], ["cancelled", "Cancelled"]] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setFilter(id)} className={cn("shrink-0 rounded-full border px-3 py-1 text-[12px] transition-colors", filter === id ? "border-brand/60 bg-brand/15 text-ink" : "border-line text-ink-3 hover:text-ink-2")}>{label}</button>
          ))}
        </div>
        {tx && shown.length > 0 && <span className="ml-auto text-[12px] text-ink-3">{shown.length} item{shown.length === 1 ? "" : "s"} · <span className="text-ink num">{money(paidTotal)}</span> paid</span>}
      </div>
      {error && <ErrorBox text={error} />}
      {!tx && !error && <Loading />}
      {tx && shown.length === 0 && <EmptyState icon={History} title="No history yet" text="Completed, failed, rejected and cancelled payments appear here with their masked payment method." />}
      <div className="space-y-5">
        {groups.map(([day, items]) => (
          <section key={day}>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">{day}</h2>
            <ul className="glass divide-y divide-line/70 rounded-2xl">
              {items.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => setOpen(t)} className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.04] sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,220px)_auto]">
                    {t.paymentMethodType ? <MethodGlyph type={t.paymentMethodType} brand={t.paymentMethodBrand} size={36} /> : <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/[0.05] text-ink-3"><CreditCard className="h-4 w-4" /></span>}
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-medium text-ink">{t.merchant}</span>
                      <span className="block truncate text-[11.5px] text-ink-3">Requested by {t.agentName} · <ApprovalLabel type={t.approvalType} /></span>
                    </span>
                    <span className="hidden min-w-0 sm:block">
                      {t.paymentMethodDisplayName ? (
                        <>
                          <span className="block truncate text-[12px] text-ink-2">{t.paymentMethodDisplayName}</span>
                          <span className="block font-mono text-[11px] text-ink-3">•••• {t.paymentMethodLast4}</span>
                        </>
                      ) : <span className="text-[12px] text-ink-3">No method</span>}
                    </span>
                    <span className="text-right">
                      <span className={cn("block text-[14px] font-semibold num", t.status === "SUCCEEDED" ? "text-ink" : "text-ink-3 line-through decoration-ink-3/60")}>{amountLabel(t)}</span>
                      <StatusBadge status={t.status} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {open && <TransactionDetail t={open} onClose={() => setOpen(null)} />}
    </AppShell>
  );
}
