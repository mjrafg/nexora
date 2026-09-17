"use client";

import { useState } from "react";
import { KeyRound, Plus, Trash2, Pencil, X, Check, Loader2 } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Form";
import { api, errorText } from "@/lib/client-api";
import type { CredentialMeta } from "@/lib/mcp/types";

export function CredentialsSection({ credentials, onChanged }: { credentials: CredentialMeta[]; onChanged: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <Panel
      title="Credentials"
      subtitle="Reusable secrets attached to MCP servers. Values are encrypted at rest and never shown again."
      icon={<KeyRound className="h-4 w-4 text-brand" />}
      action={
        <Button variant="ghost" size="xs" onClick={() => { setAdding(true); setEditing(null); }}>
          <Plus className="h-3 w-3" /> New credential
        </Button>
      }
    >
      <div className="space-y-2">
        {adding && <CredentialEditor onCancel={() => setAdding(false)} onSaved={async () => { setAdding(false); await onChanged(); }} />}
        {credentials.length === 0 && !adding && <p className="text-[12px] text-ink-3">No credentials yet. Create one to hold API tokens, account ids, and other secret values.</p>}
        {credentials.map((c) =>
          editing === c.id ? (
            <CredentialEditor key={c.id} existing={c} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await onChanged(); }} />
          ) : (
            <CredentialRow key={c.id} c={c} onEdit={() => { setEditing(c.id); setAdding(false); }} onChanged={onChanged} />
          )
        )}
      </div>
    </Panel>
  );
}

function CredentialRow({ c, onEdit, onChanged }: { c: CredentialMeta; onEdit: () => void; onChanged: () => Promise<void> }) {
  const [err, setErr] = useState<string | null>(null);
  async function remove() {
    if (!window.confirm(`Delete credential “${c.name}”?`)) return;
    try {
      await api.deleteCredential(c.id);
      await onChanged();
    } catch (e) {
      setErr(errorText(e));
    }
  }
  return (
    <div className="rounded-lg border border-line bg-white/[0.02] px-3 py-2">
      <div className="flex items-center gap-2">
        <KeyRound className="h-3.5 w-3.5 text-ink-3" />
        <span className="text-[13px] font-medium text-ink">{c.name}</span>
        <span className="ml-1 text-[11px] text-ink-3">{c.keys.length} value{c.keys.length === 1 ? "" : "s"}</span>
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="xs" onClick={onEdit}><Pencil className="h-3 w-3" /></Button>
          <Button variant="danger" size="xs" onClick={remove}><Trash2 className="h-3 w-3" /></Button>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {c.keys.map((k) => (
          <span key={k} className="inline-flex items-center gap-1 rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">
            {k} <span className="text-ink-3">••••</span>
          </span>
        ))}
      </div>
      {c.usedBy.length > 0 && <div className="mt-1 text-[10.5px] text-ink-3">Used by: {c.usedBy.join(", ")}</div>}
      {err && <div className="mt-1 text-[11px] text-[#ff8ea3]">{err}</div>}
    </div>
  );
}

type Pair = { key: string; value: string };

function CredentialEditor({ existing, onCancel, onSaved }: { existing?: CredentialMeta; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [pairs, setPairs] = useState<Pair[]>(existing ? existing.keys.map((k) => ({ key: k, value: "" })) : [{ key: "", value: "" }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const values: Record<string, string> = {};
    for (const p of pairs) if (p.key.trim() && p.value) values[p.key.trim()] = p.value;
    try {
      if (existing) await api.updateCredential(existing.id, { name, values });
      else await api.createCredential(name, values);
      await onSaved();
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-brand/30 bg-white/[0.03] p-3">
      <Field label="Credential name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cloudflare Production" autoFocus />
      </Field>
      <div className="mt-2 text-[11.5px] font-medium text-ink-2">Secret values</div>
      <div className="mt-1 space-y-1.5">
        {pairs.map((p, i) => (
          <div key={i} className="flex gap-1.5">
            <Input value={p.key} onChange={(e) => setPairs((ps) => ps.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder="KEY (e.g. GITHUB_TOKEN)" className="font-mono" />
            <Input type="password" value={p.value} onChange={(e) => setPairs((ps) => ps.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder={existing ? "unchanged" : "secret value"} autoComplete="off" />
            <Button variant="ghost" size="sm" onClick={() => setPairs((ps) => ps.filter((_, j) => j !== i))}><X className="h-3.5 w-3.5" /></Button>
          </div>
        ))}
      </div>
      <Button variant="outline" size="xs" className="mt-1.5" onClick={() => setPairs((ps) => [...ps, { key: "", value: "" }])}>
        <Plus className="h-3 w-3" /> Add value
      </Button>
      {existing && <p className="mt-1.5 text-[10.5px] text-ink-3">Leave a value blank to keep the stored secret. Clear a value field to remove that key.</p>}
      {error && <div className="mt-2 rounded border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] text-[#ff8ea3]">{error}</div>}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}><X className="h-3.5 w-3.5" /> Cancel</Button>
        <Button variant="primary" size="sm" onClick={save} disabled={saving || !name.trim()}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {existing ? "Save" : "Create"}
        </Button>
      </div>
    </div>
  );
}
