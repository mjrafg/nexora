export const dynamic = "force-dynamic";

import { CAPABILITY_CHANNEL } from "@/lib/capabilities/store";
import { CAPABILITY_MANAGER_ID } from "@/lib/capabilities/manager";
import { recentActivity, subscribeActivity, type ActivityEvent } from "@/lib/activity";

/** SSE: Capability Manager request activity + the manager agent's own live tool activity (browser, console). */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  const unsubs: (() => void)[] = [];
  let hb: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: ActivityEvent) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)); } catch { /* closed */ }
      };
      controller.enqueue(enc.encode(": connected\n\n"));
      for (const ev of recentActivity(CAPABILITY_CHANNEL, Date.now() - 60_000)) send(ev);
      for (const ev of recentActivity(CAPABILITY_MANAGER_ID, Date.now() - 60_000)) send(ev);
      unsubs.push(subscribeActivity(CAPABILITY_CHANNEL, send), subscribeActivity(CAPABILITY_MANAGER_ID, send));
      hb = setInterval(() => { try { controller.enqueue(enc.encode(": hb\n\n")); } catch { /* closed */ } }, 20_000);
      req.signal.addEventListener("abort", () => {
        for (const u of unsubs) u();
        if (hb) clearInterval(hb);
        try { controller.close(); } catch { /* closed */ }
      });
    },
    cancel() {
      for (const u of unsubs) u();
      if (hb) clearInterval(hb);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
