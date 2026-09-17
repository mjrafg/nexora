"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Wrench, Activity, ListChecks, MessageSquare, LayoutDashboard, Loader2, CheckCircle2, XCircle, Hourglass, CreditCard, Globe, Server, ShieldCheck, ChevronDown, ChevronRight, Plus,
} from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { AgentAvatar } from "@/components/ui/Avatar";
import { Field, Input, Select, Textarea } from "@/components/ui/Form";
import { ActivityFeed } from "@/components/agents/ActivityFeed";
import { CurrentAgentChat } from "@/components/agents/AgentChat";
import { api, errorText, type ActivityEvent, type CapabilityActivity, type CapabilityManagerOverview, type CapabilityRequest, type CapabilityView } from "@/lib/client-api";
import type { AgentView } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";
import { useRequestFocus } from "@/lib/use-request-focus";

type Section = "overview" | "requests" | "activity" | "chat";

const STATUS_COLOR: Record<CapabilityRequest["status"], string> = {
  PENDING: "#6f7890",
  RESEARCHING: "#4f8bff",
  INSTALLING: "#a78bfa",
  TESTING: "#2fd4e6",
  RESOLVED: "#3dd68c",
  WAITING_FOR_PAYMENT: "#f5b942",
  FAILED: "#ff5c7a",
};

const KIND_LABEL: Record<CapabilityActivity["kind"], string> = {
  requested: "Capability requested",
  existing_found: "Existing capability found",
  research_started: "Research started",
  browser_started: "Browser session started",
  candidate_selected: "Candidate selected",
  mcp_installed: "MCP installed",
  connection_tested: "Connection tested",
  tools_discovered: "Tools discovered",
  grant_created: "Tool grant created",
  credential_stored: "Credential stored",
  payment_requested: "Payment approval requested",
  payment_decided: "Payment decided",
  resolved: "Capability resolved",
  failed: "Request failed",
  agent_resumed: "Agent resumed",
  note: "Note",
};

