"use client";

import { useState } from "react";
import { Building2, Check, Eye, EyeOff, Loader2, Lock, MapPin, Mail, Phone, Receipt, Scale, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Form";
import { api, errorText, type CompanyContact, type CompanyProfileView } from "@/lib/client-api";
import { ErrorBox, Modal } from "@/components/payments/shared";
import { cn } from "@/lib/utils";

export type Section = "general" | "address" | "billing" | "legal";

const SECTIONS: { id: Section; label: string; icon: typeof Building2 }[] = [
  { id: "general", label: "General", icon: Building2 },
  { id: "address", label: "Address", icon: MapPin },
  { id: "billing", label: "Billing", icon: Receipt },
  { id: "legal", label: "Legal", icon: Scale },
];

const ADDRESS_FIELDS = [
  { key: "line1", label: "Address line 1", span: true, placeholder: "500 Congress Ave" },
  { key: "line2", label: "Address line 2", span: true, placeholder: "Suite 200 (optional)" },
  { key: "city", label: "City", placeholder: "Boston" },
  { key: "region", label: "State / Region", placeholder: "Massachusetts" },
  { key: "postalCode", label: "ZIP / Postal code", placeholder: "02110" },
  { key: "country", label: "Country", placeholder: "United States" },
] as const;

type Addr = { line1: string; line2: string; city: string; region: string; postalCode: string; country: string };
const toAddr = (a?: Partial<Addr>): Addr => ({ line1: a?.line1 ?? "", line2: a?.line2 ?? "", city: a?.city ?? "", region: a?.region ?? "", postalCode: a?.postalCode ?? "", country: a?.country ?? "" });

function AddressFields({ value, onChange, disabled }: { value: Addr; onChange: (a: Addr) => void; disabled?: boolean }) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2", disabled && "pointer-events-none opacity-50")}>
      {ADDRESS_FIELDS.map((f) => (
        <Field key={f.key} label={f.label} className={"span" in f && f.span ? "sm:col-span-2" : undefined}>
          <Input value={value[f.key]} onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} placeholder={f.placeholder} disabled={disabled} />
        </Field>
      ))}
    </div>
  );
}

