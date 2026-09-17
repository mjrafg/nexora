"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { KeyRound, Plus, Pencil, Trash2, Power, Loader2, Globe, ShieldAlert, Clock, CheckCircle2, XCircle, ChevronRight, ExternalLink, Bot } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { api, errorText, type CredentialActivity, type CredentialRequest, type LoginCredentialView } from "@/lib/client-api";
import { CredentialDialog } from "@/components/credentials/CredentialDialog";
import { EmptyState, ErrorBox, Loading, Modal, when } from "@/components/payments/shared";
import { cn } from "@/lib/utils";
import { useRequestFocus } from "@/lib/use-request-focus";

const PALETTE = ["#6d7cff", "#2fd4e6", "#3dd68c", "#f5b942", "#ff8a3d", "#a78bfa", "#4f8bff", "#ff5c7a"];

function ServiceGlyph({ service, size = 40 }: { service: string; size?: number }) {
  const h = [...service].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const color = PALETTE[h % PALETTE.length];
  return (
    <span className="grid shrink-0 place-items-center rounded-xl font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]" style={{ width: size, height: size, background: `linear-gradient(135deg, ${color}, ${color}99)`, fontSize: size * 0.42 }}>
      {service.trim().slice(0, 1).toUpperCase() || "?"}
    </span>
  );
}

