export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { buildSessionExport, contentType, fileName, renderExport, type ExportFormat } from "@/lib/projects/export";

const FORMATS: ExportFormat[] = ["markdown", "json"];

/** The complete log of one session, as a file. `?inline=1` to read it in place. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; key: string }> }) {
  const { id, key } = await ctx.params;
  const bundle = buildSessionExport(id, decodeURIComponent(key));
  if (!bundle) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const params = new URL(req.url).searchParams;
  const raw = (params.get("format") ?? "markdown") as ExportFormat;
  const format = FORMATS.includes(raw) ? raw : "markdown";
  const disposition = params.get("inline") === "1" ? "inline" : `attachment; filename="${fileName(bundle, format)}"`;
  return new Response(renderExport(bundle, format), {
    headers: { "content-type": contentType(format), "content-disposition": disposition, "cache-control": "no-store" },
  });
}
