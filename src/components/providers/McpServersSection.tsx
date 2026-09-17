"use client";

import { useState } from "react";
import { Server, Plus, Trash2, Pencil, X, Check, Loader2, Zap, RefreshCw, Wrench, Terminal, Globe, KeyRound, ShieldCheck } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Form";
import { api, errorText } from "@/lib/client-api";
import type { CredentialMeta, McpServerConfig, McpServerView, McpTestResult, McpTransport } from "@/lib/mcp/types";
import { cn } from "@/lib/utils";

export function McpServersSection({ servers, credentials, onChanged }: { servers: McpServerView[]; credentials: CredentialMeta[]; onChanged: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <Panel
      title="MCP Servers"
      subtitle="Company-level integrations. Add a server, attach a credential, test, and discover its tools."
      icon={<Server className="h-4 w-4 text-brand" />}
      action={
        <Button variant="primary" size="xs" onClick={() => { setAdding(true); setEditing(null); }}>
          <Plus className="h-3 w-3" /> Add MCP Server
        </Button>
      }
    >
      <div className="space-y-3">
        {adding && <ServerEditor credentials={credentials} onCancel={() => setAdding(false)} onSaved={async () => { setAdding(false); await onChanged(); }} />}
        {servers.length === 0 && !adding && <p className="text-[12px] text-ink-3">No MCP servers yet. Add one to give your agents real tools.</p>}
        {servers.map((s) =>
          editing === s.id ? (
            <ServerEditor key={s.id} existing={s} credentials={credentials} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await onChanged(); }} />
          ) : (
            <ServerCard key={s.id} server={s} onEdit={() => { setEditing(s.id); setAdding(false); }} onChanged={onChanged} />
          )
        )}
      </div>
    </Panel>
  );
}

function StatusDot({ ok }: { ok: boolean | null | undefined }) {
  const color = ok === true ? "#3dd68c" : ok === false ? "#ff5c7a" : "#6f7890";
  const label = ok === true ? "Connected" : ok === false ? "Error" : "Not tested";
  return <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-2"><span className="h-2 w-2 rounded-full" style={{ background: color }} /> {label}</span>;
}

