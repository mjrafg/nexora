"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Loader2, MessagesSquare, Pencil, Plug, Sparkles, Trash2, User, Users, Wrench, X, Zap } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { AgentAvatar } from "@/components/ui/Avatar";
import { Checkbox, Field, Input, Select, TagInput, Textarea } from "@/components/ui/Form";
import { RuntimeConfigForm, TestBadge } from "@/components/agents/RuntimeConfigForm";
import { RuntimeIcon, RUNTIME_COLORS } from "@/components/agents/RuntimeBadge";
import { OrgSection } from "@/components/work/OrgSection";
import { AgentMcpAccess } from "@/components/agents/AgentMcpAccess";
import { api, errorText, type Catalog, type RuntimeDraft } from "@/lib/client-api";
import type { AgentView, RuntimeTestResult } from "@/lib/runtime/types";
import { PROVIDERS, RUNTIMES, modelLabel } from "@/lib/runtime/catalog";
import { departments, type DeptId } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

type SectionId = "profile" | "org" | "runtime" | "tools" | "integrations";

const SECTIONS: { id: SectionId; label: string; icon: typeof User }[] = [
  { id: "profile", label: "Profile", icon: User },
  { id: "org", label: "Team & manager", icon: Users },
  { id: "runtime", label: "AI Runtime", icon: Sparkles },
  { id: "tools", label: "Tool permissions", icon: Wrench },
  { id: "integrations", label: "Integrations", icon: Plug },
];

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Everything that configures an agent. The workspace page only links here. */
export default function AgentSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<SectionId>("profile");
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    Promise.all([api.agent(id), api.catalog()])
      .then(([a, c]) => { setAgent(a.agent); setCatalog(c); })
      .catch((e) => setError(errorText(e)));
  }, [id]);

  /** The only place an agent can be deleted — never next to the conversation. */
  async function remove() {
    if (!agent) return;
    if (!window.confirm(`Remove ${agent.name}? Every conversation, transcript and log goes with them. This cannot be undone.`)) return;
    setRemoving(true);
    try {
      await api.deleteAgent(id);
      router.push("/agents");
    } catch (e) {
      setError(errorText(e));
      setRemoving(false);
    }
  }

  if (error) return <AppShell><div className="glass rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div></AppShell>;
  if (!agent || !catalog) {
    return <AppShell><div className="flex items-center gap-2 text-[12.5px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Loading settings…</div></AppShell>;
  }

  const dept = departments[agent.dept];

  return (
    <AppShell>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Link href={`/agents/${agent.id}`} className="grid h-8 w-8 place-items-center rounded-lg border border-line text-ink-3 hover:text-ink" title={`Back to ${agent.name}`}>
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <AgentAvatar id={agent.id} dept={agent.dept} name={agent.name} size={38} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">Agent settings</div>
          <h1 className="flex flex-wrap items-center gap-2 text-[19px] font-semibold tracking-tight">
            {agent.name}
            <Badge color={dept.color}>{dept.shortName}</Badge>
          </h1>
        </div>
        <Link href={`/agents/${agent.id}`}><Button variant="ghost" size="sm"><MessagesSquare className="h-3.5 w-3.5" /> Open chat</Button></Link>
      </div>

      <div className="grid gap-5 lg:grid-cols-[210px_minmax(0,1fr)]">
        <nav className="glass h-fit rounded-2xl p-2 lg:sticky lg:top-4">
          <ul className="space-y-0.5">
            {SECTIONS.map(({ id: sid, label, icon: Icon }) => (
              <li key={sid}>
                <button
                  type="button"
                  onClick={() => setSection(sid)}
                  className={cn("flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[12.5px] transition-colors", section === sid ? "bg-white/[0.08] text-ink" : "text-ink-3 hover:text-ink-2")}
                >
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              </li>
            ))}
          </ul>

        </nav>

        <div className="min-w-0 space-y-4">
          {section === "profile" && <ProfileSection agent={agent} catalog={catalog} onSaved={setAgent} />}
          {section === "runtime" && <RuntimeSection agent={agent} catalog={catalog} onSaved={setAgent} />}
          {section === "tools" && <ToolsSection agent={agent} catalog={catalog} onSaved={setAgent} />}
          {section === "org" && <OrgSection agent={agent} onSaved={setAgent} />}
          {section === "integrations" && <AgentMcpAccess agent={agent} onChanged={setAgent} />}

          {/* Removing the agent: deliberate, explained, and only here */}
          <section className="rounded-2xl border border-danger/25 bg-danger/[0.05] p-4">
            <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-[#ff8ea3]">
              <Trash2 className="h-3.5 w-3.5" /> Remove {agent.name}
            </h2>
            <p className="mt-1 max-w-[62ch] text-[12px] leading-relaxed text-ink-3">
              Every conversation with {agent.name} goes too — each thread, its transcript, its logs and its runtime sessions — and
              anything they were waiting on is closed. This cannot be undone, so export the logs you want to keep first.
            </p>
            <Button variant="danger" size="sm" className="mt-3" onClick={remove} disabled={removing}>
              {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Remove agent
            </Button>
          </section>

          <p className="font-mono text-[10.5px] text-ink-3">id {agent.id}</p>
        </div>
      </div>
    </AppShell>
  );
}

/* ---------------------------------------------------------------- profile */

function ProfileSection({ agent, catalog, onSaved }: { agent: AgentView; catalog: Catalog; onSaved: (a: AgentView) => void }) {
  const [form, setForm] = useState({ name: agent.name, role: agent.role, dept: agent.dept as DeptId, instructions: agent.instructions });
  const [skills, setSkills] = useState(agent.skills);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = form.name !== agent.name || form.role !== agent.role || form.dept !== agent.dept || form.instructions !== agent.instructions || !same(skills, agent.skills);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await api.updateAgent(agent.id, { ...form, skills });
      onSaved(r.agent);
      setSaved(true);
      setTimeout(() => setSaved(false), 2_000);
    } catch (e) { setError(errorText(e)); } finally { setSaving(false); }
  }

  return (
    <Panel title="Profile" subtitle="Who this agent is and how it should work" icon={<User className="h-4 w-4 text-brand" />}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Role"><Input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} /></Field>
        </div>
        <Field label="Department">
          <Select value={form.dept} onChange={(e) => setForm({ ...form, dept: e.target.value as DeptId })}>
            {catalog.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label="Instructions" hint="The agent's standing brief. It is part of every conversation.">
          <Textarea rows={8} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
        </Field>
        <Field label="Skills" hint="Short tags shown to the owner and to the Capability Manager.">
          <TagInput value={skills} onChange={setSkills} placeholder="Add a skill" />
        </Field>
        {error && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-[#ff8ea3]">{error}</div>}
        <div className="flex items-center justify-end gap-3">
          {saved && <span className="flex items-center gap-1 text-[12px] text-operations"><Check className="h-3.5 w-3.5" /> Saved</span>}
          <Button variant="primary" size="sm" onClick={save} disabled={saving || !dirty || !form.name.trim() || !form.role.trim()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save profile
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------- runtime */

function RuntimeSection({ agent, catalog, onSaved }: { agent: AgentView; catalog: Catalog; onSaved: (a: AgentView) => void }) {
  const [changing, setChanging] = useState(false);
  const [draft, setDraft] = useState<RuntimeDraft>({
    runtimeType: agent.runtime.runtimeType,
    providerConnectionId: agent.runtime.providerConnectionId,
    model: agent.runtime.model,
    advancedSettings: { ...agent.runtime.advancedSettings },
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<RuntimeTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rt = agent.runtime.runtimeType;
  const connStatus = agent.connection.status;

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.testAgent(agent.id));
      onSaved((await api.agent(agent.id)).agent);
    } catch (e) {
      setTest({ ok: false, message: "Test failed", detail: errorText(e), durationMs: 0 });
    } finally { setTesting(false); }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await api.updateAgent(agent.id, { runtime: draft });
      onSaved(r.agent);
      setChanging(false);
      setTest(null);
    } catch (e) { setError(errorText(e)); } finally { setSaving(false); }
  }

  return (
    <Panel title="AI Runtime" subtitle="How this agent's messages are executed" icon={<Sparkles className="h-4 w-4 text-brand" />}>
      {!changing ? (
        <>
          <div className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.03] p-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg" style={{ background: `${RUNTIME_COLORS[rt]}1a`, color: RUNTIME_COLORS[rt] }}>
              <RuntimeIcon type={rt} className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold">{RUNTIMES[rt].label}</div>
              <div className="truncate text-[11px] text-ink-3">{RUNTIMES[rt].description}</div>
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-[90px_1fr] gap-y-2 text-[12.5px]">
            <dt className="text-ink-3">Provider</dt>
            <dd className="text-ink">{PROVIDERS[agent.connection.providerType].label} <span className="text-ink-3">· {agent.connection.name}</span></dd>
            <dt className="text-ink-3">Model</dt>
            <dd className="text-ink">
              {modelLabel(agent.connection.providerType, rt, agent.runtime.model)}
              {modelLabel(agent.connection.providerType, rt, agent.runtime.model) !== agent.runtime.model && <span className="ml-1.5 font-mono text-[10.5px] text-ink-3">{agent.runtime.model}</span>}
            </dd>
            <dt className="text-ink-3">Status</dt>
            <dd className="flex items-center gap-1.5 text-ink">
              <span className="h-2 w-2 rounded-full" style={{ background: connStatus === "connected" ? "#3dd68c" : connStatus === "error" ? "#ff5c7a" : "#6f7890" }} />
              {connStatus === "connected" ? "Connected" : connStatus === "error" ? "Error" : "Not tested"}
            </dd>
            {Object.keys(agent.runtime.advancedSettings).length > 0 && (
              <>
                <dt className="text-ink-3">Advanced</dt>
                <dd className="font-mono text-[11px] text-ink-2">{Object.entries(agent.runtime.advancedSettings).map(([k, v]) => `${k}=${v}`).join(" · ")}</dd>
              </>
            )}
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setChanging(true)}><Pencil className="h-3.5 w-3.5" /> Change</Button>
            <Button variant="ghost" size="sm" onClick={runTest} disabled={testing}>{testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />} Test</Button>
          </div>
          {test && <div className="mt-3"><TestBadge result={test} /></div>}
        </>
      ) : (
        <div className="space-y-3">
          <p className="text-[11.5px] text-ink-3">Switching runtime keeps {agent.name}&apos;s id, department, instructions, skills, tools and conversation history.</p>
          <RuntimeConfigForm catalog={catalog} value={draft} onChange={setDraft} compact />
          {error && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-[#ff8ea3]">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setChanging(false)} disabled={saving}><X className="h-3.5 w-3.5" /> Cancel</Button>
            <Button variant="primary" size="sm" onClick={save} disabled={saving || !draft.model.trim()}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save runtime
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ---------------------------------------------------------------- tools */

function ToolsSection({ agent, catalog, onSaved }: { agent: AgentView; catalog: Catalog; onSaved: (a: AgentView) => void }) {
  const [tools, setTools] = useState(agent.toolPermissions);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = !same(tools, agent.toolPermissions);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await api.updateAgent(agent.id, { toolPermissions: tools });
      onSaved(r.agent);
      setSaved(true);
      setTimeout(() => setSaved(false), 2_000);
    } catch (e) { setError(errorText(e)); } finally { setSaving(false); }
  }

  return (
    <Panel title="Tool permissions" subtitle="Everything this agent may reach: company data, payments, credentials, the browser" icon={<Wrench className="h-4 w-4 text-brand" />}>
      <div className="space-y-1.5">
        {catalog.tools.map((t) => (
          <Checkbox key={t.id} checked={tools.includes(t.id)} onChange={(v) => setTools((c) => (v ? [...c, t.id] : c.filter((x) => x !== t.id)))} label={t.label} description={t.description} />
        ))}
      </div>
      {error && <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-[#ff8ea3]">{error}</div>}
      <div className="mt-3 flex items-center justify-end gap-3">
        {saved && <span className="flex items-center gap-1 text-[12px] text-operations"><Check className="h-3.5 w-3.5" /> Saved</span>}
        <Button variant="primary" size="sm" onClick={save} disabled={saving || !dirty}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save permissions
        </Button>
      </div>
    </Panel>
  );
}
