"use client";

import { useState } from "react";
import { CreditCard, Landmark, Loader2, Lock, ArrowLeft, Check } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CharCount, Field, Input, Missing, Select, Textarea, describeShortfall } from "@/components/ui/Form";
import { api, errorText, type PaymentMethod } from "@/lib/client-api";
import { cn } from "@/lib/utils";
import { ErrorBox, MethodGlyph, Modal } from "./shared";

type Kind = "CARD" | "BANK_ACCOUNT";

const MIN_DESCRIPTION = 20;

function brandOf(n: string): string {
  const d = n.replace(/\D/g, "");
  if (/^4/.test(d)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(d)) return "Mastercard";
  if (/^3[47]/.test(d)) return "American Express";
  if (/^6(011|5)/.test(d)) return "Discover";
  return "Card";
}

function formatCard(v: string): string {
  return v.replace(/\D/g, "").slice(0, 19).replace(/(\d{4})(?=\d)/g, "$1 ");
}

function HintWithCount({ value }: { value: string }) {
  return (
    <span className="flex flex-wrap items-center justify-between gap-2">
      <span>Agents read this to decide which method fits a checkout. Say what it is, when to use it and when not to.</span>
      <CharCount value={value} min={MIN_DESCRIPTION} />
    </span>
  );
}

