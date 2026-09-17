"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Checkbox, Field, Input, Select, TagInput, Textarea } from "@/components/ui/Form";
import { RuntimeConfigForm, defaultDraft } from "@/components/agents/RuntimeConfigForm";
import { api, errorText, type Catalog, type RuntimeDraft } from "@/lib/client-api";
import type { DeptId } from "@/lib/mock-data";

export default function HireAgentPage() {
  const router = useRouter();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [runtime, setRuntime] = useState<RuntimeDraft | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [dept, setDept] = useState<DeptId>("engineering");
  const [instructions, setInstructions] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [tools, setTools] = useState<string[]>(["web_search", "read_files"]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .catalog()
      .then((c) => {
        setCatalog(c);
        setRuntime(defaultDraft(c));
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!runtime) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.hire({ name, role, dept, instructions, skills, toolPermissions: tools, runtime });
      router.push(`/agents/${r.agent.id}`);
    } catch (err) {
      setError(errorText(err));
      setSubmitting(false);
    }
  }

  const deptName = catalog?.departments.find((d) => d.id === dept)?.name ?? dept;

  return (
    <AppShell>
      <div className="mb-4 flex items-center gap-3">
        <Link href="/agents" className="grid h-8 w-8 place-items-center rounded-lg border border-line text-ink-3 hover:text-ink">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Hire an agent</h1>
          <p className="text-[12.5px] text-ink-3">Identity and runtime are independent: you can change the AI engine later without losing the agent.</p>
        </div>
      </div>

      {!catalog && !error && (
        <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {catalog && runtime && (
        <form onSubmit={submit} className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-4">
            <Panel title="Identity" subtitle="Who this agent is inside the company">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Field label="Name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ethan" required autoFocus />
                </Field>
                <Field label="Role">
                  <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="CTO" required />
                </Field>
                <Field label="Department">
                  <Select value={dept} onChange={(e) => setDept(e.target.value as DeptId)}>
                    {catalog.departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Instructions" className="mt-3" hint="System-level guidance. Never put API keys or secrets here.">
                <Textarea
                  rows={6}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={`You are ${name || "the agent"}, the ${role || "…"} in ${deptName}. Describe responsibilities, tone, and how to escalate decisions to the owner.`}
                />
              </Field>
            </Panel>

            <Panel title="Skills & tools" subtitle="What the agent knows and what it may touch">
              <Field label="Skills" hint="Press Enter to add a skill tag.">
                <TagInput value={skills} onChange={setSkills} placeholder="e.g. system-design, code-review" />
              </Field>
              <div className="mt-3">
                <div className="mb-1.5 text-[11.5px] font-medium text-ink-2">Tool permissions</div>
                <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
                  {catalog.tools.map((t) => (
                    <Checkbox
                      key={t.id}
                      checked={tools.includes(t.id)}
                      onChange={(v) => setTools((cur) => (v ? [...cur, t.id] : cur.filter((x) => x !== t.id)))}
                      label={t.label}
                      description={t.description}
                    />
                  ))}
                </div>
              </div>
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel title="AI Runtime" subtitle="Engine, provider and model for this agent" icon={<Sparkles className="h-4 w-4 text-brand" />}>
              <RuntimeConfigForm catalog={catalog} value={runtime} onChange={setRuntime} compact />
            </Panel>

            {error && <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-[#ff8ea3]">{error}</div>}

            <div className="flex items-center justify-end gap-2">
              <Link href="/agents">
                <Button type="button" variant="ghost" size="md">
                  Cancel
                </Button>
              </Link>
              <Button type="submit" variant="primary" size="md" disabled={submitting || !name.trim() || !role.trim() || !runtime.model.trim()}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Hire {name.trim() || "agent"}
              </Button>
            </div>
          </div>
        </form>
      )}
    </AppShell>
  );
}
