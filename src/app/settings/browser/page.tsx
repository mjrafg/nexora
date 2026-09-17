"use client";

import { useCallback, useEffect, useState } from "react";
import { Globe, Loader2, Play, Camera, MousePointerClick, Keyboard, ListTree, BookOpen, AppWindow, Download, Power, XCircle, RefreshCw, Search, Clock, MoveVertical, Trash2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { SettingsTabs } from "@/components/layout/SettingsTabs";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Field, Input, Select } from "@/components/ui/Form";
import { api, errorText, type BrowserLabResult, type BrowserSessionInfo } from "@/lib/client-api";
import { cn } from "@/lib/utils";

type Op = { id: string; label: string; icon: typeof Globe; tool: string; fields?: { key: string; label: string; placeholder?: string; type?: "text" | "number" | "checkbox" | "select"; options?: string[] }[] };

const OPS: Op[] = [
  { id: "open", label: "Open URL", icon: Globe, tool: "browser_navigate", fields: [{ key: "url", label: "URL", placeholder: "https://example.com" }] },
  { id: "search", label: "Web search", icon: Search, tool: "browser_search", fields: [{ key: "query", label: "Query", placeholder: "cloudflare mcp server github" }] },
  { id: "state", label: "Get state", icon: ListTree, tool: "browser_get_state" },
  { id: "snapshot", label: "Snapshot", icon: ListTree, tool: "browser_snapshot" },
  { id: "read", label: "Read text", icon: BookOpen, tool: "browser_read", fields: [{ key: "selector", label: "Selector (optional)", placeholder: "main" }] },
  { id: "click", label: "Click", icon: MousePointerClick, tool: "browser_click", fields: [{ key: "ref", label: "Ref", placeholder: "e12" }, { key: "selector", label: "or selector", placeholder: "button[type=submit]" }] },
  { id: "type", label: "Type / fill", icon: Keyboard, tool: "browser_type", fields: [{ key: "ref", label: "Ref" }, { key: "selector", label: "or selector", placeholder: "input[name=q]" }, { key: "text", label: "Text" }, { key: "submit", label: "Press Enter", type: "checkbox" }, { key: "sensitive", label: "Sensitive", type: "checkbox" }] },
  { id: "select", label: "Select option", icon: Keyboard, tool: "browser_select", fields: [{ key: "selector", label: "Selector", placeholder: "select[name=size]" }, { key: "values", label: "Value / label" }] },
  { id: "press", label: "Press key", icon: Keyboard, tool: "browser_press", fields: [{ key: "key", label: "Key", placeholder: "Enter" }] },
  { id: "scroll", label: "Scroll", icon: MoveVertical, tool: "browser_scroll", fields: [{ key: "dy", label: "dy", type: "number", placeholder: "600" }] },
  { id: "wait", label: "Wait", icon: Clock, tool: "browser_wait", fields: [{ key: "seconds", label: "Seconds", type: "number", placeholder: "1" }, { key: "text", label: "or until text" }] },
  { id: "screenshot", label: "Screenshot", icon: Camera, tool: "browser_screenshot", fields: [{ key: "fullPage", label: "Full page", type: "checkbox" }] },
  { id: "tabs", label: "Tabs", icon: AppWindow, tool: "browser_tabs", fields: [{ key: "action", label: "Action", type: "select", options: ["list", "new", "switch", "close"] }, { key: "index", label: "Index", type: "number" }, { key: "url", label: "URL (new)" }] },
  { id: "downloads", label: "Downloads", icon: Download, tool: "browser_downloads" },
  { id: "console", label: "Console", icon: ListTree, tool: "browser_console", fields: [{ key: "level", label: "Level", type: "select", options: ["error", "all"] }] },
  { id: "evaluate", label: "Evaluate JS", icon: BookOpen, tool: "browser_evaluate", fields: [{ key: "code", label: "Code", placeholder: "document.title" }] },
  { id: "reload", label: "Reload", icon: RefreshCw, tool: "browser_reload", fields: [{ key: "hard", label: "Hard (clear cache)", type: "checkbox" }] },
  { id: "reset", label: "Reset context", icon: Power, tool: "browser_reset" },
  { id: "kill", label: "Close (keep state)", icon: Power, tool: "browser_kill" },
];

