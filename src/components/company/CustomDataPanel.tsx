"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Check, Copy, Database, Loader2, Pencil, Plus, Search, ShieldCheck, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Field, Input, Select, Textarea } from "@/components/ui/Form";
import { api, errorText, type CustomDatum } from "@/lib/client-api";
import { ErrorBox, Modal } from "@/components/payments/shared";

const TYPES = ["string", "number", "boolean", "date", "url", "email", "phone", "json"] as const;

/**
 * Reusable company data: the answers agents look up instead of interrupting
 * the owner. A compact table, not a card per value, because there will be
 * many of them.
 */
export function CustomDataPanel({ pendingKey, onPendingHandled }: { pendingKey?: string | null; onPendingHandled?: () => void } = {}) {
  const [rows, setRows] = useState<CustomDatum[] | null>(null);
  const [namespaces, setNamespaces] = useState<{ namespace: string; count: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [ns, setNs] = useState<string>("all");
  const [editing, setEditing] = useState<CustomDatum | "new" | null>(null);
  // an agent asked the owner for this exact key: open the row (or a new one) on it
  const pendingRow = pendingKey ? (rows ?? []).find((d) => d.key === pendingKey) : undefined;
  const dialogFor = editing ?? (pendingKey ? pendingRow ?? "new" : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.customData().then((r) => { setRows(r.data); setNamespaces(r.namespaces); setError(null); }).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((d) => {
      const inNs = ns === "all" || (ns === "(no namespace)" ? !d.key.includes(".") : d.key.startsWith(`${ns}.`));
      return inNs && (!q || [d.key, d.value, d.label ?? "", d.description ?? ""].some((x) => x.toLowerCase().includes(q)));
    });
  }, [rows, query, ns]);

  async function remove(d: CustomDatum) {
    if (!window.confirm(`Delete ${d.key}? Agents will no longer find this value.`)) return;
    setBusy(d.id);
    try { await api.deleteCustomDatum(d.id); refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function verify(d: CustomDatum) {
    setBusy(d.id);
    try { await api.updateCustomDatum(d.id, { status: "verified" }); refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function copy(d: CustomDatum) {
    try { await navigator.clipboard.writeText(d.value); setCopied(d.id); setTimeout(() => setCopied(null), 1_500); } catch { /* clipboard blocked */ }
  }

  const provisional = (rows ?? []).filter((d) => d.status === "provisional").length;

  return (
    <section className="glass rounded-2xl p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3"><Database className="h-3.5 w-3.5" /> Company data</h2>
          <p className="mt-1 max-w-2xl text-[12px] text-ink-3">
            Reusable answers agents look up instead of asking you: defaults, preferences, codes, vendor identifiers. Not for passwords, API keys or card numbers — those belong in Credentials and Payments.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setEditing("new")}><Plus className="h-3.5 w-3.5" /> Add data</Button>
      </div>

      {rows && rows.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} dir="auto" placeholder="Filter by key, value or description…" className="h-8 w-full min-w-[220px] rounded-lg border border-line bg-white/[0.04] pl-8 pr-2.5 text-[12px] text-ink outline-none placeholder:text-ink-3 focus:border-brand/60" />
          </span>
          {namespaces.length > 1 && (
            <select value={ns} onChange={(e) => setNs(e.target.value)} className="h-8 rounded-lg border border-line bg-white/[0.04] px-2 text-[12px] text-ink outline-none focus:border-brand/60">
              <option value="all">All namespaces</option>
              {namespaces.map((n) => <option key={n.namespace} value={n.namespace}>{n.namespace} ({n.count})</option>)}
            </select>
          )}
          <span className="ml-auto whitespace-nowrap text-[11.5px] text-ink-3">
            {shown.length} of {rows.length}{provisional ? ` · ${provisional} provisional` : ""}
          </span>
        </div>
      )}

      {error && <div className="mb-3"><ErrorBox text={error} /></div>}
      {!rows && !error && <div className="flex items-center gap-2 py-4 text-[12px] text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>}

      {rows && rows.length === 0 && (
        <div className="rounded-xl border border-dashed border-line-2 px-4 py-8 text-center">
          <p className="text-[12.5px] text-ink-3">Nothing stored yet. Add the answers you keep repeating, for example <span className="font-mono text-ink-2">signup.default_country</span> or <span className="font-mono text-ink-2">operations.warehouse_code</span>.</p>
          <div className="mt-3"><Button variant="ghost" size="sm" onClick={() => setEditing("new")}><Plus className="h-3.5 w-3.5" /> Add data</Button></div>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-line text-[10.5px] uppercase tracking-[0.1em] text-ink-3">
                <th className="py-2 pr-3 text-left font-medium">Key</th>
                <th className="py-2 pr-3 text-left font-medium">Value</th>
                <th className="py-2 pr-3 text-left font-medium">Status</th>
                <th className="py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id} className="group border-b border-line/60 last:border-0 align-top">
                  <td className="py-2 pr-3">
                    <button type="button" onClick={() => setEditing(d)} className="text-left font-mono text-[12px] text-ink hover:text-brand">{d.key}</button>
                    {d.description && <div className="mt-0.5 max-w-sm text-[11px] leading-relaxed text-ink-3">{d.description}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    <span dir="auto" className="block max-w-xs truncate text-ink-2" title={d.value}>{d.value}</span>
                    <span className="text-[10.5px] text-ink-3">{d.valueType}</span>
                  </td>
                  <td className="py-2 pr-3">
                    {d.status === "verified"
                      ? <Badge color="#3dd68c" dot>Verified</Badge>
                      : <Badge color="#f5b942" dot>Provisional</Badge>}
                    <div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-ink-3">
                      {d.source === "owner" ? "by you" : <><Bot className="h-3 w-3" /> by an agent</>}
                    </div>
                  </td>
                  <td className="py-2">
                    <div className="flex justify-end gap-1 opacity-70 transition-opacity group-hover:opacity-100">
                      {d.status === "provisional" && (
                        <Button variant="ghost" size="xs" disabled={busy === d.id} onClick={() => verify(d)} title="Mark verified">
                          {busy === d.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
                        </Button>
                      )}
                      <Button variant="ghost" size="xs" onClick={() => copy(d)} title="Copy value">{copied === d.id ? <Check className="h-3 w-3 text-operations" /> : <Copy className="h-3 w-3" />}</Button>
                      <Button variant="ghost" size="xs" onClick={() => setEditing(d)} title="Edit"><Pencil className="h-3 w-3" /></Button>
                      <Button variant="ghost" size="xs" disabled={busy === d.id} onClick={() => remove(d)} title="Delete"><Trash2 className="h-3 w-3" /></Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <p className="py-6 text-center text-[12px] text-ink-3">Nothing matches that filter.</p>}
        </div>
      )}

      {dialogFor && (
        <CustomDataDialog
          datum={dialogFor === "new" ? undefined : dialogFor}
          presetKey={!editing && pendingKey ? pendingKey : undefined}
          onClose={() => { setEditing(null); onPendingHandled?.(); }}
          onSaved={() => { setEditing(null); refresh(); onPendingHandled?.(); }}
        />
      )}
    </section>
  );
}

function CustomDataDialog({ datum, presetKey, onClose, onSaved }: { datum?: CustomDatum; presetKey?: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    key: datum?.key ?? presetKey ?? "",
    value: datum?.value ?? "",
    valueType: datum?.valueType ?? "string",
    label: datum?.label ?? "",
    description: datum?.description ?? "",
    status: datum?.status ?? "verified",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = form.key.trim() && String(form.value).trim();

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      if (datum) await api.updateCustomDatum(datum.id, form);
      else await api.addCustomDatum(form);
      onSaved();
    } catch (e) { setErr(errorText(e)); setBusy(false); }
  }

  return (
    <Modal
      title={datum ? `Edit ${datum.key}` : "Add company data"}
      subtitle="Agents read this before asking you. Keep secrets out: passwords, API keys and card numbers are rejected here."
      onClose={onClose}
      width="max-w-xl"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Key" className="sm:col-span-2" hint="Lowercase and dot-namespaced, e.g. signup.default_country.">
          <Input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="signup.default_country" className="font-mono" autoFocus={!datum} />
        </Field>
        <Field label="Value" className="sm:col-span-2">
          <Textarea rows={2} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder="US" />
        </Field>
        <Field label="Type">
          <Select value={form.valueType} onChange={(e) => setForm({ ...form, valueType: e.target.value as typeof form.valueType })}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="Status" hint="Verified means agents may rely on it as yours.">
          <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as typeof form.status })}>
            <option value="verified">Verified</option>
            <option value="provisional">Provisional</option>
          </Select>
        </Field>
        <Field label="Label" hint="Optional."><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Default signup country" /></Field>
        <Field label="Description" className="sm:col-span-2" hint="What this is for, so the next agent understands it.">
          <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Country to use when a signup form asks and nothing else applies." />
        </Field>
      </div>
      {datum?.status === "provisional" && datum.reason && (
        <p className="mt-3 rounded-lg border border-warning/30 bg-warning/[0.08] px-3 py-2 text-[11.5px] text-warning">An agent chose this value: {datum.reason}</p>
      )}
      {err && <div className="mt-3"><ErrorBox text={err} /></div>}
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-4">
        <span className="text-[11px] text-ink-3">{datum ? `Updated ${new Date(datum.updatedAt).toLocaleString()}` : "Visible to every agent with company access."}</span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}><X className="h-3.5 w-3.5" /> Cancel</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={busy || !valid}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {datum ? "Save changes" : "Add data"}</Button>
        </div>
      </div>
    </Modal>
  );
}
