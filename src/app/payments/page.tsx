"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, ArrowRight, CreditCard, Hourglass, Sparkles, ShieldCheck, TrendingUp } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { api, errorText, type PaymentMethod, type PaymentOverview, type PaymentRequest, type PaymentTransaction } from "@/lib/client-api";
import { EmptyState, ErrorBox, Loading, MethodGlyph, PaymentsHeader, RequestCard, StatusBadge, TransactionDetail, amountLabel, dayLabel, methodSummary, money, usePaymentsLive } from "@/components/payments/shared";

export default function PaymentsOverviewPage() {
  const [data, setData] = useState<{ overview: PaymentOverview; recent: PaymentTransaction[]; pending: PaymentRequest[]; methods: PaymentMethod[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<PaymentTransaction | null>(null);
  const refresh = useCallback(() => { api.paymentOverview().then(setData).catch((e) => setError(errorText(e))); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  usePaymentsLive(refresh);

  const ov = data?.overview;
  return (
    <AppShell>
      <PaymentsHeader title="Overview" subtitle="Company spending at a glance — what ran automatically, what you approved, and what is waiting." action={<Link href="/payments/methods"><Button variant="primary" size="sm"><Plus className="h-3.5 w-3.5" /> Payment method</Button></Link>} />
      {error && <ErrorBox text={error} />}
      {!data && !error && <Loading />}
      {data && ov && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat icon={TrendingUp} label="This month" value={money(ov.monthTotal)} sub={`${new Date().toLocaleString([], { month: "long" })} · paid`} accent="#6d7cff" />
            <Stat icon={Sparkles} label="Auto-approved" value={money(ov.monthAuto)} sub={`limit ${money(ov.autoApproveLimit)}`} accent="#3dd68c" />
            <Stat icon={ShieldCheck} label="Owner-approved" value={money(ov.monthOwner)} sub="this month" accent="#4f8bff" />
            <Stat icon={Hourglass} label="Pending approvals" value={String(ov.pendingApprovals)} sub={ov.pendingApprovals > 0 ? "awaiting your decision" : ov.processing ? `${ov.processing} in progress` : "nothing waiting"} accent="#f5b942" attention={ov.pendingApprovals > 0} />
          </div>

          {data.pending.length > 0 && (
            <section>
              <SectionTitle title="Needs your decision" link="/payments/requests" />
              <div className="grid gap-3 xl:grid-cols-2">{data.pending.map((r) => <RequestCard key={r.id} r={r} methods={data.methods} onChanged={refresh} />)}</div>
            </section>
          )}

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section>
              <SectionTitle title="Recent transactions" link="/payments/history" />
              {data.recent.length === 0 ? (
                <EmptyState icon={CreditCard} title="No transactions yet" text="Payments made or declined by agents will appear here with the method, reason and approval path." />
              ) : (
                <ul className="glass divide-y divide-line/70 rounded-2xl">
                  {data.recent.map((t) => (
                    <li key={t.id}>
                      <button type="button" onClick={() => setOpen(t)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.04]">
                        {t.paymentMethodType ? <MethodGlyph type={t.paymentMethodType} brand={t.paymentMethodBrand} size={34} /> : <span className="grid h-[34px] w-[34px] place-items-center rounded-xl bg-white/[0.05] text-ink-3"><CreditCard className="h-4 w-4" /></span>}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-ink">{t.merchant}</span>
                          <span className="block truncate text-[11.5px] text-ink-3">{dayLabel(t.completedAt)} · {t.agentName}{t.paymentMethodLast4 ? ` · •••• ${t.paymentMethodLast4}` : ""}</span>
                        </span>
                        <span className="text-right">
                          <span className="block text-[13.5px] font-semibold num">{amountLabel(t)}</span>
                          <StatusBadge status={t.status} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <SectionTitle title="Payment methods" link="/payments/methods" />
              {data.methods.length === 0 ? (
                <EmptyState icon={CreditCard} title="No payment method" text="Add a low-limit company card or a bank account so agents can pay for approved services." action={<Link href="/payments/methods"><Button variant="primary" size="sm"><Plus className="h-3.5 w-3.5" /> Add payment method</Button></Link>} />
              ) : (
                <ul className="space-y-2">
                  {data.methods.map((m) => (
                    <li key={m.id} className="glass flex items-center gap-3 rounded-2xl px-4 py-3">
                      <MethodGlyph type={m.type} brand={m.brand} size={36} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-ink">{m.displayName}</span>
                        <span className="block truncate text-[11.5px] text-ink-3">{methodSummary(m)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
      {open && <TransactionDetail t={open} onClose={() => setOpen(null)} />}
    </AppShell>
  );
}

function Stat({ icon: Icon, label, value, sub, accent, attention }: { icon: typeof TrendingUp; label: string; value: string; sub?: string; accent: string; attention?: boolean }) {
  return (
    <div className="glass relative overflow-hidden rounded-2xl p-4">
      <div className="absolute -right-6 -top-6 h-20 w-20 rounded-full blur-2xl" style={{ background: `${accent}33` }} />
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-ink-3"><Icon className="h-3.5 w-3.5" style={{ color: accent }} /> {label}</div>
      <div className={`mt-2 text-[24px] font-semibold tracking-tight num ${attention ? "text-warning" : "text-ink"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-ink-3">{sub}</div>}
    </div>
  );
}

function SectionTitle({ title, link }: { title: string; link: string }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="text-[13px] font-semibold">{title}</h2>
      <Link href={link} className="inline-flex items-center gap-1 text-[11.5px] font-medium text-brand hover:text-ink">View all <ArrowRight className="h-3 w-3" /></Link>
    </div>
  );
}
