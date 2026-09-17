export const dynamic = "force-dynamic";

import { getProject, projectChannel } from "@/lib/projects/store";
import { recentActivity, subscribeActivity, type ActivityEvent } from "@/lib/activity";

/** SSE stream of everything happening in a project: Director turns, sessions, reviews, state. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!getProject(id)) return new Response(JSON.stringify({ error: "Project not found" }), { status: 404, headers: { "content-type": "application/json" } });
  const channel = projectChannel(id);
  const enc = new TextEncoder();
  let unsub: (() => void) | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: ActivityEvent) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          /* closed */
        }
      };
      controller.enqueue(enc.encode(": connected\n\n"));
      for (const ev of recentActivity(channel, Date.now() - 60_000)) send(ev);
      unsub = subscribeActivity(channel, send);
      hb = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": hb\n\n"));
        } catch {
          /* closed */
        }
      }, 20_000);
      req.signal.addEventListener("abort", () => {
        unsub?.();
        if (hb) clearInterval(hb);
        try {
          controller.close();
        } catch {
          /* closed */
        }
      });
    },
    cancel() {
      unsub?.();
      if (hb) clearInterval(hb);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
