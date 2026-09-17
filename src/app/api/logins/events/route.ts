export const dynamic = "force-dynamic";

import { CREDENTIALS_CHANNEL } from "@/lib/credentials/store";
import { recentActivity, subscribeActivity, type ActivityEvent } from "@/lib/activity";

/** SSE: credential lifecycle events (created, used, required, resolved…) — never secrets. */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  let unsub: (() => void) | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: ActivityEvent) => { try { controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)); } catch { /* closed */ } };
      controller.enqueue(enc.encode(": connected\n\n"));
      for (const ev of recentActivity(CREDENTIALS_CHANNEL, Date.now() - 30_000)) send(ev);
      unsub = subscribeActivity(CREDENTIALS_CHANNEL, send);
      hb = setInterval(() => { try { controller.enqueue(enc.encode(": hb\n\n")); } catch { /* closed */ } }, 20_000);
      req.signal.addEventListener("abort", () => { unsub?.(); if (hb) clearInterval(hb); try { controller.close(); } catch { /* closed */ } });
    },
    cancel() { unsub?.(); if (hb) clearInterval(hb); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
