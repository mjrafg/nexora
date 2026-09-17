export const dynamic = "force-dynamic";

import { readDb } from "@/lib/store/db";
import { recentActivity, subscribeActivity, type ActivityEvent } from "@/lib/activity";

type Ctx = { params: Promise<{ id: string }> };

/** Server-Sent Events stream of live agent activity (tools, commands) for one agent. */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!readDb().agents.some((a) => a.id === id)) {
    return new Response(JSON.stringify({ error: "Agent not found" }), { status: 404, headers: { "content-type": "application/json" } });
  }
  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: ActivityEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          /* closed */
        }
      };
      controller.enqueue(encoder.encode(": connected\n\n"));
      // replay the last few seconds so a just-opened stream shows an in-flight turn
      for (const ev of recentActivity(id, Date.now() - 10_000)) send(ev);
      unsub = subscribeActivity(id, send);
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": hb\n\n"));
        } catch {
          /* closed */
        }
      }, 20_000);
      req.signal.addEventListener("abort", () => {
        unsub?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      unsub?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