function ServerCard({ server, onEdit, onChanged }: { server: McpServerView; onEdit: () => void; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<"test" | "refresh" | "auth" | null>(null);
  const [result, setResult] = useState<McpTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const live = server.tools.filter((t) => !t.missing);
  const isHttp = server.config.transport === "http";
  const oauthConnected = !!server.oauth?.connected;
  const needsAuth = isHttp && !oauthConnected && server.lastTestOk === false && /401|auth/i.test(server.lastTestError ?? "");

  async function authorize() {
    setBusy("auth"); setErr(null); setResult(null);
    try {
      const { authorizeUrl } = await api.startMcpOAuth(server.id);
      const win = window.open(authorizeUrl, "_blank", "width=520,height=720");
      // poll for connection
      const started = Date.now();
      const poll = setInterval(async () => {
        try {
          const { server: fresh } = await api.getMcpServer(server.id);
          if (fresh.oauth?.connected) { clearInterval(poll); setBusy(null); if (win) win.close(); await onChanged(); }
          else if (Date.now() - started > 5 * 60_000) { clearInterval(poll); setBusy(null); setErr("Authorization timed out."); }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (e) {
      setErr(errorText(e)); setBusy(null);
    }
  }
  async function deauthorize() {
    if (!window.confirm(`Disconnect OAuth for “${server.name}”?`)) return;
    try { await api.disconnectMcpOAuth(server.id); await onChanged(); } catch (e) { setErr(errorText(e)); }
  }

  async function test() {
    setBusy("test"); setResult(null);
    try { const r = await api.testMcpServer(server.id); setResult(r); await onChanged(); }
    catch (e) { setResult({ ok: false, message: "Test failed", detail: errorText(e), durationMs: 0 }); }
    finally { setBusy(null); }
  }
  async function refresh() {
    setBusy("refresh"); setResult(null);
    try { const r = await api.refreshMcpTools(server.id); setResult(r); await onChanged(); }
    catch (e) { setResult({ ok: false, message: "Discovery failed", detail: errorText(e), durationMs: 0 }); }
    finally { setBusy(null); }
  }
  async function remove() {
    if (!window.confirm(`Delete MCP server “${server.name}”? Agents lose access to its tools.`)) return;
    try { await api.deleteMcpServer(server.id); await onChanged(); } catch (e) { setErr(errorText(e)); }
  }

  return (
    <div className="rounded-xl border border-line bg-white/[0.02] p-3">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand/15 text-brand">
          {server.config.transport === "http" ? <Globe className="h-4 w-4" /> : <Terminal className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-ink">{server.name}</span>
            <span className="rounded bg-white/[0.06] px-1.5 py-px text-[10px] uppercase text-ink-3">{server.config.transport}</span>
            {!server.enabled && <span className="rounded bg-warning/15 px-1.5 py-px text-[10px] text-warning">disabled</span>}
          </div>
          <div className="truncate font-mono text-[11px] text-ink-3">{server.config.transport === "http" ? server.config.url : `${server.config.command ?? ""} ${(server.config.args ?? []).join(" ")}`}</div>
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" size="xs" onClick={onEdit}><Pencil className="h-3 w-3" /></Button>
          <Button variant="danger" size="xs" onClick={remove}><Trash2 className="h-3 w-3" /></Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-2">
        <StatusDot ok={server.lastTestOk} />
        {oauthConnected && <span className="inline-flex items-center gap-1 text-[#7de8b3]"><ShieldCheck className="h-3 w-3" /> OAuth connected</span>}
        {server.credentialName && <span className="text-ink-3">Credential: <span className="text-ink-2">{server.credentialName}</span></span>}
        <span className="inline-flex items-center gap-1 text-ink-3"><Wrench className="h-3 w-3" /> {live.length} tool{live.length === 1 ? "" : "s"}</span>
      </div>
      {server.lastTestError && !result && <div className="mt-1 break-words text-[11px] text-[#ff8ea3]">{server.lastTestError}</div>}
      {live.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {live.map((t) => (
            <span key={t.id} className="rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2" title={t.description}>{t.name}</span>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={test} disabled={busy !== null}>
          {busy === "test" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />} Test
        </Button>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={busy !== null}>
          {busy === "refresh" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh tools
        </Button>
        {isHttp && !oauthConnected && (
          <Button variant={needsAuth ? "primary" : "ghost"} size="sm" onClick={authorize} disabled={busy !== null}>
            {busy === "auth" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />} Authorize (OAuth)
          </Button>
        )}
        {oauthConnected && (
          <Button variant="ghost" size="sm" onClick={deauthorize} disabled={busy !== null}>
            <X className="h-3.5 w-3.5" /> Disconnect OAuth
          </Button>
        )}
        {result && (
          <span className={cn("text-[11.5px]", result.ok ? "text-[#7de8b3]" : "text-[#ff8ea3]")}>
            {result.ok ? `✓ ${result.detail ?? "Connected"}` : `✕ ${result.message}${result.detail ? ` — ${result.detail}` : ""}`}
          </span>
        )}
      </div>
      {err && <div className="mt-1 text-[11px] text-[#ff8ea3]">{err}</div>}
    </div>
  );
}

function ServerEditor({ existing, credentials, onCancel, onSaved }: { existing?: McpServerView; credentials: CredentialMeta[]; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(existing?.config.transport ?? "stdio");
  const [command, setCommand] = useState(existing?.config.command ?? "");
  const [argsText, setArgsText] = useState((existing?.config.args ?? []).join(" "));
  const [url, setUrl] = useState(existing?.config.url ?? "");
  const [envText, setEnvText] = useState(kvToText(existing?.config.env));
  const [headersText, setHeadersText] = useState(kvToText(existing?.config.headers));
  const [credentialId, setCredentialId] = useState<string>(existing?.credentialId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true); setError(null);
    const config: McpServerConfig =
      transport === "http"
        ? { transport, url: url.trim(), headers: textToKv(headersText) }
        : { transport, command: command.trim(), args: parseArgs(argsText), env: textToKv(envText) };
    try {
      if (existing) await api.updateMcpServer(existing.id, { name, config, credentialId: credentialId || null });
      else await api.createMcpServer({ name, config, credentialId: credentialId || null });
      await onSaved();
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-brand/30 bg-white/[0.03] p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_150px]">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cloudflare MCP" autoFocus /></Field>
        <Field label="Transport">
          <Select value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)}>
            <option value="stdio">stdio (command)</option>
            <option value="http">http (URL)</option>
          </Select>
        </Field>
      </div>

      {transport === "stdio" ? (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr]">
            <Field label="Command"><Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className="font-mono" /></Field>
            <Field label="Arguments" hint="Space-separated; quote args with spaces."><Input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-y @modelcontextprotocol/server-github" className="font-mono" /></Field>
          </div>
          <Field label="Environment variables (non-secret)" hint="KEY=value per line. Put secrets in a credential instead.">
            <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} rows={2} className="w-full rounded-lg border border-line bg-white/[0.04] px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-brand/60" placeholder="LOG_LEVEL=info" />
          </Field>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <Field label="URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" className="font-mono" /></Field>
          <Field label="Headers (non-secret)" hint="KEY=value per line. Use ${SECRET_KEY} to inject a credential value, e.g. Authorization=Bearer ${GITHUB_TOKEN}.">
            <textarea value={headersText} onChange={(e) => setHeadersText(e.target.value)} rows={2} className="w-full rounded-lg border border-line bg-white/[0.04] px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-brand/60" placeholder="Authorization=Bearer ${API_TOKEN}" />
          </Field>
        </div>
      )}

      <Field label="Credential" className="mt-3" hint="Its secret values are injected at execution time (stdio → env vars; http → sent as Authorization: Bearer <token> automatically, or via ${KEY} in headers).">
        <Select value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
          <option value="">None</option>
          {credentials.map((c) => (
            <option key={c.id} value={c.id}>{c.name} ({c.keys.join(", ")})</option>
          ))}
        </Select>
      </Field>

      {error && <div className="mt-2 rounded border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] text-[#ff8ea3]">{error}</div>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}><X className="h-3.5 w-3.5" /> Cancel</Button>
        <Button variant="primary" size="sm" onClick={save} disabled={saving || !name.trim()}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {existing ? "Save" : "Add & discover"}
        </Button>
      </div>
    </div>
  );
}

function kvToText(m: Record<string, string> | undefined): string {
  return Object.entries(m ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
}
function textToKv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) { const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim(); if (k) out[k] = v; }
  }
  return Object.keys(out).length ? out : undefined;
}
function parseArgs(text: string): string[] {
  return text.match(/"[^"]*"|'[^']*'|\S+/g)?.map((a) => a.replace(/^["']|["']$/g, "")) ?? [];
}
