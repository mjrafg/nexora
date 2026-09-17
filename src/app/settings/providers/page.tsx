"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Plug, Zap, Trash2, Pencil, X, Check, KeyRound } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Form";
import { TestBadge } from "@/components/agents/RuntimeConfigForm";
import { RuntimeLogins } from "@/components/providers/RuntimeLogins";
import { SettingsTabs } from "@/components/layout/SettingsTabs";
import { api, errorText, type Catalog } from "@/lib/client-api";
import type { ProviderConnectionView } from "@/lib/providers-view";
import type { ProviderType, RuntimeTestResult } from "@/lib/runtime/types";

type AuthMode = "env" | "stored" | "none";

export default function ProvidersPage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [connections, setConnections] = useState<ProviderConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function load() {
    const [c, p] = await Promise.all([api.catalog(), api.providers()]);
    setCatalog(c);
    setConnections(p.connections);
  }
  useEffect(() => {
    Promise.all([api.catalog(), api.providers()])
      .then(([c, p]) => {
        setCatalog(c);
        setConnections(p.connections);
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  return (
    <AppShell>
      <h1 className="text-[20px] font-semibold tracking-tight">Settings</h1>
      <p className="mb-3 text-[12.5px] text-ink-3">Company tools and integrations.</p>
      <SettingsTabs />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">AI Providers</h2>
          <p className="text-[12.5px] text-ink-3">Reusable connections that agents reference. Keys are stored locally and never copied into agents or prompts.</p>
        </div>
        <Button variant="primary" size="md" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Add connection
        </Button>
      </div>

      {error && <div className="glass mb-4 rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div>}
      {!connections && !error && (
        <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      <div className="mb-4">
        <RuntimeLogins />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {adding && catalog && (
          <ConnectionEditor
            catalog={catalog}
            onCancel={() => setAdding(false)}
            onSaved={async () => {
              setAdding(false);
              await load();
            }}
          />
        )}
        {catalog &&
          connections?.map((c) => (
            <ConnectionCard key={c.id} connection={c} catalog={catalog} onChanged={load} />
          ))}
      </div>
    </AppShell>
  );
}

function StatusDot({ status }: { status: ProviderConnectionView["status"] }) {
  const color = status === "connected" ? "#3dd68c" : status === "error" ? "#ff5c7a" : "#6f7890";
  const label = status === "connected" ? "Connected" : status === "error" ? "Error" : "Not tested";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-2">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} /> {label}
    </span>
  );
}

function ConnectionCard({ connection: c, catalog, onChanged }: { connection: ProviderConnectionView; catalog: Catalog; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<RuntimeTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const meta = catalog.providers[c.providerType];
  const probeModel = meta.models[0]?.id;
  const [model, setModel] = useState(probeModel ?? "");

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.testProvider(c.id, model || undefined));
      await onChanged();
    } catch (e) {
      setTest({ ok: false, message: "Test failed", detail: errorText(e), durationMs: 0 });
    } finally {
      setTesting(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete connection “${c.name}”?`)) return;
    setErr(null);
    try {
      await api.deleteProvider(c.id);
      await onChanged();
    } catch (e) {
      setErr(errorText(e));
    }
  }

  if (editing) {
    return (
      <ConnectionEditor
        catalog={catalog}
        existing={c}
        onCancel={() => setEditing(false)}
        onSaved={async () => {
          setEditing(false);
          await onChanged();
        }}
      />
    );
  }

  return (
    <Panel
      title={c.name}
      subtitle={meta.label}
      icon={<Plug className="h-4 w-4 text-brand" />}
      action={
        <div className="flex gap-1">
          <Button variant="ghost" size="xs" onClick={() => setEditing(true)}><Pencil className="h-3 w-3" /></Button>
          <Button variant="danger" size="xs" onClick={remove}><Trash2 className="h-3 w-3" /></Button>
        </div>
      }
    >
      <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 text-[12.5px]">
        <dt className="text-ink-3">Authentication</dt>
        <dd className="flex items-center gap-1.5 text-ink">
          <KeyRound className="h-3 w-3 text-ink-3" />
          {c.auth.kind === "none"
            ? "Runtime login (no key)"
            : c.auth.kind === "env"
              ? <span>Environment <span className="font-mono text-[11px] text-ink-2">{c.auth.variable}</span> · {c.authConfigured ? "Configured" : <span className="text-warning">Not set</span>}</span>
              : <span>Stored key · {c.authConfigured ? "Configured" : <span className="text-warning">Missing</span>}</span>}
        </dd>
        {c.baseUrl && (
          <>
            <dt className="text-ink-3">Base URL</dt>
            <dd className="truncate font-mono text-[11px] text-ink-2">{c.baseUrl}</dd>
          </>
        )}
        <dt className="text-ink-3">Status</dt>
        <dd><StatusDot status={c.status} /></dd>
        <dt className="text-ink-3">Runtimes</dt>
        <dd className="text-ink-2">{meta.runtimes.map((r) => catalog.runtimes.find((x) => x.type === r)?.label).join(", ")}</dd>
      </dl>
      {c.lastError && !test && <div className="mt-2 break-words text-[11px] text-[#ff8ea3]">{c.lastError}</div>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="probe model id" className="h-8 max-w-[220px] text-[12px]" />
        <Button variant="ghost" size="sm" onClick={runTest} disabled={testing || !model.trim()}>
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />} Test
        </Button>
      </div>
      {test && <div className="mt-2"><TestBadge result={test} /></div>}
      {err && <div className="mt-2 text-[11px] text-[#ff8ea3]">{err}</div>}
    </Panel>
  );
}

function ConnectionEditor({
  catalog,
  existing,
  onCancel,
  onSaved,
}: {
  catalog: Catalog;
  existing?: ProviderConnectionView;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [providerType, setProviderType] = useState<ProviderType>(existing?.providerType ?? "anthropic");
  const meta = catalog.providers[providerType];
  const [name, setName] = useState(existing?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? meta.defaultBaseUrl ?? "");
  const [authMode, setAuthMode] = useState<AuthMode>(existing?.auth.kind ?? "env");
  const [envVar, setEnvVar] = useState(existing?.auth.kind === "env" ? existing.auth.variable ?? "" : meta.envVar ?? "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function changeProvider(t: ProviderType) {
    setProviderType(t);
    const m = catalog.providers[t];
    setBaseUrl(m.defaultBaseUrl ?? "");
    setEnvVar(m.envVar ?? "");
    if (!name) setName(m.label);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const auth =
      authMode === "none" ? { kind: "none" } : authMode === "env" ? { kind: "env", variable: envVar } : { kind: "stored", apiKey: apiKey || undefined };
    try {
      if (existing) await api.updateProvider(existing.id, { name, baseUrl, auth });
      else await api.createProvider({ name, providerType, baseUrl, auth });
      await onSaved();
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  }

  return (
    <Panel title={existing ? `Edit ${existing.name}` : "New connection"} icon={<Plug className="h-4 w-4 text-brand" />}>
      <div className="space-y-3">
        <Field label="Provider">
          <Select value={providerType} onChange={(e) => changeProvider(e.target.value as ProviderType)} disabled={!!existing}>
            {Object.values(catalog.providers).map((p) => (
              <option key={p.type} value={p.type}>{p.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Connection name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. ${meta.label} Production`} />
        </Field>
        {(meta.requiresBaseUrl || meta.apiStyle === "openai" || providerType === "anthropic") && (
          <Field label="Base URL" hint={meta.requiresBaseUrl ? "OpenAI-compatible endpoint, e.g. https://example.com/v1" : undefined}>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={meta.defaultBaseUrl ?? "https://example.com/v1"} />
          </Field>
        )}
        <Field label="Authentication">
          <Select value={authMode} onChange={(e) => setAuthMode(e.target.value as AuthMode)}>
            <option value="env">Environment variable</option>
            <option value="stored">API key (stored locally)</option>
            <option value="none">None — use the runtime&apos;s own login</option>
          </Select>
        </Field>
        {authMode === "env" && (
          <Field label="Variable name" hint="The name of a variable set in the server's environment, e.g. OPENAI_API_KEY. To paste the key itself, choose “API key (stored locally)” above.">
            <Input value={envVar} onChange={(e) => setEnvVar(e.target.value)} placeholder={meta.envVar ?? "MY_API_KEY"} className="font-mono" />
          </Field>
        )}
        {authMode === "stored" && (
          <Field label="API key" hint={existing?.auth.kind === "stored" ? "Leave blank to keep the key already on file. Stored in data/secrets.json (0600)." : "Stored in data/secrets.json (0600), never shown again."}>
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" autoComplete="off" />
          </Field>
        )}
        {error && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-[#ff8ea3]">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}><X className="h-3.5 w-3.5" /> Cancel</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={saving || !name.trim()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {existing ? "Save" : "Create"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
