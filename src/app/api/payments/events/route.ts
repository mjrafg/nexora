export const dynamic = "force-dynamic";

import { PAYMENTS_CHANNEL } from "@/lib/payments/store";
import { recentActivity, subscribeActivity, type ActivityEvent } from "@/lib/activity";

/** SSE: payment lifecycle events so the Payments pages update live. */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  let unsub: (() => void) | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: ActivityEvent) => { try { controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)); } catch { /* closed */ } };
      controller.enqueue(enc.encode(": connected\n\n"));
      for (const ev of recentActivity(PAYMENTS_CHANNEL, Date.now() - 30_000)) send(ev);
      unsub = subscribeActivity(PAYMENTS_CHANNEL, send);
      hb = setInterval(() => { try { controller.enqueue(enc.encode(": hb\n\n")); } catch { /* closed */ } }, 20_000);
      req.signal.addEventListener("abort", () => { unsub?.(); if (hb) clearInterval(hb); try { controller.close(); } catch { /* closed */ } });
    },
    cancel() { unsub?.(); if (hb) clearInterval(hb); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