/** Grouped owner edit dialog — one section at a time, never one giant form. */
export function CompanyProfileDialog({ profile, initialSection = "general", onClose, onSaved }: { profile: CompanyProfileView; initialSection?: Section; onClose: () => void; onSaved: (p: CompanyProfileView) => void }) {
  const [section, setSection] = useState<Section>(initialSection);
  const [form, setForm] = useState({
    name: profile.name ?? "", legalName: profile.legalName ?? "", entityType: profile.entityType ?? "", industry: profile.industry ?? "",
    website: profile.website ?? "", description: profile.description ?? "", timezone: profile.timezone ?? "",
    ownerFirstName: profile.ownerFirstName ?? "", ownerLastName: profile.ownerLastName ?? "", ownerTitle: profile.ownerTitle ?? "",
    billingSameAsCompany: profile.billingSameAsCompany,
  });
  const [address, setAddress] = useState<Addr>(toAddr(profile.address));
  const [billing, setBilling] = useState<Addr>(toAddr(profile.billingAddress));
  const [legal, setLegal] = useState({
    entityType: profile.legal.entityType ?? "", registrationState: profile.legal.registrationState ?? "", registrationCountry: profile.legal.registrationCountry ?? "",
    formationDate: profile.legal.formationDate ?? "", registrationNumber: profile.legal.registrationNumber ?? "", taxId: "",
  });
  const [registered, setRegistered] = useState<Addr>(toAddr(profile.legal.registeredAddress));
  const [showRegistered, setShowRegistered] = useState(!!profile.legal.registeredAddress);
  const [taxRevealed, setTaxRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  async function revealTaxId() {
    try {
      const r = await api.company(true);
      setLegal((l) => ({ ...l, taxId: r.profile.legal.taxId ?? "" }));
      setTaxRevealed(true);
    } catch (e) { setErr(errorText(e)); }
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        ...form, address, billingAddress: billing,
        legal: { ...legal, registeredAddress: showRegistered ? registered : {}, ...(taxRevealed || legal.taxId ? { taxId: legal.taxId } : {}) },
      };
      if (!taxRevealed && !legal.taxId) delete (body.legal as Record<string, unknown>).taxId;
      const r = await api.updateCompany(body);
      onSaved(r.profile);
    } catch (e) { setErr(errorText(e)); setBusy(false); }
  }

  return (
    <Modal title="Company profile" subtitle="What Nexora tells agents about this company. They use it instead of guessing — and never change it themselves." onClose={onClose} width="max-w-2xl">
      <div className="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" onClick={() => setSection(id)} className={cn("flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] transition-colors", section === id ? "border-brand/60 bg-brand/15 text-ink" : "border-line text-ink-3 hover:text-ink-2")}>
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>

      {section === "general" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Company name" className="sm:col-span-2" hint="The name customers and services know you by."><Input value={form.name} onChange={set("name")} placeholder="Agent24" autoFocus /></Field>
          <Field label="Legal name" hint="As registered."><Input value={form.legalName} onChange={set("legalName")} placeholder="Agent24 LLC" /></Field>
          <Field label="Business / entity type"><Input value={form.entityType} onChange={set("entityType")} placeholder="LLC" /></Field>
          <Field label="Industry"><Input value={form.industry} onChange={set("industry")} placeholder="AI / Software / SaaS" /></Field>
          <Field label="Website"><Input value={form.website} onChange={set("website")} placeholder="https://agent24.io" /></Field>
          <Field label="Timezone" className="sm:col-span-2" hint="IANA name, e.g. America/New_York."><Input value={form.timezone} onChange={set("timezone")} placeholder="America/New_York" /></Field>
          <Field label="Owner first name" hint="Used when a form asks for the account holder or authorized representative."><Input value={form.ownerFirstName} onChange={set("ownerFirstName")} placeholder="Mohammad Jamil" /></Field>
          <Field label="Owner last name"><Input value={form.ownerLastName} onChange={set("ownerLastName")} placeholder="Rezaei" /></Field>
          <Field label="Owner title" className="sm:col-span-2" hint="Optional, e.g. Owner, Founder, Managing Member."><Input value={form.ownerTitle} onChange={set("ownerTitle")} placeholder="Owner" /></Field>
          <Field label="Short description" className="sm:col-span-2" hint="One or two lines agents can reuse when a form asks what the company does."><Textarea rows={3} value={form.description} onChange={set("description")} placeholder="Agent24 builds autonomous AI teams that run day-to-day business operations." /></Field>
        </div>
      )}

      {section === "address" && (
        <div className="space-y-3">
          <p className="text-[12px] text-ink-3">The company&apos;s main address. Leave anything you do not have empty — agents will ask you rather than invent it.</p>
          <AddressFields value={address} onChange={setAddress} />
        </div>
      )}

      {section === "billing" && (
        <div className="space-y-3">
          <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-line bg-white/[0.03] px-3.5 py-3">
            <input type="checkbox" checked={form.billingSameAsCompany} onChange={(e) => setForm({ ...form, billingSameAsCompany: e.target.checked })} className="h-4 w-4 accent-[#6d7cff]" />
            <span className="text-[13px] text-ink">Same as company address</span>
          </label>
          <AddressFields value={billing} onChange={setBilling} disabled={form.billingSameAsCompany} />
          {form.billingSameAsCompany && <p className="text-[11.5px] text-ink-3">Checkouts and payment methods will use the company address.</p>}
        </div>
      )}

      {section === "legal" && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Legal entity type"><Input value={legal.entityType} onChange={(e) => setLegal({ ...legal, entityType: e.target.value })} placeholder="Limited Liability Company" /></Field>
            <Field label="Date established" hint="YYYY-MM-DD"><Input value={legal.formationDate} onChange={(e) => setLegal({ ...legal, formationDate: e.target.value })} placeholder="2025-03-14" /></Field>
            <Field label="State / region of registration"><Input value={legal.registrationState} onChange={(e) => setLegal({ ...legal, registrationState: e.target.value })} placeholder="Massachusetts" /></Field>
            <Field label="Country of registration"><Input value={legal.registrationCountry} onChange={(e) => setLegal({ ...legal, registrationCountry: e.target.value })} placeholder="United States" /></Field>
            <Field label="EIN / tax identifier" hint={profile.legal.hasTaxId && !taxRevealed ? `Saved as ${profile.legal.taxIdMasked} — leave empty to keep it.` : "US EIN (##-#######) or an international tax number."}>
              <div className="flex gap-2">
                <Input value={legal.taxId} onChange={(e) => { setLegal({ ...legal, taxId: e.target.value }); setTaxRevealed(true); }} placeholder={profile.legal.hasTaxId ? "Unchanged" : "12-3456789"} autoComplete="off" className="font-mono" />
                {profile.legal.hasTaxId && (
                  <Button variant="ghost" size="sm" className="shrink-0" onClick={() => (taxRevealed ? (setLegal({ ...legal, taxId: "" }), setTaxRevealed(false)) : revealTaxId())}>
                    {taxRevealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                )}
              </div>
            </Field>
            <Field label="Registration number" hint="Optional."><Input value={legal.registrationNumber} onChange={(e) => setLegal({ ...legal, registrationNumber: e.target.value })} placeholder="e.g. 001234567" /></Field>
          </div>
          <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-line bg-white/[0.03] px-3.5 py-3">
            <input type="checkbox" checked={showRegistered} onChange={(e) => setShowRegistered(e.target.checked)} className="h-4 w-4 accent-[#6d7cff]" />
            <span className="text-[13px] text-ink">Registered legal address differs from the company address</span>
          </label>
          {showRegistered && <AddressFields value={registered} onChange={setRegistered} />}
          <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-ink-3"><Lock className="mt-0.5 h-3 w-3 shrink-0" /> Legal identifiers are masked in the interface and never written to activity. Agents receive them only when a company workflow genuinely needs them.</p>
        </div>
      )}

      {err && <div className="mt-3"><ErrorBox text={err} /></div>}
      <div className="sticky -bottom-4 -mx-5 mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line bg-bg-2/95 px-5 py-3 backdrop-blur">
        <span className="text-[11px] text-ink-3">Only you can edit this. Agents read it.</span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}><X className="h-3.5 w-3.5" /> Cancel</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save profile</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Add or edit one contact method. The description is what agents choose by. */