export default function CredentialsPage() {
  const [data, setData] = useState<{ credentials: LoginCredentialView[]; requests: CredentialRequest[]; activity: CredentialActivity[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ request?: CredentialRequest } | null>(null);
  const [editing, setEditing] = useState<LoginCredentialView | null>(null);
  const [detail, setDetail] = useState<LoginCredentialView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const focus = useRequestFocus();

  const refresh = useCallback(() => { api.logins().then((d) => { setData(d); setError(null); }).catch((e) => setError(errorText(e))); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const es = new EventSource("/api/logins/events");
    let t: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = () => { if (t) clearTimeout(t); t = setTimeout(refresh, 300); };
    return () => { es.close(); if (t) clearTimeout(t); };
  }, [refresh]);

  async function toggle(c: LoginCredentialView) {
    setBusy(c.id);
    try { await api.updateLogin(c.id, { status: c.status === "AVAILABLE" ? "DISABLED" : "AVAILABLE" }); refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function remove(c: LoginCredentialView) {
    if (!window.confirm(`Delete "${c.name}"? Agents will no longer be able to use it.`)) return;
    setBusy(c.id);
    try { await api.deleteLogin(c.id); setDetail(null); refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function cancelRequest(r: CredentialRequest) {
    setBusy(r.id);
    try { await api.cancelCredentialRequest(r.id); refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }

  const waiting = data?.requests.filter((r) => r.status === "WAITING") ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.credentials ?? []).filter((c) => !q || [c.name, c.service, c.site, c.description].some((x) => x.toLowerCase().includes(q)));
  }, [data, query]);

  return (
    <AppShell>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">Company</div>
          <h1 className="mt-0.5 text-[22px] font-semibold tracking-tight">Credentials</h1>
          <p className="mt-0.5 max-w-2xl text-[12.5px] text-ink-3">Logins agents may use. They read the metadata to pick the right one and Nexora types it into the page — the password itself is never shown to them or to you again.</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setAdding({})}><Plus className="h-3.5 w-3.5" /> Add Credential</Button>
      </div>

      {error && <div className="mb-4"><ErrorBox text={error} /></div>}
      {!data && !error && <Loading />}

      {waiting.length > 0 && (
        <section className="mb-5">
          <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-warning"><ShieldAlert className="h-3.5 w-3.5" /> Credential required · {waiting.length}</h2>
          <div className="grid gap-3 xl:grid-cols-2">
            {waiting.map((r) => (
              <div key={r.id} {...focus.focusProps(r.id)} className={cn("glass rounded-2xl border border-warning/30 p-4 shadow-[0_0_0_1px_rgba(245,185,66,0.12),0_16px_40px_-24px_rgba(245,185,66,0.5)]", focus.focusClass(r.id))}>
                <div className="flex items-start gap-3">
                  <ServiceGlyph service={r.service} size={42} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-semibold tracking-tight text-ink">{r.service}</div>
                    <div className="truncate font-mono text-[11.5px] text-ink-3">{r.site}</div>
                  </div>
                  <Badge color="#f5b942" dot>Waiting</Badge>
                </div>
                <dl className="mt-3 grid grid-cols-[100px_1fr] gap-y-1.5 text-[12.5px]">
                  <dt className="text-ink-3">Requested by</dt><dd className="text-ink-2"><Link href={`/agents/${r.requesterAgentId}`} className="inline-flex items-center gap-1 hover:text-ink"><Bot className="h-3 w-3" /> {r.requesterName}</Link> · {when(r.createdAt)}</dd>
                  <dt className="text-ink-3">Reason</dt><dd className="text-ink-2">{r.reason}</dd>
                  <dt className="text-ink-3">Required</dt><dd className="text-ink-2">{r.required}</dd>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                  <Button variant="primary" size="sm" onClick={() => setAdding({ request: r })}><Plus className="h-3.5 w-3.5" /> Add Credential</Button>
                  <Button variant="ghost" size="sm" disabled={busy === r.id} onClick={() => cancelRequest(r)}>{busy === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />} Dismiss</Button>
                  <span className="self-center text-[11px] text-ink-3">The agent resumes automatically after you save.</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {data && data.credentials.length === 0 && waiting.length === 0 && (
        <EmptyState icon={KeyRound} title="No credentials yet" text="Add the company logins agents may use — with a precise description of which site, which account and what it is for, so agents can pick the right one themselves." action={<Button variant="primary" size="sm" onClick={() => setAdding({})}><Plus className="h-3.5 w-3.5" /> Add Credential</Button>} />
      )}

      {data && data.credentials.length > 0 && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section>
            <div className="mb-3 flex items-center gap-2">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name, service, site…" className="h-9 w-full max-w-xs rounded-lg border border-line bg-white/[0.04] px-3 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-brand/60" />
              <span className="shrink-0 whitespace-nowrap text-[12px] text-ink-3">{shown.length} of {data.credentials.length}</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {shown.map((c) => (
                <button key={c.id} type="button" onClick={() => setDetail(c)} className={cn("glass group flex flex-col gap-3 rounded-2xl p-4 text-left transition-colors hover:bg-white/[0.05]", c.status === "DISABLED" && "opacity-70")}>
                  <div className="flex items-start gap-3">
                    <ServiceGlyph service={c.service} size={44} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-semibold tracking-tight text-ink">{c.name}</div>
                      <div className="text-[12px] text-ink-3">{c.service}</div>
                    </div>
                    <ChevronRight className="mt-1 h-4 w-4 text-ink-3 group-hover:text-ink" />
                  </div>
                  <div className="flex items-center gap-1.5 font-mono text-[11.5px] text-ink-2"><Globe className="h-3 w-3 text-ink-3" /> {c.site}</div>
                  <p className="line-clamp-2 text-[12.5px] leading-relaxed text-ink-2">{c.description}</p>
                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3">
                    <span className="truncate font-mono text-[12px] text-ink">{c.usernameMasked}</span>
                    <Badge color={c.status === "AVAILABLE" ? "#3dd68c" : "#6f7890"} dot>{c.status === "AVAILABLE" ? "Available" : "Disabled"}</Badge>
                  </div>
                </button>
              ))}
            </div>
          </section>
          <aside>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">Activity</h2>
            <ul className="glass divide-y divide-line/70 rounded-2xl">
              {data.activity.slice(0, 12).map((a) => (
                <li key={a.id} className="flex items-start gap-2 px-3 py-2 text-[12px]">
                  {a.kind === "required" ? <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" /> : a.kind === "deleted" || a.kind === "disabled" ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-operations" />}
                  <span className="min-w-0 flex-1 text-ink-2">{a.text}</span>
                  <span className="shrink-0 text-[10.5px] text-ink-3 num">{new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </li>
              ))}
              {data.activity.length === 0 && <li className="px-3 py-2 text-[12px] text-ink-3">No activity yet.</li>}
            </ul>
            <p className="mt-4 text-[11px] leading-relaxed text-ink-3">MVP note: agents are bound by a rule never to read inserted values back; technical browser-level isolation is a later hardening phase.</p>
          </aside>
        </div>
      )}

      {adding && <CredentialDialog request={adding.request} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); refresh(); }} />}
      {editing && <CredentialDialog existing={editing} onClose={() => setEditing(null)} onSaved={(c) => { setEditing(null); setDetail(c); refresh(); }} />}
      {detail && (
        <Modal title={detail.name} subtitle={`${detail.service} · ${detail.site}`} onClose={() => setDetail(null)}>
          <div className="flex items-center gap-3">
            <ServiceGlyph service={detail.service} size={48} />
            <div className="min-w-0 flex-1">
              <Badge color={detail.status === "AVAILABLE" ? "#3dd68c" : "#6f7890"} dot>{detail.status === "AVAILABLE" ? "Available" : "Disabled"}</Badge>
              <div className="mt-1 text-[11.5px] text-ink-3">{detail.type === "username_password" ? "Username & password" : detail.type === "api_key" ? "API key" : "Token"} · added by {detail.createdBy === "owner" ? "you" : detail.createdBy}</div>
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-[110px_1fr] gap-y-2.5 text-[12.5px]">
            <dt className="text-ink-3">Site</dt><dd className="font-mono text-ink">{detail.site}</dd>
            <dt className="text-ink-3">Login URL</dt><dd className="min-w-0 truncate">{detail.loginUrl ? <a href={detail.loginUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:text-ink">{detail.loginUrl} <ExternalLink className="h-3 w-3" /></a> : <span className="text-ink-3">—</span>}</dd>
            <dt className="text-ink-3">Purpose</dt><dd className="text-ink-2">{detail.description}</dd>
            <dt className="text-ink-3">Username</dt><dd className="font-mono text-ink">{detail.usernameMasked}</dd>
            <dt className="text-ink-3">Password</dt><dd className="font-mono tracking-widest text-ink">••••••••••••</dd>
            <dt className="text-ink-3">Last used</dt><dd className="flex items-center gap-1 text-ink-2"><Clock className="h-3 w-3 text-ink-3" /> {detail.lastUsedAt ? `${when(detail.lastUsedAt)} · ${detail.lastUsedBy} · ${detail.useCount}×` : "never"}</dd>
            <dt className="text-ink-3">Updated</dt><dd className="text-ink-2">{when(detail.updatedAt)}</dd>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
            <Button variant="ghost" size="sm" onClick={() => { setEditing(detail); setDetail(null); }}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
            <Button variant="ghost" size="sm" disabled={busy === detail.id} onClick={() => toggle(detail).then(() => setDetail({ ...detail, status: detail.status === "AVAILABLE" ? "DISABLED" : "AVAILABLE" }))}><Power className="h-3.5 w-3.5" /> {detail.status === "AVAILABLE" ? "Disable" : "Enable"}</Button>
            <Button variant="danger" size="sm" className="ml-auto" disabled={busy === detail.id} onClick={() => remove(detail)}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
          </div>
        </Modal>
      )}
    </AppShell>
  );
}
