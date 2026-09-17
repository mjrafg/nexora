"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Building2, Pencil, Plus, Mail, Phone, MapPin, Receipt, Scale, Clock, Loader2, Trash2, Star, ExternalLink, Bot, ShieldAlert, CheckCircle2, XCircle, Lock, History, UserRound } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { api, errorText, type CompanyActivity, type CompanyContact, type CompanyInfoRequest, type CompanyProfileView } from "@/lib/client-api";
import { CompanyProfileDialog, ContactDialog, type Section } from "@/components/company/CompanyDialogs";
import { CustomDataPanel } from "@/components/company/CustomDataPanel";
import { ErrorBox, Loading, when } from "@/components/payments/shared";
import { cn } from "@/lib/utils";
import { useRequestFocus } from "@/lib/use-request-focus";

type Data = { profile: CompanyProfileView; requests: CompanyInfoRequest[]; activity: CompanyActivity[] };

const SECTION_OF: Record<string, Section> = { general: "general", contact: "general", address: "address", billing: "billing", legal: "legal" };

function addressLines(a?: { line1?: string; line2?: string; city?: string; region?: string; postalCode?: string; country?: string }): string[] {
  if (!a) return [];
  const cityLine = [a.city, [a.region, a.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [a.line1, a.line2, cityLine, a.country].filter((x): x is string => !!x && !!x.trim());
}

function Monogram({ name, size = 56 }: { name: string; size?: number }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  return (
    <span className="grid shrink-0 place-items-center rounded-2xl font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_12px_28px_-14px_rgba(109,124,255,0.9)]" style={{ width: size, height: size, fontSize: size * 0.34, background: "linear-gradient(135deg,#7d8bff,#5a6bff 55%,#2fd4e6)" }}>
      {initials}
    </span>
  );
}

function Card({ title, icon: Icon, action, children, empty }: { title: string; icon: typeof Building2; action?: React.ReactNode; children?: React.ReactNode; empty?: string }) {
  return (
    <section className="glass flex flex-col rounded-2xl p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3"><Icon className="h-3.5 w-3.5" /> {title}</h2>
        {action}
      </div>
      {children ?? <p className="text-[12.5px] italic text-ink-3">{empty}</p>}
    </section>
  );
}

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!shown.length) return null;
  return (
    <dl className="grid grid-cols-[minmax(96px,34%)_1fr] gap-x-4 gap-y-2 text-[12.5px]">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function CompanyProfilePage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Section | null>(null);
  const [contact, setContact] = useState<{ existing?: CompanyContact } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const focus = useRequestFocus();

  const refresh = useCallback(() => { api.company().then((d) => { setData(d); setError(null); }).catch((e) => setError(errorText(e))); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const es = new EventSource("/api/company/events");
    let t: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = () => { if (t) clearTimeout(t); t = setTimeout(refresh, 300); };
    return () => { es.close(); if (t) clearTimeout(t); };
  }, [refresh]);

  async function removeContact(c: CompanyContact) {
    if (!window.confirm(`Remove ${c.name} (${c.value})? Agents will no longer offer it.`)) return;
    setBusy(c.id);
    try { await api.deleteCompanyContact(c.id); refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function makePrimary(c: CompanyContact) {
    setBusy(c.id);
    try { await api.updateCompanyContact(c.id, { isPrimary: true }); refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function requestAction(r: CompanyInfoRequest, action: "resolve" | "cancel") {
    setBusy(r.id);
    try { await api.companyRequestAction(r.id, action); refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }

  const p = data?.profile;
  const waiting = (data?.requests ?? []).filter((r) => r.status === "WAITING");
  const emails = (p?.contacts ?? []).filter((c) => c.type === "EMAIL");
  const phones = (p?.contacts ?? []).filter((c) => c.type === "PHONE");
  const empty = !!p && !p.name && !p.contacts.length && !addressLines(p.address).length;
  const legal = p?.legal;
  const legalRows: [string, React.ReactNode][] = legal ? [
    ["Entity", legal.entityType ?? p?.entityType ?? ""],
    ["Registered in", [legal.registrationState, legal.registrationCountry].filter(Boolean).join(", ")],
    ["Established", legal.formationDate ?? ""],
    ["EIN / Tax ID", legal.hasTaxId ? <span key="t" className="inline-flex items-center gap-1.5 font-mono text-ink"><Lock className="h-3 w-3 text-ink-3" />{legal.taxIdMasked}</span> : ""],
    ["Registration no.", legal.registrationNumber ?? ""],
    ["Registered address", addressLines(legal.registeredAddress).join(", ")],
  ] : [];

  return (
    <AppShell>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">Company</div>
          <h1 className="mt-0.5 text-[22px] font-semibold tracking-tight">Company Profile</h1>
          <p className="mt-0.5 max-w-2xl text-[12.5px] text-ink-3">The company information agents use when a form, vendor or service asks — so they never invent it. Only you can change it.</p>
        </div>
        {p && !empty && <Button variant="primary" size="sm" onClick={() => setEditing("general")}><Pencil className="h-3.5 w-3.5" /> Edit Profile</Button>}
      </div>

      {error && <div className="mb-4"><ErrorBox text={error} /></div>}
      {!data && !error && <Loading />}

      {waiting.length > 0 && (
        <section className="mb-5">
          <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-warning"><ShieldAlert className="h-3.5 w-3.5" /> Company information required · {waiting.length}</h2>
          <div className="grid gap-3 xl:grid-cols-2">
            {waiting.map((r) => (
              <div key={r.id} {...focus.focusProps(r.id)} className={cn("glass rounded-2xl border border-warning/30 p-4 shadow-[0_0_0_1px_rgba(245,185,66,0.12),0_16px_40px_-24px_rgba(245,185,66,0.5)]", focus.focusClass(r.id))}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold tracking-tight text-ink">{r.label}</div>
                    <div className="mt-0.5 text-[12px] text-ink-3">Needed for <span className="text-ink-2">{r.neededBy}</span></div>
                  </div>
                  <Badge color="#f5b942" dot>Waiting</Badge>
                </div>
                <dl className="mt-3 grid grid-cols-[100px_1fr] gap-y-1.5 text-[12.5px]">
                  <dt className="text-ink-3">Requested by</dt><dd className="text-ink-2"><Link href={`/agents/${r.requesterAgentId}`} className="inline-flex items-center gap-1 hover:text-ink"><Bot className="h-3 w-3" /> {r.requesterName}</Link> · {when(r.createdAt)}</dd>
                  {r.reason && <><dt className="text-ink-3">Reason</dt><dd className="text-ink-2">{r.reason}</dd></>}
                </dl>
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => (r.target === "custom_data" ? setPendingKey(r.field) : r.field.startsWith("primary_") ? setContact({}) : setEditing(SECTION_OF[r.field.split(".")[0]] ?? "general"))}
                  >
                    <Plus className="h-3.5 w-3.5" /> {r.target === "custom_data" ? "Add to company data" : "Add information"}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy === r.id} onClick={() => requestAction(r, "resolve")}>{busy === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Mark provided</Button>
                  <Button variant="ghost" size="sm" disabled={busy === r.id} onClick={() => requestAction(r, "cancel")}><XCircle className="h-3.5 w-3.5" /> Dismiss</Button>
                  <span className="self-center text-[11px] text-ink-3">The agent resumes automatically.</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {p && empty && (
        <div className="space-y-4">
        <div className="glass grid place-items-center rounded-2xl px-6 py-14 text-center">
          <Monogram name="?" size={56} />
          <h3 className="mt-4 text-[15px] font-semibold">No company information yet</h3>
          <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-ink-3">Add your company name, contact methods and address. Agents read this before filling any signup or vendor form — and will ask you rather than guess anything that is missing.</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button variant="primary" size="sm" onClick={() => setEditing("general")}><Building2 className="h-3.5 w-3.5" /> Set up company profile</Button>
            <Button variant="ghost" size="sm" onClick={() => setContact({})}><Plus className="h-3.5 w-3.5" /> Add contact method</Button>
          </div>
        </div>
        <CustomDataPanel pendingKey={pendingKey} onPendingHandled={() => { setPendingKey(null); refresh(); }} />
        </div>
      )}

      {p && !empty && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            {/* identity */}
            <section className="glass relative overflow-hidden rounded-2xl p-5">
              <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-brand/20 blur-3xl" />
              <div className="relative flex flex-wrap items-start gap-4">
                <Monogram name={p.name || "?"} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[20px] font-semibold tracking-tight text-ink">{p.name || <span className="italic text-ink-3">Unnamed company</span>}</h2>
                    {p.entityType && <Badge color="#6d7cff">{p.entityType}</Badge>}
                  </div>
                  {p.legalName && p.legalName !== p.name && <div className="mt-0.5 text-[12.5px] text-ink-3">{p.legalName}</div>}
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-2">
                    {p.industry && <span>{p.industry}</span>}
                    {p.website && <a href={p.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:text-ink">{p.website.replace(/^https?:\/\//, "")} <ExternalLink className="h-3 w-3" /></a>}
                    {p.timezone && <span className="inline-flex items-center gap-1 text-ink-3"><Clock className="h-3 w-3" /> {p.timezone}</span>}
                  </div>
                  {(p.ownerFirstName || p.ownerLastName) && (
                    <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-ink-2"><UserRound className="h-3.5 w-3.5 text-ink-3" /> {[p.ownerFirstName, p.ownerLastName].filter(Boolean).join(" ")}{p.ownerTitle ? <span className="text-ink-3"> · {p.ownerTitle}</span> : null}</div>
                  )}
                  {p.description && <p className="mt-3 max-w-2xl text-[12.5px] leading-relaxed text-ink-2">{p.description}</p>}
                </div>
                <Button variant="ghost" size="xs" className="shrink-0" onClick={() => setEditing("general")}><Pencil className="h-3 w-3" /> Edit</Button>
              </div>
            </section>

            {/* contacts */}
            <Card title="Contact methods" icon={Mail} action={<Button variant="ghost" size="xs" onClick={() => setContact({})}><Plus className="h-3 w-3" /> Add contact</Button>} empty={p.contacts.length ? undefined : "No company email or phone yet — agents will ask you for one when a form needs it."}>
              {p.contacts.length > 0 && (
                <ul className="divide-y divide-line/70">
                  {[...emails, ...phones].map((c) => (
                    <li key={c.id} className="group flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0">
                      <span className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl", c.type === "EMAIL" ? "bg-[rgba(109,124,255,0.16)] text-[#98a4ff]" : "bg-[rgba(61,214,140,0.16)] text-[#5fe3a3]")}>
                        {c.type === "EMAIL" ? <Mail className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13.5px] font-medium text-ink">{c.name}</span>
                          {c.isPrimary && <Badge color="#6d7cff" dot>Primary</Badge>}
                          {c.status === "INACTIVE" && <Badge color="#6f7890" dot>Inactive</Badge>}
                          {c.createdBy && c.createdBy !== "owner" && <span className="inline-flex items-center gap-1 text-[11px] text-ink-3"><Bot className="h-3 w-3" /> Saved by an agent</span>}
                        </div>
                        <div className="mt-0.5 break-all font-mono text-[12px] text-ink-2">{c.value}</div>
                        <p className="mt-1 text-[12px] leading-relaxed text-ink-3">{c.description}</p>
                      </div>
                      <div className="flex shrink-0 gap-1 opacity-70 transition-opacity group-hover:opacity-100">
                        {!c.isPrimary && <Button variant="ghost" size="xs" disabled={busy === c.id} onClick={() => makePrimary(c)}><Star className="h-3 w-3" /></Button>}
                        <Button variant="ghost" size="xs" onClick={() => setContact({ existing: c })}><Pencil className="h-3 w-3" /></Button>
                        <Button variant="ghost" size="xs" disabled={busy === c.id} onClick={() => removeContact(c)}>{busy === c.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <div className="grid gap-4 md:grid-cols-2">
              <Card title="Company address" icon={MapPin} action={<Button variant="ghost" size="xs" onClick={() => setEditing("address")}><Pencil className="h-3 w-3" /> Edit</Button>} empty={addressLines(p.address).length ? undefined : "Not set."}>
                {addressLines(p.address).length > 0 && <address className="space-y-0.5 text-[13px] not-italic leading-relaxed text-ink">{addressLines(p.address).map((l) => <div key={l}>{l}</div>)}</address>}
              </Card>
              <Card title="Billing address" icon={Receipt} action={<Button variant="ghost" size="xs" onClick={() => setEditing("billing")}><Pencil className="h-3 w-3" /> Edit</Button>} empty={addressLines(p.resolvedBillingAddress).length ? undefined : "Not set."}>
                {addressLines(p.resolvedBillingAddress).length > 0 && (
                  <>
                    {p.billingSameAsCompany && <div className="mb-2"><Badge color="#3dd68c" dot>Same as company address</Badge></div>}
                    <address className="space-y-0.5 text-[13px] not-italic leading-relaxed text-ink">{addressLines(p.resolvedBillingAddress).map((l) => <div key={l}>{l}</div>)}</address>
                  </>
                )}
              </Card>
            </div>

            <Card title="Legal information" icon={Scale} action={<Button variant="ghost" size="xs" onClick={() => setEditing("legal")}><Pencil className="h-3 w-3" /> Edit</Button>} empty={legalRows.some(([, v]) => v) ? undefined : "No legal or registration details yet. Agents will request a specific one if a signup requires it."}>
              {legalRows.some(([, v]) => v) && <Rows rows={legalRows} />}
            </Card>

            <CustomDataPanel pendingKey={pendingKey} onPendingHandled={() => { setPendingKey(null); refresh(); }} />

            <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-ink-3">
              <Lock className="mt-0.5 h-3 w-3 shrink-0" />
              <span>Agents with the <span className="text-ink-2">Company profile</span> permission read this through <span className="font-mono text-ink-2">get_company_profile</span>; the Capability Manager always has it. A missing value is requested from you rather than invented. Agents you also grant <span className="text-ink-2">Company profile: update</span> can add and correct values programmatically — every such change appears above with the agent&apos;s name and reason — but only you can clear a field or remove a contact.</span>
            </p>
          </div>

          <aside>
            <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3"><History className="h-3.5 w-3.5" /> Activity</h2>
            {data.activity.length === 0 ? (
              <div className="glass rounded-2xl px-4 py-6 text-center text-[12px] text-ink-3">Profile changes and agent look-ups appear here.</div>
            ) : (
              <ul className="glass divide-y divide-line/70 rounded-2xl">
                {data.activity.map((a) => (
                  <li key={a.id} className="px-4 py-2.5">
                    <div className="text-[12px] leading-relaxed text-ink-2">{a.text}</div>
                    {a.reason && <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">“{a.reason}”</div>}
                    <div className="mt-0.5 text-[11px] text-ink-3">{new Date(a.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}

      {editing && p && <CompanyProfileDialog profile={p} initialSection={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {contact && <ContactDialog existing={contact.existing} onClose={() => setContact(null)} onSaved={() => { setContact(null); refresh(); }} />}
    </AppShell>
  );
}