export default function CapabilitiesPage() {
  const [data, setData] = useState<{ capabilities: CapabilityView[]; overview: CapabilityManagerOverview; requests: CapabilityRequest[]; activity: CapabilityActivity[] } | null>(null);
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("overview");
  const [live, setLive] = useState<ActivityEvent[]>([]);

  const refresh = useCallback(() => {
    api.capabilities().then((d) => {
      setData(d);
      setError(null);
      api.agent(d.overview.agentId).then((a) => setAgent(a.agent)).catch(() => undefined);
    }).catch((e) => setError(errorText(e)));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // live: request activity + the manager's own tool/browser events; any status event refreshes the snapshot
  useEffect(() => {
    const es = new EventSource("/api/capabilities/activity");
    let timer: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as ActivityEvent;
        if (ev.agentId === "capability-manager" && ev.kind !== "status") {
          setLive((cur) => {
            const i = cur.findIndex((x) => x.id === ev.id);
            const next = i >= 0 ? cur.map((x, j) => (j === i ? ev : x)) : [...cur, ev];
            return next.slice(-80);
          });
        }
        if (timer) clearTimeout(timer);
        timer = setTimeout(refresh, 400);
      } catch { /* ignore */ }
    };
    return () => { es.close(); if (timer) clearTimeout(timer); };
  }, [refresh]);

  const ov = data?.overview;
  const waiting = data?.requests.filter((r) => r.status === "WAITING_FOR_PAYMENT") ?? [];
  const activeReqs = data?.requests.filter((r) => ["PENDING", "RESEARCHING", "INSTALLING", "TESTING"].includes(r.status)) ?? [];

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Capabilities</h1>
          <p className="text-[12.5px] text-ink-3">What the company can do today, and the Capability Manager that fills the gaps autonomously.</p>
        </div>
        {ov && (
          <Link href={`/agents/${ov.agentId}`}>
            <Button variant="ghost" size="sm"><Wrench className="h-3.5 w-3.5" /> Open agent profile</Button>
          </Link>
        )}
      </div>

      {error && <div className="glass mb-4 rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div>}
      {!data && !error && <div className="flex items-center gap-2 text-[12.5px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>}

      {data && ov && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          {/* Left: Capability Manager */}
          <div className="space-y-4">
            <Panel className="overflow-hidden" bodyClassName="!p-0">
              <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
                <AgentAvatar id={ov.agentId} dept="operations" name={ov.name} online={ov.working ? "busy" : "online"} size={40} status />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[15px] font-semibold">{ov.name} <Badge color="#2fd4e6">System</Badge></div>
                  <div className="text-[11.5px] text-ink-3">{ov.role}</div>
                </div>
                <div className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]", ov.working ? "border-operations/40 bg-operations/10 text-operations" : "border-line text-ink-3")}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", ov.working ? "bg-operations pulse-ring" : "bg-ink-3")} /> {ov.working ? "Working" : "Idle"}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
                <Stat label="Current task" value={ov.currentTask ?? "Nothing queued"} small />
                <Stat label="Requests" value={`${ov.activeRequests} active`} sub={ov.waitingForPayment ? `${ov.waitingForPayment} awaiting payment` : undefined} />
                <Stat label="Capabilities added" value={String(ov.capabilitiesAdded)} sub={`${ov.capabilitiesAvailable} available`} />
                <Stat label="MCP servers" value={`${ov.mcpServersConnected} connected`} sub={`${ov.mcpServersTotal} total`} />
              </div>
              <div className="flex gap-1 border-t border-line px-2 pt-2">
                {([["overview", "Overview", LayoutDashboard], ["requests", "Requests", ListChecks], ["activity", "Activity", Activity], ["chat", "Chat", MessageSquare]] as const).map(([id, label, Icon]) => (
                  <button key={id} type="button" onClick={() => setSection(id)} className={cn("flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12.5px]", section === id ? "border-brand text-ink" : "border-transparent text-ink-3 hover:text-ink-2")}>
                    <Icon className="h-3.5 w-3.5" /> {label}
                    {id === "requests" && activeReqs.length + waiting.length > 0 && <span className="rounded-md bg-white/[0.08] px-1.5 text-[10px] num">{activeReqs.length + waiting.length}</span>}
                  </button>
                ))}
              </div>
              <div className="p-4">
                {section === "overview" && <Overview data={data} live={live} onDecide={refresh} />}
                {section === "requests" && <Requests requests={data.requests} onChanged={refresh} />}
                {section === "activity" && <ActivityLog activity={data.activity} live={live} />}
                {section === "chat" && (agent ? <div className="-m-4 min-h-[560px]"><CurrentAgentChat agent={agent} /></div> : <div className="text-[12px] text-ink-3">Loading chat…</div>)}
              </div>
            </Panel>
          </div>

          {/* Right: registry */}
          <div className="space-y-4">
            <Panel title="Capability registry" subtitle="The same registry the Capability Manager reads programmatically" icon={<ShieldCheck className="h-4 w-4 text-brand" />}>
              <ul className="space-y-1.5">
                {data.capabilities.map((c) => <CapabilityRow key={c.id} c={c} />)}
              </ul>
            </Panel>
            <NewRequest onCreated={refresh} />
          </div>
        </div>
      )}
    </AppShell>
  );
}

function Stat({ label, value, sub, small }: { label: string; value: string; sub?: string; small?: boolean }) {
  return (
    <div className="bg-bg-2/60 px-4 py-3">
      <div className="text-[10.5px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className={cn("mt-0.5 truncate font-semibold", small ? "text-[12.5px]" : "text-[15px]")} title={value}>{value}</div>
      {sub && <div className="text-[11px] text-ink-3">{sub}</div>}
    </div>
  );
}

