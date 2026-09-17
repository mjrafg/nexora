export const dynamic = "force-dynamic";

import { COMPANY_CHANNEL } from "@/lib/company/store";
import { recentActivity, subscribeActivity, type ActivityEvent } from "@/lib/activity";

/** SSE: company profile events (updates, contacts, information requests) — never field values. */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  let unsub: (() => void) | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: ActivityEvent) => { try { controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)); } catch { /* closed */ } };
      controller.enqueue(enc.encode(": connected\n\n"));
      for (const ev of recentActivity(COMPANY_CHANNEL, Date.now() - 30_000)) send(ev);
      unsub = subscribeActivity(COMPANY_CHANNEL, send);
      hb = setInterval(() => { try { controller.enqueue(enc.encode(": hb\n\n")); } catch { /* closed */ } }, 20_000);
      req.signal.addEventListener("abort", () => { unsub?.(); if (hb) clearInterval(hb); try { controller.close(); } catch { /* closed */ } });
    },
    cancel() { unsub?.(); if (hb) clearInterval(hb); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
