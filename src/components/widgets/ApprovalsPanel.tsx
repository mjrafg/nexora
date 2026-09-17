"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ShieldCheck, Rocket, FileSignature, Megaphone, UserPlus, Tag, Check, X, Eye } from "lucide-react";
import { approvals as seed, agentById, departments, Approval } from "@/lib/mock-data";
import { Panel, PanelLink } from "@/components/ui/Panel";
import { Badge, riskColor } from "@/components/ui/Badge";
import { AgentAvatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { rgba } from "@/lib/iso";

const CAT_ICON = { deploy: Rocket, contract: FileSignature, campaign: Megaphone, hire: UserPlus, pricing: Tag } as const;

export function ApprovalsPanel() {
  const [items, setItems] = useState<Approval[]>(seed);
  const [expanded, setExpanded] = useState<string | null>(seed[0].id);
  const pending = items.filter((a) => a.state === "pending");

  const decide = (id: string, state: Approval["state"]) =>
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, state } : a)));

  return (
    <Panel
      title="Approvals"
      subtitle={`${pending.length} waiting for you`}
      icon={<ShieldCheck className="h-4 w-4 text-ceo" strokeWidth={1.8} />}
      action={<PanelLink>View all</PanelLink>}
      bodyClassName="px-2 pb-2"
    >
      <ul className="space-y-1.5">
        <AnimatePresence initial={false}>
          {items.map((a) => {
            const agent = agentById[a.requester];
            const dept = departments[agent.dept];
            const Icon = CAT_ICON[a.category];
            const open = expanded === a.id;
            const decided = a.state !== "pending";
            return (
              <motion.li
                key={a.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: decided ? 0.55 : 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                className="rounded-xl border border-line bg-white/[0.025] hover:bg-white/[0.04] transition-colors"
              >
                <button className="flex w-full items-start gap-2.5 px-2.5 py-2 text-left" onClick={() => setExpanded(open ? null : a.id)}>
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg" style={{ background: rgba(dept.color, 0.14), color: dept.color }}>
                    <Icon className="h-3.5 w-3.5" strokeWidth={2} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`truncate text-[12px] font-medium ${decided ? "line-through text-ink-3" : "text-ink"}`}>{a.action}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-3">
                      <AgentAvatar id={a.requester} size={14} />
                      {agent.name} · {agent.role}
                      <span>· {a.requestedAgo} ago</span>
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    {decided ? (
                      <Badge color={a.state === "approved" ? "#3dd68c" : "#ff5c7a"}>{a.state}</Badge>
                    ) : (
                      <Badge color={riskColor[a.risk]} dot>{a.risk} risk</Badge>
                    )}
                  </span>
                </button>
                <AnimatePresence initial={false}>
                  {open && !decided && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.22 }}
                      className="overflow-hidden"
                    >
                      <div className="px-2.5 pb-2.5">
                        <p className="rounded-lg border border-line bg-black/20 px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-2">{a.summary}</p>
                        <div className="mt-2 flex items-center gap-1.5">
                          <Button variant="success" size="xs" onClick={() => decide(a.id, "approved")}>
                            <Check className="h-3 w-3" /> Approve
                          </Button>
                          <Button variant="danger" size="xs" onClick={() => decide(a.id, "rejected")}>
                            <X className="h-3 w-3" /> Reject
                          </Button>
                          <Button variant="outline" size="xs" className="ml-auto">
                            <Eye className="h-3 w-3" /> Review
                          </Button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
      {pending.length === 0 && (
        <div className="mt-2 rounded-xl border border-dashed border-line px-3 py-6 text-center">
          <ShieldCheck className="mx-auto h-5 w-5 text-operations" />
          <p className="mt-2 text-[12px] font-medium">Inbox zero</p>
          <p className="text-[11px] text-ink-3">Your agents will ask when they need you.</p>
        </div>
      )}
    </Panel>
  );
}