function CapabilityRow({ c }: { c: CapabilityView }) {
  const [open, setOpen] = useState(false);
  const ok = c.status === "available";
  const Icon = c.kind === "native" ? Globe : Server;
  return (
    <li className="rounded-xl border border-line bg-white/[0.02]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
        <Icon className={cn("h-4 w-4 shrink-0", ok ? "text-operations" : "text-ink-3")} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink">{c.name}{c.registered && <span className="text-[10px] text-ink-3">registered</span>}</div>
          <div className="truncate text-[11px] text-ink-3">{ok ? c.provider : "Unavailable"}{c.toolCount ? ` · ${c.toolCount} tools` : ""}</div>
        </div>
        <Badge color={ok ? "#3dd68c" : "#6f7890"} dot>{ok ? "Available" : "Unavailable"}</Badge>
        {open ? <ChevronDown className="h-3.5 w-3.5 text-ink-3" /> : <ChevronRight className="h-3.5 w-3.5 text-ink-3" />}
      </button>
      {open && (
        <div className="border-t border-line px-3 py-2 text-[11.5px] text-ink-2">
          <p>{c.description}</p>
          {c.tools && c.tools.length > 0 && <p className="mt-1 font-mono text-[10.5px] text-ink-3">{c.tools.join(", ")}</p>}
        </div>
      )}
    </li>
  );
}

