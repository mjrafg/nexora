export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { buildProjectExport, buildSessionsExport, contentType, fileName, renderExport, type ExportFormat } from "@/lib/projects/export";

const FORMATS: ExportFormat[] = ["markdown", "json"];

/**
 * The complete log of a project, as a file.
 *
 * `?inline=1` to read it in place rather than download it — which is what the
 * Copy buttons use, since a clipboard needs the text, not an attachment.
 * `?sessions=S1.1,S2.1` narrows it to those session logs; `?sessions=` with no
 * value means every session, without the Director conversation.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const params = new URL(req.url).searchParams;
  const picked = params.get("sessions");
  const bundle = picked === null
    ? buildProjectExport(id)
    : buildSessionsExport(id, picked.split(",").map((k) => k.trim()).filter(Boolean));
  if (!bundle) return NextResponse.json({ error: picked === null ? "Project not found" : "No matching sessions" }, { status: 404 });
  const raw = (params.get("format") ?? "markdown") as ExportFormat;
  const format = FORMATS.includes(raw) ? raw : "markdown";
  const disposition = params.get("inline") === "1" ? "inline" : `attachment; filename="${fileName(bundle, format)}"`;
  return new Response(renderExport(bundle, format), {
    headers: { "content-type": contentType(format), "content-disposition": disposition, "cache-control": "no-store" },
  });
}
