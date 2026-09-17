export const dynamic = "force-dynamic";

import fs from "node:fs";
import { shotPath } from "@/lib/browser/host";

/** Browser screenshots (owner-authenticated via the proxy; names are validated, never joined from raw input). */
export async function GET(_req: Request, ctx: { params: Promise<{ session: string; file: string }> }) {
  const { session, file } = await ctx.params;
  const full = shotPath(session, file);
  if (!full) return new Response(JSON.stringify({ error: "Screenshot not found." }), { status: 404, headers: { "content-type": "application/json" } });
  const body = fs.readFileSync(full);
  return new Response(new Uint8Array(body), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=604800, immutable" } });
}
