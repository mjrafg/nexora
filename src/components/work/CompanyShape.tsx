"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Building2, Check, Loader2 } from "lucide-react";
import { AgentAvatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Form";
import { api, errorText } from "@/lib/client-api";
import type { AgentView } from "@/lib/runtime/types";

/**
 * Who coordinates the company.
 *
 * There is no "CEO" object in Nexora and there should not be one: an agent
 * with managers reporting to it IS the top of the company, and it gets the
 * management tools for the same reason everyone else does. This strip only
 * exists because a company can be left half-connected — several managers,
 * nobody above them — and then an objective has nowhere to land. It changes
 * exactly the relationships it names, and nothing else.
 */
export function CompanyShape({ agents, onChanged }: { agents: AgentView[]; onChanged: () => void }) {
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { chief, heads, candidates, peopleUnder } = useMemo(() => {
    const manages = (id: string) => agents.filter((a) => a.managerAgentId === id);
    const managers = agents.filter((a) => manages(a.id).length > 0);
    const heads = managers.filter((m) => !m.managerAgentId);
    const chief = agents.find((a) => !a.managerAgentId && managers.some((m) => m.managerAgentId === a.id));
    const under = new Set<string>();
    if (chief) {
      const walk = (id: string) => { for (const a of manages(id)) if (!under.has(a.id)) { under.add(a.id); walk(a.id); } };
      walk(chief.id);
    }
    return {
      chief,
      heads,
      candidates: agents.filter((a) => !a.managerAgentId && !a.system),
      peopleUnder: under.size,
    };
  }, [agents]);

  // one manager and nothing above it is a perfectly good small company
  if (chief || heads.length < 2) {
    if (!chief) return null;
    const leads = agents.filter((a) => a.managerAgentId === chief.id);
    return (
      <section className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-white/[0.02] px-3 py-2.5">
        <Building2 className="h-4 w-4 shrink-0 text-brand" />
        <span className="text-[12.5px] text-ink-2">
          <Link href={`/agents/${chief.id}`} className="font-medium text-ink hover:text-brand">{chief.name}</Link>{" "}
          coordinates {leads.length} manager{leads.length === 1 ? "" : "s"} and {peopleUnder} {peopleUnder === 1 ? "person" : "people"}.
          Give them an outcome and they will decide which departments it needs.
        </span>
        <Link href={`/agents/${chief.id}`} className="ms-auto text-[11.5px] text-brand hover:text-ink">Talk to {chief.name}</Link>
      </section>
    );
  }

  const chosen = agents.find((a) => a.id === pick);
  const willMove = chosen ? heads.filter((h) => h.id !== chosen.id) : [];

  async function apply() {
    if (!chosen || !willMove.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const h of willMove) await api.updateAgent(h.id, { managerAgentId: chosen.id });
      onChanged();
      setPick("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-4 rounded-2xl border border-line bg-white/[0.02] px-3 py-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Building2 className="h-4 w-4 shrink-0 text-brand" />
        <span className="text-[12.5px] text-ink-2">
          {heads.length} managers run their own teams, with nobody above them. Choose who coordinates the company and an objective can be given once, instead of department by department.
        </span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Select className="h-8 w-[220px] text-[12px]" value={pick} disabled={busy} onChange={(e) => setPick(e.target.value)}>
          <option value="">Who coordinates the company…</option>
          {candidates.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.role}</option>)}
        </Select>
        {chosen && (
          <span className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
            {willMove.length ? <>will become the manager of {willMove.map((h) => <span key={h.id} className="inline-flex items-center gap-1 align-middle"><AgentAvatar id={h.id} dept={h.dept as never} name={h.name} size={16} /><span className="text-ink-2">{h.name}</span></span>)}</> : "already has nobody to take on"}
          </span>
        )}
        <Button variant="primary" size="sm" className="ms-auto" disabled={busy || !willMove.length} onClick={() => void apply()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Set it
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-ink-3">Nothing else changes: only the managers named above get a new manager, and every agent can still be talked to directly.</p>
      {error && <p className="mt-1.5 text-[11.5px] text-[#ff8ea3]">{error}</p>}
    </section>
  );
}
