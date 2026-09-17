"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ListChecks } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { api, errorText, type PaymentMethod, type PaymentRequest } from "@/lib/client-api";
import { EmptyState, ErrorBox, Loading, PaymentsHeader, RequestCard, usePaymentsLive } from "@/components/payments/shared";
import { cn } from "@/lib/utils";
import { useRequestFocus } from "@/lib/use-request-focus";

type Filter = "all" | "waiting" | "auto" | "approved" | "processing" | "completed" | "rejected";

const FILTERS: { id: Filter; label: string; match: (r: PaymentRequest) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  { id: "waiting", label: "Waiting for approval", match: (r) => r.status === "WAITING_FOR_APPROVAL" || !!r.exception },
  { id: "auto", label: "Auto-approved", match: (r) => r.approvalType === "AUTOMATIC" && ["AUTO_APPROVED", "PROCESSING"].includes(r.status) },
  { id: "approved", label: "Approved", match: (r) => r.status === "APPROVED" },
  { id: "processing", label: "Processing", match: (r) => r.status === "PROCESSING" },
  { id: "completed", label: "Completed", match: (r) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(r.status) },
  { id: "rejected", label: "Rejected", match: (r) => r.status === "REJECTED" },
];

export default function PaymentRequestsPage() {
  const [requests, setRequests] = useState<PaymentRequest[] | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const focus = useRequestFocus();
  const refresh = useCallback(() => {
    Promise.all([api.paymentRequests(), api.paymentMethods()]).then(([r, m]) => { setRequests(r.requests); setMethods(m.methods); }).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  usePaymentsLive(refresh);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, (requests ?? []).filter(f.match).length])) as Record<Filter, number>, [requests]);
  const shown = (requests ?? []).filter(FILTERS.find((f) => f.id === filter)!.match);
  const waiting = shown.filter((r) => r.status === "WAITING_FOR_APPROVAL" || !!r.exception);
  const rest = shown.filter((r) => !(r.status === "WAITING_FOR_APPROVAL" || !!r.exception));

  return (
    <AppShell>
      <PaymentsHeader title="Requests" subtitle="Every payment an agent asked for. Above the automatic limit, the decision is yours." />
      <div className="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" onClick={() => setFilter(f.id)} className={cn("flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition-colors", filter === f.id ? "border-brand/60 bg-brand/15 text-ink" : "border-line text-ink-3 hover:text-ink-2")}>
            {f.label}
            <span className={cn("rounded-md px-1 text-[10px] num", filter === f.id ? "bg-brand/20" : "bg-white/[0.06]")}>{counts[f.id] ?? 0}</span>
          </button>
        ))}
      </div>
      {error && <div className="mb-4"><ErrorBox text={error} /></div>}
      {!requests && !error && <Loading />}
      {requests && shown.length === 0 && <EmptyState icon={ListChecks} title="Nothing here" text={filter === "all" ? "Agents create payment requests with request_payment when a service needs paying. They will show up here in real time." : "No requests match this filter."} />}
      {waiting.length > 0 && (
        <section className="mb-5">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-warning">Needs your decision · {waiting.length}</h2>
          <div className="grid gap-3 xl:grid-cols-2">{waiting.map((r) => <div key={r.id} {...focus.focusProps(r.id)} className={cn("rounded-2xl", focus.focusClass(r.id))}><RequestCard r={r} methods={methods} onChanged={refresh} /></div>)}</div>
        </section>
      )}
      {rest.length > 0 && (
        <section>
          {waiting.length > 0 && <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">Everything else</h2>}
          <div className="grid gap-3 xl:grid-cols-2">{rest.map((r) => <RequestCard key={r.id} r={r} methods={methods} onChanged={refresh} />)}</div>
        </section>
      )}
    </AppShell>
  );
}
