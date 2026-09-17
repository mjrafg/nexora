/* ------------------------------------------------------------------
   Node-only boot hooks (loaded from instrumentation.ts via dynamic import so
   the Edge bundle never sees process.* calls):
     - resume project sessions and capability requests interrupted by a restart
     - repair agent waiting states whose backing request no longer exists
     - start the browser idle reaper
     - on SIGTERM/SIGINT checkpoint every browser (cookies/localStorage + last
       page) so continuity recovers after the restart (ported from Tandem)
   ------------------------------------------------------------------ */

import { recoverProjectRuns } from "@/lib/projects/director";
import { reconcileAgentWaiting } from "@/lib/agents/waiting";
import { recoverCapabilityRequests } from "@/lib/capabilities/manager";
import { shutdownBrowsers, startBrowserReaper } from "@/lib/browser/host";
import { recoverLedger } from "@/lib/guard";
import { recoverTasks } from "@/lib/tasks/service";
import "@/lib/tools/servers";

let booted = false;

export function bootNexora(): void {
  if (booted) return;
  booted = true;
  try {
    recoverProjectRuns();
  } catch {
    /* first boot with no data yet */
  }
  try {
    recoverCapabilityRequests();
  } catch (err) {
    console.error("[nexora] capability recovery failed:", err);
  }
  try {
    // an agent must never come back from a restart waiting for something that
    // no longer exists (deleted, resolved or cancelled while we were down)
    const { checked, repaired } = reconcileAgentWaiting();
    if (repaired.length) console.log(`[agents] reconciled ${repaired.length}/${checked} waiting states: ${repaired.join("; ")}`);
  } catch (err) {
    console.error("[agents] waiting reconciliation failed:", err);
  }
  try {
    recoverLedger();
  } catch (err) {
    console.error("[guard] ledger recovery failed:", err);
  }
  try {
    // work that was running when we went down did not finish: it goes back in
    // the queue and is picked up again in the same execution scope
    const { requeued } = recoverTasks();
    if (requeued) console.log(`[tasks] ${requeued} interrupted task(s) requeued after restart`);
  } catch (err) {
    console.error("[tasks] recovery failed:", err);
  }
  startBrowserReaper();
  // anything that starts waiting on the owner is announced within seconds,
  // wherever in the product it was created
  const announce = setInterval(() => {
    void import("@/lib/owner-actions/notify").then(({ announceNewActions }) => announceNewActions()).catch(() => undefined);
  }, 15_000);
  announce.unref?.();
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[nexora] received ${signal} — checkpointing browsers, exiting 0`);
    void shutdownBrowsers().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 8_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