function Overview({ data, live, onDecide }: { data: { requests: CapabilityRequest[]; activity: CapabilityActivity[] }; live: ActivityEvent[]; onDecide: () => void }) {
  const waiting = data.requests.filter((r) => r.status === "WAITING_FOR_PAYMENT");
  const active = data.requests.filter((r) => ["PENDING", "RESEARCHING", "INSTALLING", "TESTING"].includes(r.status));
  const recent = data.activity.slice(0, 8);
  const running = live.filter((e) => e.status === "running").slice(-3);
  return (
    <div className="space-y-4">
      {waiting.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-warning">Payment approval needed</div>
          {waiting.map((r) => <PaymentCard key={r.id} r={r} onDecided={onDecide} />)}
        </div>
      )}
      {running.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">Current action</div>
          <ActivityFeed events={running} live />
        </div>
      )}
      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">Active requests</div>
        {active.length === 0 ? <p className="text-[12px] text-ink-3">No open requests. Agents call <code className="font-mono text-[11px]">request_capability</code> when they lack a tool; it lands here, not with you.</p> : (
          <ul className="space-y-1.5">{active.map((r) => <RequestRow key={r.id} r={r} compact />)}</ul>
        )}
      </div>
      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">Previous</div>
        <ul className="space-y-1">
          {recent.map((a) => (
            <li key={a.id} className="flex items-start gap-2 text-[12px]">
              {a.kind === "failed" ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#ff7d95]" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-operations" />}
              <span className="min-w-0 flex-1 text-ink-2">{a.text}</span>
              <span className="shrink-0 text-[10.5px] text-ink-3 num">{new Date(a.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </li>
          ))}
          {recent.length === 0 && <li className="text-[12px] text-ink-3">Nothing yet.</li>}
        </ul>
      </div>
    </div>
  );
}

function Requests({ requests, onChanged }: { requests: CapabilityRequest[]; onChanged: () => void }) {
  if (requests.length === 0) return <p className="text-[12px] text-ink-3">No capability requests yet.</p>;
  return <ul className="space-y-2">{requests.map((r) => <RequestRow key={r.id} r={r} onChanged={onChanged} />)}</ul>;
}

function RequestRow({ r, compact, onChanged }: { r: CapabilityRequest; compact?: boolean; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const color = STATUS_COLOR[r.status];
  const focus = useRequestFocus();
  return (
    <li {...focus.focusProps(r.id)} className={cn("rounded-xl border border-line bg-white/[0.02]", focus.focusClass(r.id))}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
        {r.status === "WAITING_FOR_PAYMENT" ? <CreditCard className="h-4 w-4 shrink-0 text-warning" /> : r.status === "RESOLVED" ? <CheckCircle2 className="h-4 w-4 shrink-0 text-operations" /> : r.status === "FAILED" ? <XCircle className="h-4 w-4 shrink-0 text-[#ff7d95]" /> : <Hourglass className="h-4 w-4 shrink-0 text-brand" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-ink">{r.capability}</div>
          <div className="truncate text-[11px] text-ink-3">for {r.requesterName} · {r.note ?? r.reason}</div>
        </div>
        <Badge color={color} dot>{r.status.replace(/_/g, " ")}</Badge>
        {!compact && (open ? <ChevronDown className="h-3.5 w-3.5 text-ink-3" /> : <ChevronRight className="h-3.5 w-3.5 text-ink-3" />)}
      </button>
      {open && !compact && (
        <div className="space-y-2 border-t border-line px-3 py-2 text-[11.5px] text-ink-2">
          <div><span className="text-ink-3">Reason:</span> {r.reason || "—"}</div>
          {r.context && <div><span className="text-ink-3">Context:</span> <span dir="auto" className="inline-block whitespace-pre-wrap align-top">{r.context}</span></div>}
          {r.resolution && <div className="rounded-lg border border-operations/30 bg-operations/[0.06] px-2.5 py-1.5"><span className="text-operations">Resolved:</span> {r.resolution.summary}{r.resolution.granted.length > 0 && <div className="mt-0.5 font-mono text-[10.5px] text-ink-3">granted: {r.resolution.granted.join(", ")}</div>}</div>}
          {r.error && <div className="rounded-lg border border-danger/30 bg-danger/[0.08] px-2.5 py-1.5 text-[#ffb3ae]">{r.error}</div>}
          {r.payment && r.status === "WAITING_FOR_PAYMENT" && <PaymentCard r={r} onDecided={onChanged ?? (() => undefined)} />}
          {r.payment?.decision && <div className="text-ink-3">Payment {r.payment.decision} by the owner{r.payment.ownerNote ? ` — ${r.payment.ownerNote}` : ""}.</div>}
          <div className="flex items-center gap-3 text-[10.5px] text-ink-3 num">
            <span>#{r.id.slice(0, 8)}</span><span>{r.turns} manager turn{r.turns === 1 ? "" : "s"}</span><span>{new Date(r.createdAt).toLocaleString()}</span>
            {r.resumedAt && <span className="text-operations">agent resumed</span>}
          </div>
          <Discuss r={r} />
        </div>
      )}
    </li>
  );
}

function PaymentCard({ r, onDecided }: { r: CapabilityRequest; onDecided: () => void }) {
  const p = r.payment!;
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function decide(d: "approved" | "rejected") {
    setBusy(d);
    setErr(null);
    try {
      if (p.paymentRequestId) {
        if (d === "approved") await api.approvePayment(p.paymentRequestId, null, note.trim() || undefined);
        else await api.rejectPayment(p.paymentRequestId, note.trim() || undefined);
      } else await api.decidePayment(r.id, d, note.trim() || undefined);
      onDecided();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="rounded-xl border border-warning/40 bg-warning/[0.06] p-3 text-[12px]">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-warning"><CreditCard className="h-3.5 w-3.5" /> Payment approval</div>
      <dl className="mt-2 grid grid-cols-[110px_1fr] gap-y-1 text-ink-2">
        <dt className="text-ink-3">Capability</dt><dd>{r.capability} <span className="text-ink-3">· for {r.requesterName}</span></dd>
        <dt className="text-ink-3">Recommended</dt><dd className="font-medium text-ink">{p.product}</dd>
        <dt className="text-ink-3">Cost</dt><dd className="num">{p.cost} <span className="text-ink-3">· {p.billing}</span></dd>
        <dt className="text-ink-3">Why</dt><dd>{p.why}</dd>
        <dt className="text-ink-3">Free alternatives</dt><dd>{p.alternatives}</dd>
        <dt className="text-ink-3">Recommendation</dt><dd>{p.recommendation}</dd>
      </dl>
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note for the Capability Manager" className="mt-2" />
      {err && <div className="mt-1 text-[11px] text-[#ff8ea3]">{err}</div>}
      <div className="mt-2 flex gap-2">
        <Button variant="success" size="sm" disabled={!!busy} onClick={() => decide("approved")}>{busy === "approved" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Approve</Button>
        <Button variant="danger" size="sm" disabled={!!busy} onClick={() => decide("rejected")}>{busy === "rejected" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />} Reject</Button>
        <span className="self-center text-[11px] text-ink-3">{p.paymentRequestId ? <>uses the default payment method — <Link href="/payments/requests" className="text-brand hover:text-ink">choose another in Payments</Link></> : "or discuss below — nothing is spent until you approve."}</span>
      </div>
    </div>
  );
}

function Discuss({ r }: { r: CapabilityRequest }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.discussRequest(r.id, text.trim());
      setReply(res.reply);
      setText("");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Discuss this request with the Capability Manager…" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void send(); } }} />
        <Button variant="ghost" size="sm" disabled={busy || !text.trim()} onClick={send}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />} Send</Button>
      </div>
      {err && <div className="text-[11px] text-[#ff8ea3]">{err}</div>}
      {reply && <div dir="auto" className="whitespace-pre-wrap rounded-lg border border-line bg-black/20 px-2.5 py-1.5 text-[11.5px] text-ink-2">{reply}</div>}
    </div>
  );
}

function ActivityLog({ activity, live }: { activity: CapabilityActivity[]; live: ActivityEvent[] }) {
  const tools = useMemo(() => live.filter((e) => e.kind !== "status"), [live]);
  return (
    <div className="space-y-4">
      {tools.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">Live tool activity</div>
          <ActivityFeed events={tools} live />
        </div>
      )}
      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">Event log</div>
        <ul className="divide-y divide-line/70 rounded-lg border border-line bg-black/20">
          {activity.map((a) => (
            <li key={a.id} className="px-3 py-1.5 text-[12px]">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-ink-3">{KIND_LABEL[a.kind] ?? a.kind}</span>
                <span className="min-w-0 flex-1 truncate text-ink">{a.text}</span>
                <span className="shrink-0 text-[10.5px] text-ink-3 num">{new Date(a.ts).toLocaleString()}</span>
              </div>
              {a.detail && <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap text-[10.5px] text-ink-3">{a.detail}</pre>}
            </li>
          ))}
          {activity.length === 0 && <li className="px-3 py-2 text-[12px] text-ink-3">No activity yet.</li>}
        </ul>
      </div>
    </div>
  );
}

function NewRequest({ onCreated }: { onCreated: () => void }) {
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [agentId, setAgentId] = useState("");
  const [capability, setCapability] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.agents().then((r) => setAgents(r.agents.filter((a) => a.system !== "capability-manager"))).catch(() => undefined); }, []);
  async function submit() {
    if (!agentId || !capability.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.createCapabilityRequest({ agentId, capability: capability.trim(), reason: reason.trim(), context: "Filed by the owner from the Capabilities page." });
      setCapability("");
      setReason("");
      onCreated();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="File a request" subtitle="Simulate an agent asking for a capability (agents normally do this themselves)" icon={<Plus className="h-4 w-4 text-brand" />}>
      <div className="space-y-2">
        <Field label="On behalf of">
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Choose an agent…</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.role}</option>)}
          </Select>
        </Field>
        <Field label="Capability"><Input value={capability} onChange={(e) => setCapability(e.target.value)} placeholder="e.g. Cloudflare DNS management" /></Field>
        <Field label="Reason"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why the agent needs it" /></Field>
        {err && <div className="text-[11px] text-[#ff8ea3]">{err}</div>}
        <div className="flex justify-end"><Button variant="primary" size="sm" disabled={busy || !agentId || !capability.trim()} onClick={submit}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Send to Capability Manager</Button></div>
      </div>
    </Panel>
  );
}
