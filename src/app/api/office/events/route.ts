export const dynamic = "force-dynamic";

import { OFFICE_CHANNEL } from "@/lib/office/floor";
import { subscribeActivity, type ActivityEvent } from "@/lib/activity";

/**
 * SSE: a nudge whenever anything the office shows has moved — a turn
 * starting or ending, work assigned, started, finished, blocked or
 * cancelled, an agent parked on or released from a wait. The payload is
 * only a reason: the client refetches the authoritative floor, so a missed
 * event costs a refresh and never a wrong picture.
 */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  let unsub: (() => void) | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: ActivityEvent) => { try { controller.enqueue(enc.encode(`data: ${JSON.stringify({ title: ev.title, agentId: ev.detail, ts: ev.ts })}\n\n`)); } catch { /* closed */ } };
      controller.enqueue(enc.encode(": connected\n\n"));
      unsub = subscribeActivity(OFFICE_CHANNEL, send);
      hb = setInterval(() => { try { controller.enqueue(enc.encode(": hb\n\n")); } catch { /* closed */ } }, 20_000);
      req.signal.addEventListener("abort", () => { unsub?.(); if (hb) clearInterval(hb); try { controller.close(); } catch { /* closed */ } });
    },
    cancel() { unsub?.(); if (hb) clearInterval(hb); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
