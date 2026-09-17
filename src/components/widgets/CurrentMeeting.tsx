"use client";

import { Video, CheckCircle2, Circle, ArrowRight, Mic } from "lucide-react";
import { currentMeeting as m, upcomingMeetings, agentById, departments } from "@/lib/mock-data";
import { Panel, PanelLink } from "@/components/ui/Panel";
import { AgentAvatar, AvatarStack } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { rgba } from "@/lib/iso";

export function CurrentMeeting() {
  const color = departments.conference.color;
  return (
    <Panel
      title="Current Meeting"
      subtitle={m.room}
      icon={<Video className="h-4 w-4 text-conference" strokeWidth={1.8} />}
      action={<Badge color="#ff5c7a" dot>LIVE</Badge>}
    >
      <div className="rounded-xl border p-3" style={{ borderColor: rgba(color, 0.3), background: `linear-gradient(160deg, ${rgba(color, 0.14)}, rgba(255,255,255,0.02))` }}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 className="text-[13.5px] font-semibold">{m.title}</h4>
            <p className="text-[11px] text-ink-3 num">{m.startedAt} – {m.endsAt} · 25 min left</p>
          </div>
          <AvatarStack ids={m.participants} size={22} max={4} />
        </div>
        <div className="mt-2.5 h-1 rounded-full bg-white/[0.08]">
          <div className="h-1 rounded-full" style={{ width: `${m.progress * 100}%`, background: color }} />
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1">
          {m.participants.map((id) => {
            const a = agentById[id];
            const d = departments[a.dept];
            return (
              <span key={id} className="inline-flex items-center gap-1 rounded-md bg-black/25 px-1.5 py-0.5 text-[10.5px] text-ink-2">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: d.color }} /> {a.name}
                {id === "kai" && <Mic className="h-2.5 w-2.5 text-operations" />}
              </span>
            );
          })}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Agenda</p>
          <ul className="mt-1.5 space-y-1">
            {m.agenda.map((a) => (
              <li key={a.label} className="flex items-start gap-1.5 text-[11.5px]">
                {a.done ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-operations" /> : <Circle className="mt-0.5 h-3 w-3 shrink-0 text-ink-3" />}
                <span className={a.done ? "text-ink-3 line-through" : "text-ink-2"}>{a.label}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Decisions</p>
          <ul className="mt-1.5 space-y-1">
            {m.decisions.map((d) => (
              <li key={d} className="rounded-md border-l-2 pl-2 text-[11.5px] text-ink-2" style={{ borderColor: color }}>{d}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-3">
        <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Action items</p>
        <ul className="mt-1.5 space-y-1">
          {m.actionItems.map((ai) => (
            <li key={ai.text} className="flex items-center gap-2 rounded-lg border border-line bg-white/[0.02] px-2 py-1.5 text-[11.5px]">
              <AgentAvatar id={ai.owner} size={16} />
              <span className="flex-1 truncate text-ink-2">{ai.text}</span>
              <span className="text-[10.5px] text-ink-3">{ai.due}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" size="xs">Join as observer <ArrowRight className="h-3 w-3" /></Button>
        <Button variant="ghost" size="xs">Read transcript</Button>
      </div>

      <div className="mt-3 border-t border-line pt-2.5">
        <div className="flex items-center justify-between">
          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Up next</p>
          <PanelLink>Calendar</PanelLink>
        </div>
        <ul className="mt-1.5 space-y-1">
          {upcomingMeetings.map((u) => (
            <li key={u.id} className="flex items-center gap-2 text-[11.5px]">
              <span className="num w-9 text-ink-3">{u.time}</span>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: departments[u.dept].color }} />
              <span className="flex-1 truncate text-ink-2">{u.title}</span>
              <AvatarStack ids={u.participants} size={16} max={3} />
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
