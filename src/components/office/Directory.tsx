"use client";

import Link from "next/link";
import { AgentAvatar } from "@/components/ui/Avatar";
import type { DeptId } from "@/lib/mock-data";
import type { Floor, FloorAgent } from "@/lib/office/floor";
import { cn } from "@/lib/utils";
import { STATE_META, StateDot } from "./states";

/**
 * The same company, without the drawing.
 *
 * Everything the office shows is here as text: real departments, real
 * people, the real thing each of them is doing. It is the view for a
 * screen reader, a narrow phone, or anyone who would simply rather read.
 */
export function Directory({
  floor, selected, onSelect, onSelectAgent,
}: {
  floor: Floor;
  selected: DeptId | null;
  onSelect: (d: DeptId | null) => void;
  onSelectAgent: (id: string) => void;
}) {
  const rooms = floor.departments.filter((d) => !selected || d.id === selected);
  return (
    <div className="h-full overflow-y-auto px-4 pb-4 pt-14">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn("rounded-lg border px-2.5 py-1 text-[11.5px] transition-colors", !selected ? "border-brand/50 bg-brand/[0.14] text-ink" : "border-line text-ink-3 hover:text-ink")}
        >
          Everyone <span className="num text-[10.5px]">{floor.totals.agents}</span>
        </button>
        {floor.departments.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => onSelect(selected === d.id ? null : d.id)}
            className={cn("rounded-lg border px-2.5 py-1 text-[11.5px] transition-colors", selected === d.id ? "text-ink" : "border-line text-ink-3 hover:text-ink")}
            style={selected === d.id ? { borderColor: `${d.color}99`, background: `${d.color}22` } : undefined}
          >
            {d.name} <span className="num text-[10.5px]">{d.agents.length}</span>
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {rooms.map((d) => (
          <section key={d.id}>
            <h3 className="mb-1.5 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.12em]" style={{ color: d.color }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: d.color }} />
              {d.name}
              <span className="num font-normal text-ink-3">{d.agents.length}</span>
            </h3>
            {d.agents.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line px-3 py-3 text-[11.5px] text-ink-3">
                Nobody works in {d.name} yet.
              </p>
            ) : (
              <ul className="space-y-1">
                {d.agents.map((a) => <li key={a.id}><Row agent={a} onSelect={onSelectAgent} /></li>)}
              </ul>
            )}
          </section>
        ))}
        {floor.unassigned.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-3">No department</h3>
            <ul className="space-y-1">{floor.unassigned.map((a) => <li key={a.id}><Row agent={a} onSelect={onSelectAgent} /></li>)}</ul>
          </section>
        )}
      </div>
    </div>
  );
}

function Row({ agent, onSelect }: { agent: FloorAgent; onSelect: (id: string) => void }) {
  const meta = STATE_META[agent.state];
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-line bg-white/[0.02] px-2.5 py-2">
      <button type="button" onClick={() => onSelect(agent.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-start">
        <AgentAvatar id={agent.id} dept={agent.dept} name={agent.name} size={28} />
        <span className="min-w-0 flex-1">
          <span dir="auto" className="block truncate text-[12.5px] font-medium text-ink">{agent.name}</span>
          <span dir="auto" className="block truncate text-[11px] text-ink-3">{agent.role}</span>
          {/* the state is the point of this row, so it stays at every width */}
          <span className="mt-0.5 flex items-center gap-1.5 @[520px]:hidden">
            <StateDot state={agent.state} size={12} />
            <span className="truncate text-[10.5px]" style={{ color: meta.color }}>{meta.short}</span>
          </span>
        </span>
        <span className="hidden min-w-0 items-center gap-1.5 @[520px]:flex">
          <StateDot state={agent.state} size={14} />
          <span className="truncate text-[11px]" style={{ color: meta.color }}>{meta.short}</span>
        </span>
      </button>
      <Link href={`/agents/${agent.id}`} className="shrink-0 text-[11px] text-brand hover:text-ink">Chat</Link>
    </div>
  );
}

/** Who reports to whom, as it really stands. */
export function OrgChart({ floor, onSelectAgent }: { floor: Floor; onSelectAgent: (id: string) => void }) {
  const all: FloorAgent[] = [...floor.departments.flatMap((d) => d.agents), ...floor.unassigned];
  const roots = all.filter((a) => !a.managerId || !all.some((x) => x.id === a.managerId));
  const kids = (id: string) => all.filter((a) => a.managerId === id);

  const Node = ({ agent, depth }: { agent: FloorAgent; depth: number }) => (
    <li>
      <div className="flex items-center gap-2 py-0.5" style={{ paddingInlineStart: depth * 14 }}>
        <StateDot state={agent.state} size={12} />
        <button type="button" onClick={() => onSelectAgent(agent.id)} className="truncate text-[12px] text-ink hover:text-brand">{agent.name}</button>
        <span dir="auto" className="truncate text-[11px] text-ink-3">{agent.role}</span>
        {agent.reports > 0 && <span className="num shrink-0 rounded-md border border-line px-1 text-[10px] text-ink-3">{agent.reports}</span>}
      </div>
      {depth < 6 && kids(agent.id).length > 0 && (
        <ul className="border-s border-line" style={{ marginInlineStart: depth * 14 + 6 }}>
          {kids(agent.id).map((k) => <Node key={k.id} agent={k} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  );

  return (
    <div className="h-full overflow-y-auto px-4 pb-4 pt-14">
      <p className="mb-3 text-[11.5px] text-ink-3">
        Who reports to whom. An agent with people under it manages them — there is nothing else to set up.
      </p>
      <ul>{roots.map((r) => <Node key={r.id} agent={r} depth={0} />)}</ul>
    </div>
  );
}
