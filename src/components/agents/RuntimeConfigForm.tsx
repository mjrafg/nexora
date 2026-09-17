"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, CheckCircle2, Loader2, XCircle, Zap } from "lucide-react";
import { Field, Input, Select } from "@/components/ui/Form";
import { Button } from "@/components/ui/Button";
import { api, errorText, type Catalog, type RuntimeDraft } from "@/lib/client-api";
import type { RuntimeTestResult, RuntimeType } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

const CUSTOM = "__custom__";

export function defaultDraft(catalog: Catalog): RuntimeDraft {
  const conn =
    catalog.connections.find((c) => c.providerType === catalog.defaults.providerType) ?? catalog.connections[0];
  return {
    runtimeType: catalog.defaults.runtimeType,
    providerConnectionId: conn?.id ?? "",
    model: catalog.defaults.model,
    advancedSettings: {},
  };
}

/** Runtime / Provider / Model selector with Test and a collapsed Advanced section. */
export function RuntimeConfigForm({
  catalog,
  value,
  onChange,
  compact,
}: {
  catalog: Catalog;
  value: RuntimeDraft;
  onChange: (v: RuntimeDraft) => void;
  compact?: boolean;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<RuntimeTestResult | null>(null);

  const runtimeMeta = catalog.runtimes.find((r) => r.type === value.runtimeType)!;
  const connections = useMemo(
    () => catalog.connections.filter((c) => runtimeMeta.providers.includes(c.providerType)),
    [catalog.connections, runtimeMeta]
  );
  const connection = catalog.connections.find((c) => c.id === value.providerConnectionId);
  const providerMeta = connection ? catalog.providers[connection.providerType] : undefined;
  const knownModels = useMemo(() => {
    if (!providerMeta) return [];
    return value.runtimeType === "codex" ? providerMeta.codexModels ?? providerMeta.models : providerMeta.models;
  }, [providerMeta, value.runtimeType]);

  const isKnown = knownModels.some((m) => m.id === value.model);
  const [customMode, setCustomMode] = useState(!isKnown && !!value.model);

  // Any change to the combination invalidates the last test result.
  const update = (v: RuntimeDraft) => {
    setTest(null);
    onChange(v);
  };

  function setRuntime(runtimeType: RuntimeType) {
    const meta = catalog.runtimes.find((r) => r.type === runtimeType)!;
    const conns = catalog.connections.filter((c) => meta.providers.includes(c.providerType));
    const keep = conns.find((c) => c.id === value.providerConnectionId);
    const conn = keep ?? conns[0];
    const pm = conn ? catalog.providers[conn.providerType] : undefined;
    const models = runtimeType === "codex" ? pm?.codexModels ?? pm?.models ?? [] : pm?.models ?? [];
    const model =
      runtimeType === "codex"
        ? catalog.defaults.codexModel ?? models[0]?.id ?? ""
        : models.some((m) => m.id === value.model)
          ? value.model
          : runtimeType === catalog.defaults.runtimeType && conn?.providerType === catalog.defaults.providerType
            ? catalog.defaults.model
            : models[0]?.id ?? value.model;
    setCustomMode(!models.some((m) => m.id === model) && !!model);
    update({ ...value, runtimeType, providerConnectionId: conn?.id ?? "", model });
  }

  function setConnection(id: string) {
    const conn = catalog.connections.find((c) => c.id === id);
    const pm = conn ? catalog.providers[conn.providerType] : undefined;
    const models = value.runtimeType === "codex" ? pm?.codexModels ?? pm?.models ?? [] : pm?.models ?? [];
    const model = models.some((m) => m.id === value.model)
      ? value.model
      : conn?.providerType === "anthropic" && value.runtimeType !== "codex"
        ? catalog.defaults.model
        : models[0]?.id ?? "";
    setCustomMode(models.length === 0 || (!models.some((m) => m.id === model) && !!model));
    update({ ...value, providerConnectionId: id, model });
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.testRuntime(value));
    } catch (err) {
      setTest({ ok: false, message: "Test failed", detail: errorText(err), durationMs: 0 });
    } finally {
      setTesting(false);
    }
  }

  const grid = compact ? "grid grid-cols-1 gap-3" : "grid grid-cols-1 gap-3 md:grid-cols-3";

  return (
    <div className="space-y-3">
      <div className={grid}>
        <Field label="Runtime" hint={runtimeMeta.description}>
          <Select value={value.runtimeType} onChange={(e) => setRuntime(e.target.value as RuntimeType)}>
            {catalog.runtimes.map((r) => (
              <option key={r.type} value={r.type}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Provider"
          hint={
            connections.length === 0 ? (
              <span className="text-warning">
                No connection for this runtime. <Link href="/settings/providers" className="text-brand">Add one in Settings → AI Providers</Link>.
              </span>
            ) : connection && !connection.authConfigured && value.runtimeType === "api" ? (
              <span className="text-warning">No API key configured for this connection.</span>
            ) : connection && !connection.authConfigured ? (
              `No key on this connection — ${runtimeMeta.label} will use its own login.`
            ) : undefined
          }
        >
          <Select value={value.providerConnectionId} onChange={(e) => setConnection(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {catalog.providers[c.providerType].label} · {c.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Model" hint={customMode ? "Enter any model id supported by the provider." : undefined}>
          {customMode || knownModels.length === 0 ? (
            <div className="flex gap-1.5">
              <Input
                value={value.model}
                onChange={(e) => update({ ...value, model: e.target.value })}
                placeholder={providerMeta?.type === "custom" ? "my-model" : "model-id"}
                autoFocus={knownModels.length > 0}
              />
              {knownModels.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCustomMode(false);
                    update({ ...value, model: knownModels[0].id });
                  }}
                >
                  List
                </Button>
              )}
            </div>
          ) : (
            <Select
              value={isKnown ? value.model : CUSTOM}
              onChange={(e) => {
                if (e.target.value === CUSTOM) {
                  setCustomMode(true);
                  update({ ...value, model: "" });
                } else update({ ...value, model: e.target.value });
              }}
            >
              {knownModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              <option value={CUSTOM}>Custom model id…</option>
            </Select>
          )}
        </Field>
      </div>

      {/* Test row */}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="ghost" size="sm" onClick={runTest} disabled={testing || !value.providerConnectionId || !value.model}>
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
          {testing ? "Testing…" : "Test connection"}
        </Button>
        {test && <TestBadge result={test} />}
      </div>

      {/* Advanced */}
      <div className="rounded-xl border border-line bg-white/[0.02]">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-3 py-2 text-[12px] text-ink-2 hover:text-ink"
        >
          {advancedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Advanced
          <span className="ml-auto text-[10.5px] text-ink-3">optional</span>
        </button>
        {advancedOpen && (
          <div className="grid grid-cols-1 gap-3 border-t border-line px-3 py-3 sm:grid-cols-2">
            {value.runtimeType === "api" && (
              <>
                <Field label="Max output tokens">
                  <Input
                    type="number"
                    min={1}
                    value={value.advancedSettings.maxTokens ?? ""}
                    placeholder="4096"
                    onChange={(e) => update({ ...value, advancedSettings: { ...value.advancedSettings, maxTokens: e.target.value ? Number(e.target.value) : undefined } })}
                  />
                </Field>
                <Field label="Temperature">
                  <Input
                    type="number"
                    step={0.1}
                    min={0}
                    max={2}
                    value={value.advancedSettings.temperature ?? ""}
                    placeholder="provider default"
                    onChange={(e) => update({ ...value, advancedSettings: { ...value.advancedSettings, temperature: e.target.value ? Number(e.target.value) : undefined } })}
                  />
                </Field>
              </>
            )}
            {value.runtimeType === "claude-code" && (
              <Field label="Max agentic turns per message">
                <Input
                  type="number"
                  min={1}
                  value={value.advancedSettings.maxTurns ?? ""}
                  placeholder="8"
                  onChange={(e) => update({ ...value, advancedSettings: { ...value.advancedSettings, maxTurns: e.target.value ? Number(e.target.value) : undefined } })}
                />
              </Field>
            )}
            {value.runtimeType === "codex" && (
              <Field label="Reasoning effort">
                <Select
                  value={value.advancedSettings.reasoningEffort ?? ""}
                  onChange={(e) => update({ ...value, advancedSettings: { ...value.advancedSettings, reasoningEffort: (e.target.value || undefined) as "low" | "medium" | "high" | undefined } })}
                >
                  <option value="">Codex default</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </Select>
              </Field>
            )}
            {value.runtimeType !== "api" && (
              <Field label="Working directory" hint="Defaults to a private workspace under data/workspaces.">
                <Input
                  value={value.advancedSettings.workingDirectory ?? ""}
                  placeholder="/path/to/project"
                  onChange={(e) => update({ ...value, advancedSettings: { ...value.advancedSettings, workingDirectory: e.target.value || undefined } })}
                />
              </Field>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function TestBadge({ result }: { result: RuntimeTestResult }) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[12px]",
        result.ok ? "border-success/30 bg-success/10 text-[#7de8b3]" : "border-danger/30 bg-danger/10 text-[#ff8ea3]"
      )}
    >
      {result.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <div className="min-w-0">
        <div className="font-medium">
          {result.ok ? "Connected" : "Connection failed"}
          {result.durationMs ? <span className="ml-1.5 text-[10.5px] font-normal opacity-70 num">{(result.durationMs / 1000).toFixed(1)}s</span> : null}
        </div>
        <div className="break-words text-[11px] opacity-80">{result.ok ? result.detail ?? "Agent runtime responded successfully." : `${result.message}${result.detail ? ` — ${result.detail}` : ""}`}</div>
      </div>
    </div>
  );
}