export default function BrowserLabPage() {
  const [session, setSession] = useState("default");
  const [op, setOp] = useState<Op>(OPS[0]);
  const [values, setValues] = useState<Record<string, string | boolean>>({ url: "https://example.com" });
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<(BrowserLabResult & { tool: string; at: number })[]>([]);
  const [sessions, setSessions] = useState<BrowserSessionInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const loadSessions = useCallback(() => { api.browserSessions().then((r) => setSessions(r.sessions)).catch(() => undefined); }, []);
  useEffect(() => { loadSessions(); const t = setInterval(loadSessions, 5000); return () => clearInterval(t); }, [loadSessions]);

  function buildArgs(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of op.fields ?? []) {
      const v = values[f.key];
      if (v === undefined || v === "" || v === false) continue;
      if (f.type === "number") out[f.key] = Number(v);
      else if (f.key === "values") out[f.key] = String(v).split(",").map((x) => x.trim()).filter(Boolean);
      else out[f.key] = v;
    }
    return out;
  }

  async function run(tool = op.tool, args = buildArgs()) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.browserLab(session, tool, args);
      setLog((l) => [{ ...r, tool, at: Date.now() }, ...l].slice(0, 30));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
      loadSessions();
    }
  }

  async function cancel() {
    try {
      await api.browserSessionAction(`lab:${session}`, "cancel");
      setLog((l) => [{ ok: true, text: "Cancelled: the live browser was torn down (saved state kept). The in-flight call, if any, fails immediately.", durationMs: 0, session: `lab:${session}`, tool: "cancel", at: Date.now() }, ...l]);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      loadSessions();
    }
  }

  return (
    <AppShell>
      <h1 className="text-[20px] font-semibold tracking-tight">Settings</h1>
      <p className="mb-3 text-[12.5px] text-ink-3">Browser Test Lab — drive the same Nexora Browser the agents use (ported from Tandem) to verify every operation.</p>
      <SettingsTabs />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[400px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel title="Run an operation" subtitle="Session keys are lab:<name>; agents use agent:<id>" icon={<Globe className="h-4 w-4 text-brand" />}>
            <div className="space-y-2.5">
              <Field label="Session"><Input value={session} onChange={(e) => setSession(e.target.value.replace(/[^\w-]/g, "_"))} /></Field>
              <div className="flex flex-wrap gap-1">
                {OPS.map((o) => (
                  <button key={o.id} type="button" onClick={() => setOp(o)} className={cn("flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px]", op.id === o.id ? "border-brand bg-brand/15 text-ink" : "border-line text-ink-2 hover:text-ink")}>
                    <o.icon className="h-3 w-3" /> {o.label}
                  </button>
                ))}
              </div>
              {op.fields?.map((f) => (
                <Field key={f.key} label={f.label}>
                  {f.type === "checkbox" ? (
                    <input type="checkbox" checked={!!values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))} className="h-4 w-4" />
                  ) : f.type === "select" ? (
                    <Select value={String(values[f.key] ?? f.options?.[0] ?? "")} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}>
                      {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                    </Select>
                  ) : (
                    <Input type={f.type === "number" ? "number" : "text"} value={String(values[f.key] ?? "")} placeholder={f.placeholder} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void run(); } }} />
                  )}
                </Field>
              ))}
              {err && <div className="text-[11px] text-[#ff8ea3]">{err}</div>}
              <div className="flex gap-2">
                <Button variant="primary" size="sm" disabled={busy} onClick={() => run()}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Run {op.tool}</Button>
                <Button variant="danger" size="sm" onClick={cancel}><XCircle className="h-3.5 w-3.5" /> Cancel session</Button>
              </div>
            </div>
          </Panel>

          <Panel title="Browser sessions" subtitle="Live instances and saved checkpoints" icon={<AppWindow className="h-4 w-4 text-brand" />}>
            <ul className="space-y-1.5">
              {sessions.map((s) => (
                <li key={s.id} className="rounded-lg border border-line px-2.5 py-1.5 text-[11.5px]">
                  <div className="flex items-center gap-2">
                    <Badge color={s.status === "live" ? "#3dd68c" : "#6f7890"} dot>{s.status}{s.busy ? " · busy" : ""}</Badge>
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">{s.label}</span>
                    <button type="button" title="Release (keep saved state)" onClick={() => api.browserSessionAction(s.id, "release").then(loadSessions)} className="text-ink-3 hover:text-ink"><Power className="h-3.5 w-3.5" /></button>
                    <button type="button" title="Delete saved state" onClick={() => { if (window.confirm(`Erase saved cookies/state for ${s.label}?`)) api.browserSessionAction(s.id, "delete").then(loadSessions); }} className="text-ink-3 hover:text-[#ff7d95]"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10.5px] text-ink-3">{s.id} · {s.currentUrl ?? "no page"} · {s.tabs} tab{s.tabs === 1 ? "" : "s"} · {s.downloads} downloads</div>
                </li>
              ))}
              {sessions.length === 0 && <li className="text-[12px] text-ink-3">No sessions yet.</li>}
            </ul>
          </Panel>
        </div>

        <Panel title="Results" subtitle="Newest first · text as the agent sees it, plus the sanitized activity facts" className="min-h-[600px]">
          <div className="space-y-3">
            {log.map((r) => (
              <div key={r.at} className={cn("rounded-xl border p-3", r.ok ? "border-line bg-white/[0.02]" : "border-danger/30 bg-danger/[0.06]")}>
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="font-mono text-ink">{r.tool}</span>
                  <Badge color={r.ok ? "#3dd68c" : "#ff5c7a"} dot>{r.ok ? "ok" : "failed"}</Badge>
                  <span className="ml-auto text-[10.5px] text-ink-3 num">{r.durationMs} ms · {new Date(r.at).toLocaleTimeString()}</span>
                </div>
                {r.report && (r.report.url || r.report.viewport) && (
                  <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-ink-3">
                    {r.report.url && <span className="truncate font-mono">{r.report.url}</span>}
                    {r.report.viewport && <span className="num">{r.report.viewport.width}×{r.report.viewport.height}</span>}
                  </div>
                )}
                {r.report?.screenshotUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <a href={r.report.screenshotUrl} target="_blank" rel="noreferrer"><img src={r.report.screenshotUrl} alt="screenshot" className="mt-2 max-h-[320px] rounded-lg border border-line" /></a>
                )}
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/25 p-2 text-[10.5px] leading-relaxed text-ink-2">{r.text}</pre>
              </div>
            ))}
            {log.length === 0 && <p className="text-[12px] text-ink-3">Run an operation to see its result here.</p>}
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