export function AddPaymentMethodDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (m: PaymentMethod) => void }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [card, setCard] = useState({ displayName: "", description: "", cardholderName: "", cardNumber: "", expirationMonth: "", expirationYear: "", cvv: "", line1: "", city: "", region: "", postalCode: "", country: "US" });
  const [bank, setBank] = useState({ displayName: "", description: "", accountHolderName: "", bankName: "", routingNumber: "", accountNumber: "", accountType: "CHECKING", line1: "", city: "", region: "", postalCode: "", country: "US" });

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const body = kind === "CARD"
        ? { type: "CARD", displayName: card.displayName, description: card.description, cardholderName: card.cardholderName, cardNumber: card.cardNumber, expirationMonth: Number(card.expirationMonth), expirationYear: Number(card.expirationYear), cvv: card.cvv || undefined, billing: { line1: card.line1, city: card.city, region: card.region, postalCode: card.postalCode, country: card.country } }
        : { type: "BANK_ACCOUNT", displayName: bank.displayName, description: bank.description, accountHolderName: bank.accountHolderName, bankName: bank.bankName, routingNumber: bank.routingNumber, accountNumber: bank.accountNumber, accountType: bank.accountType, billing: { line1: bank.line1, city: bank.city, region: bank.region, postalCode: bank.postalCode, country: bank.country } };
      const r = await api.addPaymentMethod(body);
      onAdded(r.method);
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  }

  // exactly what is still missing, so the save button is never a dead end
  const cardProblems = [
    !card.displayName.trim() && "a name for this card",
    describeShortfall("a longer usage description", card.description, MIN_DESCRIPTION),
    !card.cardholderName.trim() && "the cardholder name",
    card.cardNumber.replace(/\D/g, "").length < 12 && "a full card number",
    !(Number(card.expirationMonth) >= 1 && Number(card.expirationMonth) <= 12) && "an expiry month (1-12)",
    !/^\d{2,4}$/.test(card.expirationYear) && "an expiry year",
  ].filter((x): x is string => typeof x === "string");
  const bankProblems = [
    !bank.displayName.trim() && "a name for this account",
    describeShortfall("a longer usage description", bank.description, MIN_DESCRIPTION),
    !bank.accountHolderName.trim() && "the account holder name",
    !/^\d{9}$/.test(bank.routingNumber.replace(/\D/g, "")) && "a 9-digit routing number",
    bank.accountNumber.replace(/\D/g, "").length < 4 && "the account number",
  ].filter((x): x is string => typeof x === "string");
  const problems = kind === "CARD" ? cardProblems : bankProblems;
  const valid = problems.length === 0;

  return (
    <Modal title={kind === null ? "Add payment method" : kind === "CARD" ? "Add card" : "Add bank account"} subtitle={kind === null ? "Choose what the company will pay with." : "Secrets are encrypted in the vault and only released for approved payments."} onClose={onClose} width="max-w-xl">
      {kind === null ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {([["CARD", "Card", "Visa, Mastercard, Amex, Discover", CreditCard], ["BANK_ACCOUNT", "Bank account", "US checking or savings (ACH)", Landmark]] as const).map(([k, label, sub, Icon]) => (
            <button key={k} type="button" onClick={() => setKind(k)} className="group flex items-center gap-3 rounded-2xl border border-line bg-white/[0.03] p-4 text-left transition-colors hover:border-brand/50 hover:bg-white/[0.06]">
              <MethodGlyph type={k} size={44} />
              <span>
                <span className="block text-[14px] font-semibold text-ink">{label}</span>
                <span className="block text-[11.5px] text-ink-3">{sub}</span>
              </span>
              <Icon className="ml-auto h-4 w-4 text-ink-3 group-hover:text-brand" />
            </button>
          ))}
        </div>
      ) : kind === "CARD" ? (
        <div className="space-y-4">
          <CardPreview name={card.cardholderName} number={card.cardNumber} month={card.expirationMonth} year={card.expirationYear} label={card.displayName} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2"><Input value={card.displayName} onChange={(e) => setCard({ ...card, displayName: e.target.value })} placeholder="Agent One-Time Card" autoFocus /></Field>
            <Field label="Usage description" className="sm:col-span-2" hint={<HintWithCount value={card.description} />}>
              <Textarea rows={3} value={card.description} onChange={(e) => setCard({ ...card, description: e.target.value })} placeholder="Use this low-limit card for one-time online purchases made by Nexora agents. Do not use it for recurring subscriptions." />
            </Field>
            <Field label="Cardholder name" className="sm:col-span-2"><Input value={card.cardholderName} onChange={(e) => setCard({ ...card, cardholderName: e.target.value })} placeholder="Name as printed on the card" /></Field>
            <Field label="Card number" className="sm:col-span-2"><Input value={card.cardNumber} onChange={(e) => setCard({ ...card, cardNumber: formatCard(e.target.value) })} inputMode="numeric" autoComplete="off" placeholder="1234 5678 9012 3456" className="font-mono tracking-wider" /></Field>
            <Field label="Expiration month"><Input value={card.expirationMonth} onChange={(e) => setCard({ ...card, expirationMonth: e.target.value.replace(/\D/g, "").slice(0, 2) })} inputMode="numeric" placeholder="MM" /></Field>
            <Field label="Expiration year"><Input value={card.expirationYear} onChange={(e) => setCard({ ...card, expirationYear: e.target.value.replace(/\D/g, "").slice(0, 4) })} inputMode="numeric" placeholder="YYYY" /></Field>
            <Field label="CVV" hint="Optional. Stored isolated in the vault; needed by most checkouts."><Input value={card.cvv} onChange={(e) => setCard({ ...card, cvv: e.target.value.replace(/\D/g, "").slice(0, 4) })} type="password" inputMode="numeric" autoComplete="off" placeholder="•••" /></Field>
          </div>
          <div className="rounded-xl border border-line bg-white/[0.02] p-3">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Billing address</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Address" className="sm:col-span-2"><Input value={card.line1} onChange={(e) => setCard({ ...card, line1: e.target.value })} placeholder="Street and number" /></Field>
              <Field label="City"><Input value={card.city} onChange={(e) => setCard({ ...card, city: e.target.value })} /></Field>
              <Field label="State / Region"><Input value={card.region} onChange={(e) => setCard({ ...card, region: e.target.value })} /></Field>
              <Field label="ZIP / Postal code"><Input value={card.postalCode} onChange={(e) => setCard({ ...card, postalCode: e.target.value })} /></Field>
              <Field label="Country"><Input value={card.country} onChange={(e) => setCard({ ...card, country: e.target.value })} placeholder="US" /></Field>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2"><Input value={bank.displayName} onChange={(e) => setBank({ ...bank, displayName: e.target.value })} placeholder="Company Checking" autoFocus /></Field>
            <Field label="Usage description" className="sm:col-span-2" hint={<HintWithCount value={bank.description} />}>
              <Textarea rows={3} value={bank.description} onChange={(e) => setBank({ ...bank, description: e.target.value })} placeholder="Use this checking account for ACH payments when the vendor does not accept card payment." />
            </Field>
            <Field label="Account holder name"><Input value={bank.accountHolderName} onChange={(e) => setBank({ ...bank, accountHolderName: e.target.value })} /></Field>
            <Field label="Bank name" hint="Optional"><Input value={bank.bankName} onChange={(e) => setBank({ ...bank, bankName: e.target.value })} placeholder="e.g. Mercury" /></Field>
            <Field label="Routing number"><Input value={bank.routingNumber} onChange={(e) => setBank({ ...bank, routingNumber: e.target.value.replace(/\D/g, "").slice(0, 9) })} inputMode="numeric" autoComplete="off" placeholder="9 digits" className="font-mono tracking-wider" /></Field>
            <Field label="Account number"><Input value={bank.accountNumber} onChange={(e) => setBank({ ...bank, accountNumber: e.target.value.replace(/\D/g, "").slice(0, 17) })} inputMode="numeric" autoComplete="off" type="password" placeholder="••••••••" className="font-mono tracking-wider" /></Field>
            <Field label="Account type">
              <Select value={bank.accountType} onChange={(e) => setBank({ ...bank, accountType: e.target.value })}>
                <option value="CHECKING">Checking</option>
                <option value="SAVINGS">Savings</option>
              </Select>
            </Field>
          </div>
          <div className="rounded-xl border border-line bg-white/[0.02] p-3">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">Company address <span className="normal-case tracking-normal">(optional)</span></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Address" className="sm:col-span-2"><Input value={bank.line1} onChange={(e) => setBank({ ...bank, line1: e.target.value })} /></Field>
              <Field label="City"><Input value={bank.city} onChange={(e) => setBank({ ...bank, city: e.target.value })} /></Field>
              <Field label="State / Region"><Input value={bank.region} onChange={(e) => setBank({ ...bank, region: e.target.value })} /></Field>
              <Field label="ZIP / Postal code"><Input value={bank.postalCode} onChange={(e) => setBank({ ...bank, postalCode: e.target.value })} /></Field>
              <Field label="Country"><Input value={bank.country} onChange={(e) => setBank({ ...bank, country: e.target.value })} /></Field>
            </div>
          </div>
        </div>
      )}
      {err && <div className="mt-3"><ErrorBox text={err} /></div>}
      {kind !== null && (
        <div className="sticky -bottom-4 -mx-5 mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line bg-bg-2/95 px-5 py-3 backdrop-blur">
          {valid
            ? <span className="flex items-center gap-1.5 text-[11px] text-ink-3"><Lock className="h-3 w-3" /> Encrypted at rest. Only the last 4 digits are ever shown again.</span>
            : <Missing problems={problems} />}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setKind(null); setErr(null); }} disabled={busy}><ArrowLeft className="h-3.5 w-3.5" /> Back</Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={busy || !valid}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save {kind === "CARD" ? "card" : "bank account"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CardPreview({ name, number, month, year, label }: { name: string; number: string; month: string; year: string; label: string }) {
  const digits = number.replace(/\D/g, "");
  const brand = brandOf(digits);
  const masked = digits.length >= 4 ? `•••• •••• •••• ${digits.slice(-4)}` : "•••• •••• •••• ••••";
  return (
    <div className={cn("relative overflow-hidden rounded-2xl p-5 text-white shadow-[0_20px_40px_-20px_rgba(109,124,255,0.8)]", brand === "Mastercard" ? "bg-gradient-to-br from-[#ff8a3d] via-[#e6553f] to-[#a12b57]" : brand === "American Express" ? "bg-gradient-to-br from-[#2fd4e6] via-[#3b7bff] to-[#2b3fa8]" : "bg-gradient-to-br from-[#6d7cff] via-[#4b5be6] to-[#1f2a6b]")}>
      <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10 blur-2xl" />
      <div className="flex items-start justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-white/80">{label || "Company card"}</span>
        <span className="text-[13px] font-semibold">{brand}</span>
      </div>
      <div className="mt-7 font-mono text-[18px] tracking-[0.18em]">{masked}</div>
      <div className="mt-4 flex items-end justify-between text-[11.5px]">
        <span className="uppercase tracking-wide text-white/90">{name || "Cardholder name"}</span>
        <span className="font-mono">{month ? month.padStart(2, "0") : "MM"}/{year ? year.slice(-2) : "YY"}</span>
      </div>
    </div>
  );
}