export function ContactDialog({ existing, onClose, onSaved }: { existing?: CompanyContact; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    type: existing?.type ?? "EMAIL",
    name: existing?.name ?? "",
    value: existing?.value ?? "",
    description: existing?.description ?? "",
    isPrimary: existing?.isPrimary ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const email = form.type === "EMAIL";
  const valid = form.name.trim() && form.value.trim() && form.description.trim().length >= 10;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      if (existing) await api.updateCompanyContact(existing.id, form);
      else await api.addCompanyContact(form);
      onSaved();
    } catch (e) { setErr(errorText(e)); setBusy(false); }
  }

  return (
    <Modal title={existing ? `Edit ${existing.name}` : "Add contact method"} subtitle="Agents pick between contacts by name and purpose — describe what this one is for." onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type">
          <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as "EMAIL" | "PHONE" })}>
            <option value="EMAIL">Email</option>
            <option value="PHONE">Phone</option>
          </Select>
        </Field>
        <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={email ? "Primary Company Email" : "Company Phone"} autoFocus /></Field>
        <Field label={email ? "Email address" : "Phone number"} className="sm:col-span-2">
          <Input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder={email ? "company@agent24.io" : "+1 617 555 0142"} inputMode={email ? "email" : "tel"} autoComplete="off" />
        </Field>
        <Field label="Purpose description" className="sm:col-span-2" hint="When should an agent use this one — and when not? At least 10 characters.">
          <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={email ? "General company email used for registrations, external services and company accounts." : "Primary company mobile number. Use for business registrations and SMS verification."} />
        </Field>
      </div>
      <label className="mt-3 flex cursor-pointer items-center gap-2.5 rounded-xl border border-line bg-white/[0.03] px-3.5 py-3">
        <input type="checkbox" checked={form.isPrimary} onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })} className="h-4 w-4 accent-[#6d7cff]" />
        <span className="text-[13px] text-ink">Primary {email ? "email" : "phone"} for the company</span>
      </label>
      {err && <div className="mt-3"><ErrorBox text={err} /></div>}
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-4">
        <span className="flex items-center gap-1.5 text-[11px] text-ink-3">{email ? <Mail className="h-3 w-3" /> : <Phone className="h-3 w-3" />} Visible to agents with company profile access.</span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}><X className="h-3.5 w-3.5" /> Cancel</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={busy || !valid}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {existing ? "Save changes" : "Add contact"}</Button>
        </div>
      </div>
    </Modal>
  );
}
