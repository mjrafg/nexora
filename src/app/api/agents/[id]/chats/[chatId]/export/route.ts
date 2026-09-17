export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { buildExportBundle, contentType, fileName, renderExport, type ExportFormat } from "@/lib/chats/export";
import { getChat } from "@/lib/chats/store";

type Ctx = { params: Promise<{ id: string; chatId: string }> };

const FORMATS: ExportFormat[] = ["markdown", "json", "html"];

/** The complete log of one chat, as a file. `?inline=1` to read it in place. */
export async function GET(req: Request, ctx: Ctx) {
  const { id, chatId } = await ctx.params;
  const chat = getChat(chatId);
  if (!chat || chat.agentId !== id) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  const params = new URL(req.url).searchParams;
  const raw = (params.get("format") ?? "markdown") as ExportFormat;
  const format = FORMATS.includes(raw) ? raw : "markdown";
  const bundle = buildExportBundle(chatId);
  if (!bundle) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  const body = renderExport(bundle, format);
  const disposition = params.get("inline") === "1" ? "inline" : `attachment; filename="${fileName(bundle, format)}"`;
  return new Response(body, {
    headers: { "content-type": contentType(format), "content-disposition": disposition, "cache-control": "no-store" },
  });
}
