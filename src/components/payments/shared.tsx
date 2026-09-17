"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, CreditCard, ListChecks, History, Settings, Landmark, X, Loader2, CheckCircle2, XCircle, Hourglass, AlertTriangle, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { api, errorText, type PaymentMethod, type PaymentRequest, type PaymentTransaction } from "@/lib/client-api";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- formatting */

export function money(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

export function amountLabel(r: { amount: number; currency: string; billingType: string; interval?: string }): string {
  return `${money(r.amount, r.currency)}${r.billingType === "RECURRING" ? ` / ${r.interval === "YEARLY" ? "year" : "month"}` : ""}`;
}

export function when(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/* ---------------------------------------------------------------- nav */

const TABS = [
  { href: "/payments", label: "Overview", icon: LayoutDashboard },
  { href: "/payments/methods", label: "Payment Methods", icon: CreditCard },
  { href: "/payments/requests", label: "Requests", icon: ListChecks },
  { href: "/payments/history", label: "History", icon: History },
  { href: "/payments/settings", label: "Settings", icon: Settings },
];

export function PaymentsHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">Payments</div>
          <h1 className="mt-0.5 text-[22px] font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-0.5 text-[12.5px] text-ink-3">{subtitle}</p>}
        </div>
        {action}
      </div>
      <nav className="mt-4 -mx-1 flex gap-1 overflow-x-auto border-b border-line px-1">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = href === "/payments" ? pathname === href : pathname.startsWith(href);
          return (
            <Link key={href} href={href} className={cn("flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[12.5px] transition-colors", active ? "border-brand text-ink" : "border-transparent text-ink-3 hover:text-ink-2")}>
              <Icon className="h-3.5 w-3.5" /> {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** Re-run `onEvent` whenever the payments channel emits (owner decisions, agent progress). */
export function usePaymentsLive(onEvent: () => void) {
  useEffect(() => {
    const es = new EventSource("/api/payments/events");
    let t: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = () => { if (t) clearTimeout(t); t = setTimeout(onEvent, 300); };
    return () => { es.close(); if (t) clearTimeout(t); };
  }, [onEvent]);
}

/* ---------------------------------------------------------------- badges */

const STATUS: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  AUTO_APPROVED: { label: "Auto-approved", color: "#3dd68c", icon: Sparkles },
  WAITING_FOR_APPROVAL: { label: "Needs approval", color: "#f5b942", icon: Hourglass },
  APPROVED: { label: "Owner approved", color: "#4f8bff", icon: ShieldCheck },
  REJECTED: { label: "Rejected", color: "#ff5c7a", icon: XCircle },
  PROCESSING: { label: "Processing", color: "#a78bfa", icon: Loader2 },
  SUCCEEDED: { label: "Paid", color: "#3dd68c", icon: CheckCircle2 },
  FAILED: { label: "Failed", color: "#ff5c7a", icon: XCircle },
  CANCELLED: { label: "Cancelled", color: "#6f7890", icon: XCircle },
};

export function StatusBadge({ status, exception }: { status: string; exception?: string }) {
  if (exception) return <Badge color="#f5b942" dot>Needs review</Badge>;
  const s = STATUS[status] ?? { label: status, color: "#6f7890", icon: Hourglass };
  return <Badge color={s.color} dot>{s.label}</Badge>;
}

export function ApprovalLabel({ type }: { type: string }) {
  const map: Record<string, string> = { AUTOMATIC: "Automatic", OWNER: "Owner approved", REJECTED: "Rejected", NONE: "Pending" };
  return <span>{map[type] ?? type}</span>;
}

/* ---------------------------------------------------------------- payment method visuals */

export function MethodGlyph({ type, brand, size = 40 }: { type: "CARD" | "BANK_ACCOUNT"; brand?: string; size?: number }) {
  const card = type === "CARD";
  const bg = card ? (brand === "Mastercard" ? "linear-gradient(135deg,#ff8a3d,#e04a3a)" : brand === "American Express" ? "linear-gradient(135deg,#2fd4e6,#3b7bff)" : "linear-gradient(135deg,#6d7cff,#2fd4e6)") : "linear-gradient(135deg,#3dd68c,#1f9e6a)";
  const Icon = card ? CreditCard : Landmark;
  return (
    <span className="grid shrink-0 place-items-center rounded-xl text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]" style={{ width: size, height: size, background: bg }}>
      <Icon className="h-[45%] w-[45%]" strokeWidth={1.9} />
    </span>
  );
}

export function MethodChip({ type, name, last4, brand }: { type?: "CARD" | "BANK_ACCOUNT"; name?: string; last4?: string; brand?: string }) {
  if (!type || !name) return <span className="text-ink-3">Not selected</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <MethodGlyph type={type} brand={brand} size={20} />
      <span className="text-ink">{name}</span>
      <span className="font-mono text-[11.5px] text-ink-3">•••• {last4}</span>
    </span>
  );
}

export function methodSummary(m: PaymentMethod): string {
  return m.type === "CARD" ? `${m.brand} •••• ${m.last4} · Expires ${String(m.expirationMonth).padStart(2, "0")}/${String(m.expirationYear).slice(-2)}` : `${m.accountType === "SAVINGS" ? "Savings" : "Checking"} •••• ${m.last4}${m.bankName ? ` · ${m.bankName}` : ""}`;
}

/* ---------------------------------------------------------------- modal */

export function Modal({ title, subtitle, onClose, children, width = "max-w-lg" }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; width?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div className={cn("glass-strong max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-line-2 shadow-2xl sm:rounded-2xl", width)} onClick={(e) => e.stopPropagation()}>
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[12px] text-ink-3">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-ink-3 hover:bg-white/[0.06] hover:text-ink"><X className="h-4 w-4" /></button>
        </header>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, text, action }: { icon: typeof CreditCard; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="glass grid place-items-center rounded-2xl px-6 py-12 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white/[0.05] text-ink-3"><Icon className="h-5 w-5" /></span>
      <h3 className="mt-3 text-[14px] font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-[12.5px] text-ink-3">{text}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Loading({ text = "Loading…" }: { text?: string }) {
  return <div className="flex items-center gap-2 py-8 text-[12.5px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> {text}</div>;
}

export function ErrorBox({ text }: { text: string }) {
  return <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-[#ff8ea3]"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {text}</div>;
}

/* ---------------------------------------------------------------- request / approval card */

export function RequestCard({ r, methods, onChanged, compact }: { r: PaymentRequest; methods: PaymentMethod[]; onChanged: () => void; compact?: boolean }) {
  const [methodId, setMethodId] = useState<string>(r.selectedPaymentMethodId ?? "");
  const available = methods.filter((x) => x.status !== "DISABLED");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const live = methods.find((x) => x.id === (r.selectedPaymentMethodId ?? methodId));
  const m = live ?? (r.methodSnapshot ? { type: r.methodSnapshot.type, displayName: r.methodSnapshot.displayName, last4: r.methodSnapshot.last4, brand: r.methodSnapshot.brand } : undefined);
  const waiting = r.status === "WAITING_FOR_APPROVAL";
  async function act(kind: "approve" | "reject" | "cancel" | "ok" | "fail") {
    setBusy(kind);
    setErr(null);
    try {
      if (kind === "approve") await api.approvePayment(r.id, methodId || null, note.trim() || undefined);
      else if (kind === "reject") await api.rejectPayment(r.id, note.trim() || undefined);
      else if (kind === "cancel") await api.cancelPayment(r.id, note.trim() || undefined);
      else await api.resolvePaymentException(r.id, kind === "ok" ? "SUCCEEDED" : "FAILED", note.trim() || undefined);
      onChanged();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className={cn("glass rounded-2xl p-4", waiting && "border border-warning/30 shadow-[0_0_0_1px_rgba(245,185,66,0.12),0_16px_40px_-24px_rgba(245,185,66,0.5)]", r.exception && "border border-warning/40")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {waiting && <div className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-warning"><Hourglass className="h-3 w-3" /> Payment approval</div>}
          <div className="text-[15px] font-semibold tracking-tight text-ink">{r.merchant}</div>
          <div className="mt-0.5 text-[12px] text-ink-3">Requested by <span className="text-ink-2">{r.requestedByName}</span> · {when(r.createdAt)}</div>
        </div>
        <div className="text-right">
          <div className="text-[20px] font-semibold tracking-tight num">{amountLabel(r)}</div>
          <div className="mt-1 flex justify-end"><StatusBadge status={r.status} exception={r.exception} /></div>
        </div>
      </div>
      {!compact && (
        <dl className="mt-3 grid grid-cols-[110px_1fr] gap-y-1.5 text-[12.5px]">
          <dt className="text-ink-3">Reason</dt><dd className="text-ink-2">{r.reason || "—"}</dd>
          {r.recommendation && <><dt className="text-ink-3">Recommendation</dt><dd className="text-ink-2">{r.recommendation}</dd></>}
          <dt className="text-ink-3">Payment method</dt>
          <dd>{m ? <MethodChip type={m.type} name={m.displayName} last4={m.last4} brand={m.brand} /> : waiting ? <span className="text-ink-3">Not selected yet</span> : ["AUTO_APPROVED", "APPROVED"].includes(r.status) ? <span className="text-ink-3">Agent chooses at checkout by usage description</span> : <span className="text-ink-3">Not selected</span>}</dd>
          <dt className="text-ink-3">Threshold</dt><dd className="text-ink-2 num">{money(r.approvalThresholdAtCreation)} automatic limit at request time</dd>
          {r.exception && <><dt className="text-warning">Exception</dt><dd className="text-warning">{r.exception}</dd></>}
          {r.ownerNote && <><dt className="text-ink-3">Your note</dt><dd className="text-ink-2">{r.ownerNote}</dd></>}
        </dl>
      )}
      {(waiting || r.exception || ["AUTO_APPROVED", "APPROVED", "PROCESSING"].includes(r.status)) && (
        <div className="mt-4 space-y-2 border-t border-line pt-3">
          {waiting && (
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <div className="relative">
                <select value={methodId} onChange={(e) => setMethodId(e.target.value)} className="h-9 w-full appearance-none rounded-lg border border-line bg-white/[0.04] px-3 pr-8 text-[13px] text-ink outline-none focus:border-brand/60">
                  {available.length === 0 ? <option value="">No payment method available</option> : <option value="">Let the agent choose by usage description (recommended)</option>}
                  {available.map((x) => <option key={x.id} value={x.id}>Only: {x.displayName} •••• {x.last4}</option>)}
                </select>
              </div>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note for the agent" className="h-9 rounded-lg border border-line bg-white/[0.04] px-3 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-brand/60" />
            </div>
          )}
          {err && <ErrorBox text={err} />}
          <div className="flex flex-wrap gap-2">
            {waiting && (
              <>
                <Button variant="success" size="sm" disabled={!!busy || available.length === 0} onClick={() => act("approve")}>{busy === "approve" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Approve</Button>
                <Button variant="danger" size="sm" disabled={!!busy} onClick={() => act("reject")}>{busy === "reject" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />} Reject</Button>
                <Link href={`/agents/${r.requestedByAgentId}`}><Button variant="ghost" size="sm">Discuss</Button></Link>
              </>
            )}
            {r.exception && (
              <>
                <Button variant="success" size="sm" disabled={!!busy} onClick={() => act("ok")}>Confirm paid {money(r.actualAmount ?? r.amount)}</Button>
                <Button variant="danger" size="sm" disabled={!!busy} onClick={() => act("fail")}>Mark failed</Button>
              </>
            )}
            {!waiting && !r.exception && ["AUTO_APPROVED", "APPROVED", "PROCESSING"].includes(r.status) && (
              <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act("cancel")}>{busy === "cancel" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Cancel request</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- transaction detail */

export function TransactionDetail({ t, onClose }: { t: PaymentTransaction; onClose: () => void }) {
  const [exec, setExec] = useState<string | null>(null);
  useEffect(() => {
    api.paymentRequest(t.paymentRequestId).then((r) => setExec(r.request.id)).catch(() => undefined);
  }, [t.paymentRequestId]);
  const rows: [string, ReactNode][] = [
    ["Merchant", t.merchant],
    ["Amount", <span key="a" className="num">{money(t.amount, t.currency)}{t.billingType === "RECURRING" ? ` / ${t.interval === "YEARLY" ? "year" : "month"}` : ""}</span>],
    ["Currency", t.currency],
    ["Status", <StatusBadge key="s" status={t.status} />],
    ["Requested by", t.agentName],
    ["Reason", t.reason || "—"],
    ["Payment method", <MethodChip key="m" type={t.paymentMethodType} name={t.paymentMethodDisplayName} last4={t.paymentMethodLast4} brand={t.paymentMethodBrand} />],
    ["Approval", <ApprovalLabel key="ap" type={t.approvalType} />],
    ["Threshold at request", <span key="th" className="num">{money(t.approvalThreshold)}</span>],
    ["Requested at", when(t.requestedAt)],
    ["Approved at", t.approvedAt ? `${when(t.approvedAt)}${t.approvedBy ? ` · ${t.approvedBy}` : ""}` : "—"],
    ["Completed at", when(t.completedAt)],
    ["External reference", t.externalReference ? <span key="x" className="font-mono text-[12px]">{t.externalReference}</span> : "—"],
    ["Execution ID", <span key="e" className="font-mono text-[11.5px] text-ink-3">{exec ?? t.paymentRequestId}</span>],
  ];
  return (
    <Modal title={t.merchant} subtitle={`${dayLabel(t.completedAt)} · ${money(t.amount, t.currency)}`} onClose={onClose}>
      <dl className="grid grid-cols-[150px_1fr] gap-y-2.5 text-[12.5px]">
        {rows.map(([k, v]) => <FragmentRow key={k} k={k} v={v} />)}
      </dl>
      {t.note && <p className="mt-3 rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-[12px] text-ink-2">{t.note}</p>}
    </Modal>
  );
}

function FragmentRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt className="text-ink-3">{k}</dt>
      <dd className="min-w-0 break-words text-ink">{v}</dd>
    </>
  );
}
