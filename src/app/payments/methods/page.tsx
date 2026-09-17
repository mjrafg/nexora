"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Plus, CreditCard, Star, Trash2, Pencil, Loader2, Check, X, Lock, Bot, PauseCircle, PlayCircle, RotateCcw, ChevronDown } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { CharCount, Field, Input, Missing, Select, Textarea, describeShortfall } from "@/components/ui/Form";

const MIN_DESCRIPTION = 20;
import { api, errorText, type PaymentMethod } from "@/lib/client-api";
import { AddPaymentMethodDialog } from "@/components/payments/AddPaymentMethodDialog";
import { EmptyState, ErrorBox, Loading, MethodGlyph, Modal, PaymentsHeader, methodSummary, usePaymentsLive, when } from "@/components/payments/shared";
import { cn } from "@/lib/utils";

export default function PaymentMethodsPage() {
  const [methods, setMethods] = useState<PaymentMethod[] | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PaymentMethod | null>(null);
  const [open, setOpen] = useState<PaymentMethod | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => { api.paymentMethods().then((r) => { setMethods(r.methods); setDefaultId(r.defaultId); }).catch((e) => setError(errorText(e))); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  usePaymentsLive(refresh);

  async function makeDefault(id: string) {
    setBusy(id);
    try { await api.updatePaymentSettings({ defaultPaymentMethodId: id }); refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function toggle(m: PaymentMethod) {
    setBusy(m.id);
    try { await api.updatePaymentMethod(m.id, { status: m.status === "DISABLED" ? "AVAILABLE" : "DISABLED" }); refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function remove(m: PaymentMethod) {
    if (!window.confirm(`Remove ${m.displayName} (•••• ${m.last4})? Past transactions keep their masked details.`)) return;
    setBusy(m.id);
    try { await api.deletePaymentMethod(m.id); refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }

  const missing = (methods ?? []).filter((m) => !m.description).length;

  return (
    <AppShell>
      <PaymentsHeader title="Payment Methods" subtitle="What agents may pay with. They choose by the usage description; only the last four digits are ever shown again." action={<Button variant="primary" size="sm" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" /> Add Payment Method</Button>} />
      {error && <div className="mb-4"><ErrorBox text={error} /></div>}
      {!methods && !error && <Loading />}
      {methods && methods.length === 0 && (
        <EmptyState icon={CreditCard} title="No payment methods yet" text="Add a low-limit company card or a bank account with a usage description. Secrets are encrypted in the vault and typed into checkouts by Nexora — agents never see them." action={<Button variant="primary" size="sm" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" /> Add Payment Method</Button>} />
      )}
      {missing > 0 && <div className="mb-4 rounded-xl border border-warning/30 bg-warning/[0.08] px-3 py-2 text-[12px] text-warning">{missing === 1 ? "One payment method has" : `${missing} payment methods have`} no usage description yet — agents need it to choose correctly. Edit to add one.</div>}
      {methods && methods.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {methods.map((m) => {
            const disabled = m.status === "DISABLED";
            return (
              <div key={m.id} className={cn("glass group relative flex flex-col overflow-hidden rounded-2xl p-5", disabled && "opacity-70")}>
                <div className="absolute -right-10 -top-10 h-32 w-32 rounded-full blur-3xl" style={{ background: m.type === "CARD" ? "rgba(109,124,255,0.25)" : "rgba(61,214,140,0.22)" }} />
                <button type="button" onClick={() => setOpen(m)} className="relative -m-2 flex-1 rounded-xl p-2 text-left transition-colors hover:bg-white/[0.03]">
                  <div className="flex items-start gap-3">
                    <MethodGlyph type={m.type} brand={m.brand} size={46} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-[15px] font-semibold tracking-tight text-ink">{m.displayName}</h3>
                        {defaultId === m.id && <Badge color="#6d7cff" dot>Default</Badge>}
                        {disabled && <Badge color="#6f7890" dot>Disabled</Badge>}
                      </div>
                      <div className="mt-0.5 text-[12px] text-ink-3">{methodSummary(m)}</div>
                    </div>
                  </div>
                  <div className="mt-4 font-mono text-[19px] tracking-[0.14em] text-ink">•••• {m.last4}</div>
                  <div className="mt-3">
                    <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">Usage</div>
                    {m.description ? <p className="mt-1 line-clamp-3 text-[12.5px] leading-relaxed text-ink-2">{m.description}</p> : <p className="mt-1 text-[12.5px] italic text-warning/90">No usage description yet.</p>}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-3">
                    <span>{m.type === "CARD" ? m.cardholderName : m.accountHolderName}</span>
                    {m.createdBy !== "owner" && <span className="inline-flex items-center gap-1"><Bot className="h-3 w-3" /> Saved by an agent</span>}
                    {m.useCount > 0 && <span>Used {m.useCount}×</span>}
                  </div>
                </button>
                <div className="relative mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  {defaultId !== m.id && !disabled && <Button variant="ghost" size="xs" disabled={busy === m.id} onClick={() => makeDefault(m.id)}><Star className="h-3 w-3" /> Make default</Button>}
                  <Button variant="ghost" size="xs" onClick={() => setEditing(m)}><Pencil className="h-3 w-3" /> Edit</Button>
                  <Button variant="ghost" size="xs" disabled={busy === m.id} onClick={() => toggle(m)}>{disabled ? <><PlayCircle className="h-3 w-3" /> Enable</> : <><PauseCircle className="h-3 w-3" /> Disable</>}</Button>
                  <Button variant="danger" size="xs" className="ml-auto" disabled={busy === m.id} onClick={() => remove(m)}>{busy === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Remove</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-6 max-w-2xl text-[11.5px] leading-relaxed text-ink-3">
        <Lock className="mr-1 inline h-3 w-3" /> Card and bank details are encrypted in the Nexora vault. For an approved payment, Nexora types them straight into the agent&apos;s browser checkout; the agent only ever sees names, last four digits and usage descriptions. Removal is owner-only. This MVP storage is temporary: replace it with tokenized or virtual-card infrastructure before wider production use.
      </p>
      {adding && <AddPaymentMethodDialog onClose={() => setAdding(false)} onAdded={() => { setAdding(false); refresh(); }} />}
      {editing && <EditDialog m={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {open && <DetailDialog m={open} isDefault={defaultId === open.id} onClose={() => setOpen(null)} onEdit={() => { setEditing(open); setOpen(null); }} />}
    </AppShell>
  );
}

/* ---------------------------------------------------------------- detail */

function DetailDialog({ m, isDefault, onClose, onEdit }: { m: PaymentMethod; isDefault: boolean; onClose: () => void; onEdit: () => void }) {
  const card = m.type === "CARD";
  const addr = m.billing ? [m.billing.line1, m.billing.city, m.billing.region, m.billing.postalCode, m.billing.country].filter(Boolean).join(", ") : "";
  const rows: [string, ReactNode][] = [
    ["Status", <span key="s" className="inline-flex gap-2"><Badge color={m.status === "DISABLED" ? "#6f7890" : "#3dd68c"} dot>{m.status === "DISABLED" ? "Disabled" : "Available"}</Badge>{isDefault && <Badge color="#6d7cff" dot>Default</Badge>}</span>],
    [card ? "Cardholder" : "Account holder", card ? m.cardholderName : m.accountHolderName],
    ...(card ? [["Expires", <span key="e" className="num">{String(m.expirationMonth).padStart(2, "0")}/{String(m.expirationYear).slice(-2)}</span>] as [string, ReactNode], ["Security code", m.secretKeys.includes("CVV") ? <span key="c" className="inline-flex items-center gap-1 text-ink-2"><Lock className="h-3 w-3" /> stored in vault</span> : <span key="c" className="text-ink-3">not stored</span>] as [string, ReactNode]] : [["Bank", m.bankName || "—"] as [string, ReactNode], ["Account type", m.accountType === "SAVINGS" ? "Savings" : "Checking"] as [string, ReactNode]]),
    [card ? "Billing address" : "Address", addr || "—"],
    ["Added", `${when(m.createdAt)} · ${m.createdBy === "owner" ? "by you" : "by an agent"}`],
    ["Last used", m.lastUsedAt ? `${when(m.lastUsedAt)} · ${m.useCount}× total` : "never"],
  ];
  return (
    <Modal title={m.displayName} subtitle={`${card ? m.brand : m.accountType === "SAVINGS" ? "Savings" : "Checking"} •••• ${m.last4}`} onClose={onClose}>
      <div className="flex items-center gap-4">
        <MethodGlyph type={m.type} brand={m.brand} size={56} />
        <div className="font-mono text-[22px] tracking-[0.16em] text-ink">•••• •••• •••• {m.last4}</div>
      </div>
      <div className="mt-4 rounded-xl border border-line bg-white/[0.03] px-3.5 py-3">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">Usage</div>
        <p className="mt-1 text-[13px] leading-relaxed text-ink">{m.description || <span className="italic text-warning/90">No usage description yet — agents need it to choose this method correctly.</span>}</p>
      </div>
      <dl className="mt-4 grid grid-cols-[130px_1fr] gap-y-2.5 text-[12.5px]">
        {rows.map(([k, v]) => <FragmentRow key={k} k={k} v={v} />)}
      </dl>
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-4">
        <span className="flex items-center gap-1.5 text-[11px] text-ink-3"><Lock className="h-3 w-3" /> Full numbers are never displayed.</span>
        <Button variant="outline" size="sm" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
      </div>
    </Modal>
  );
}

function FragmentRow({ k, v }: { k: string; v: ReactNode }) {
  return (<><dt className="text-ink-3">{k}</dt><dd className="min-w-0 break-words text-ink">{v}</dd></>);
}

/* ---------------------------------------------------------------- edit */

function EditDialog({ m, onClose, onSaved }: { m: PaymentMethod; onClose: () => void; onSaved: () => void }) {
  const card = m.type === "CARD";
  const [form, setForm] = useState({
    displayName: m.displayName, description: m.description ?? "", holder: (card ? m.cardholderName : m.accountHolderName) ?? "", bankName: m.bankName ?? "",
    expirationMonth: card ? String(m.expirationMonth ?? "").padStart(2, "0") : "", expirationYear: card ? String(m.expirationYear ?? "") : "", accountType: m.accountType ?? "CHECKING", status: m.status,
    line1: m.billing?.line1 ?? "", city: m.billing?.city ?? "", region: m.billing?.region ?? "", postalCode: m.billing?.postalCode ?? "", country: m.billing?.country ?? "",
    cardNumber: "", cvv: "", routingNumber: "", accountNumber: "",
  });
  const [rotate, setRotate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const problems = [
    !form.displayName.trim() && "a name",
    describeShortfall("a longer usage description", form.description, MIN_DESCRIPTION),
  ].filter((x): x is string => typeof x === "string");
  const valid = problems.length === 0;
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { displayName: form.displayName, description: form.description, status: form.status, billing: { line1: form.line1, city: form.city, region: form.region, postalCode: form.postalCode, country: form.country } };
      if (card) { body.cardholderName = form.holder; body.expirationMonth = form.expirationMonth; body.expirationYear = form.expirationYear; }
      else { body.accountHolderName = form.holder; body.bankName = form.bankName; body.accountType = form.accountType; }
      if (rotate) {
        if (card) { if (form.cardNumber.trim()) body.cardNumber = form.cardNumber; if (form.cvv.trim()) body.cvv = form.cvv; }
        else { if (form.routingNumber.trim()) body.routingNumber = form.routingNumber; if (form.accountNumber.trim()) body.accountNumber = form.accountNumber; }
      }
      await api.updatePaymentMethod(m.id, body);
      onSaved();
    } catch (e) { setErr(errorText(e)); setBusy(false); }
  }
  return (
    <Modal title={`Edit ${m.displayName}`} subtitle={`${methodSummary(m)} · current numbers are never shown; you can replace them below.`} onClose={onClose} width="max-w-xl">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2"><Input value={form.displayName} onChange={set("displayName")} autoFocus /></Field>
        <Field
          label="Usage description"
          className="sm:col-span-2"
          hint={
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span>Agents read this to decide which method fits a checkout. Say what it is, when to use it and when not to.</span>
              <CharCount value={form.description} min={MIN_DESCRIPTION} />
            </span>
          }
        >
          <Textarea rows={3} value={form.description} onChange={set("description")} placeholder={card ? "Use this low-limit card for one-time online purchases made by Nexora agents. Do not use it for recurring subscriptions." : "Use this checking account for ACH payments when the vendor does not accept card payment."} />
        </Field>
        <Field label={card ? "Cardholder name" : "Account holder name"} className={card ? "sm:col-span-2" : ""}><Input value={form.holder} onChange={set("holder")} /></Field>
        {!card && <Field label="Bank name"><Input value={form.bankName} onChange={set("bankName")} placeholder="Optional" /></Field>}
        {card ? (
          <>
            <Field label="Expiration month"><Input value={form.expirationMonth} onChange={(e) => setForm({ ...form, expirationMonth: e.target.value.replace(/\D/g, "").slice(0, 2) })} inputMode="numeric" placeholder="MM" /></Field>
            <Field label="Expiration year"><Input value={form.expirationYear} onChange={(e) => setForm({ ...form, expirationYear: e.target.value.replace(/\D/g, "").slice(0, 4) })} inputMode="numeric" placeholder="YYYY" /></Field>
          </>
        ) : (
          <Field label="Account type" className="sm:col-span-2">
            <Select value={form.accountType} onChange={set("accountType")}><option value="CHECKING">Checking</option><option value="SAVINGS">Savings</option></Select>
          </Field>
        )}
        <Field label="Status" className="sm:col-span-2" hint="Disabled methods stay in history but agents cannot choose or use them.">
          <Select value={form.status} onChange={set("status")}><option value="AVAILABLE">Available to agents</option><option value="DISABLED">Disabled</option></Select>
        </Field>
      </div>
      <div className="mt-3 rounded-xl border border-line bg-white/[0.02] p-3">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">{card ? "Billing address" : "Company address"}</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Address" className="sm:col-span-2"><Input value={form.line1} onChange={set("line1")} /></Field>
          <Field label="City"><Input value={form.city} onChange={set("city")} /></Field>
          <Field label="State / Region"><Input value={form.region} onChange={set("region")} /></Field>
          <Field label="ZIP / Postal code"><Input value={form.postalCode} onChange={set("postalCode")} /></Field>
          <Field label="Country"><Input value={form.country} onChange={set("country")} /></Field>
        </div>
      </div>
      <div className="mt-3 rounded-xl border border-line bg-white/[0.02]">
        <button type="button" onClick={() => setRotate((v) => !v)} className="flex w-full items-center justify-between px-3 py-2.5 text-left text-[12px] text-ink-2 hover:text-ink">
          <span className="flex items-center gap-1.5"><RotateCcw className="h-3.5 w-3.5" /> Replace {card ? "card number / CVV" : "routing / account number"}</span>
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", rotate && "rotate-180")} />
        </button>
        {rotate && (
          <div className="grid gap-3 border-t border-line p-3 sm:grid-cols-2">
            {card ? (
              <>
                <Field label="New card number"><Input value={form.cardNumber} onChange={(e) => setForm({ ...form, cardNumber: e.target.value.replace(/\D/g, "").slice(0, 19).replace(/(\d{4})(?=\d)/g, "$1 ") })} inputMode="numeric" autoComplete="off" placeholder="Leave empty to keep" className="font-mono tracking-wider" /></Field>
                <Field label="New CVV"><Input value={form.cvv} onChange={(e) => setForm({ ...form, cvv: e.target.value.replace(/\D/g, "").slice(0, 4) })} type="password" inputMode="numeric" autoComplete="off" placeholder="Leave empty to keep" /></Field>
              </>
            ) : (
              <>
                <Field label="New routing number"><Input value={form.routingNumber} onChange={(e) => setForm({ ...form, routingNumber: e.target.value.replace(/\D/g, "").slice(0, 9) })} inputMode="numeric" autoComplete="off" placeholder="Leave empty to keep" className="font-mono tracking-wider" /></Field>
                <Field label="New account number"><Input value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value.replace(/\D/g, "").slice(0, 17) })} type="password" inputMode="numeric" autoComplete="off" placeholder="Leave empty to keep" className="font-mono tracking-wider" /></Field>
              </>
            )}
          </div>
        )}
      </div>
      {err && <div className="mt-3"><ErrorBox text={err} /></div>}
      <div className="sticky -bottom-4 -mx-5 mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line bg-bg-2/95 px-5 py-3 backdrop-blur">
        {valid
          ? <span className="flex items-center gap-1.5 text-[11px] text-ink-3"><Lock className="h-3 w-3" /> New numbers go straight to the vault.</span>
          : <Missing problems={problems} />}
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}><X className="h-3.5 w-3.5" /> Cancel</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={busy || !valid}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save changes</Button>
        </div>
      </div>
    </Modal>
  );
}
