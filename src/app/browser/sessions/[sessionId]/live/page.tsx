"use client";

import { use, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { BrowserLiveView } from "@/components/agents/BrowserLiveView";
import { api, errorText } from "@/lib/client-api";
import type { AgentView } from "@/lib/runtime/types";

/**
 * Same-origin live view of one browser session, with no app chrome, so it can
 * be embedded (iframe or native) wherever the owner needs the page — the Needs
 * You card, a full-screen takeover on a phone. External sites refuse to be
 * framed, so what is embedded is always this Agent24 viewer, never the site.
 *
 * The session id is the agent's own key: "agent:<id>" (or the URL-safe
 * "agent_<id>").
 */
export default function BrowserLivePage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  const agentId = decodeURIComponent(sessionId).replace(/^agent[:_]/, "");
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.agent(agentId).then((r) => setAgent(r.agent)).catch((e) => setError(errorText(e)));
  }, [agentId]);

  if (error) return <div className="p-4 text-[12.5px] text-[#ff8ea3]">{error}</div>;
  if (!agent) {
    return <div className="flex h-[100dvh] items-center justify-center gap-2 text-[12.5px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" /> Opening the session…</div>;
  }
  return (
    <main className="flex h-[100dvh] flex-col bg-bg">
      <BrowserLiveView agentId={agent.id} agentName={agent.name} className="flex-1" />
    </main>
  );
}
