export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { DEFAULT_RUNTIME, PROVIDERS, RUNTIMES, TOOL_CATALOG } from "@/lib/runtime/catalog";
import { codexModelCatalog, configuredCodexModel } from "@/lib/runtime/adapters/codex";
import { readDb } from "@/lib/store/db";
import { toConnectionView } from "@/lib/providers-view";
import { deptList } from "@/lib/mock-data";

export async function GET() {
  const db = readDb();
  const codexModel = configuredCodexModel();
  const providers = structuredClone(PROVIDERS);
  const live = codexModelCatalog();
  if (live) providers.openai.codexModels = live;
  if (codexModel && !providers.openai.codexModels?.some((m) => m.id === codexModel)) {
    providers.openai.codexModels = [{ id: codexModel, label: `${codexModel} (configured in ~/.codex)` }, ...(providers.openai.codexModels ?? [])];
  }
  return NextResponse.json({
    runtimes: Object.values(RUNTIMES),
    providers,
    connections: db.providerConnections.map(toConnectionView),
    tools: TOOL_CATALOG,
    departments: deptList.filter((d) => d.id !== "conference").map((d) => ({ id: d.id, name: d.name, color: d.color })),
    defaults: { ...DEFAULT_RUNTIME, codexModel: codexModel ?? providers.openai.codexModels?.[0]?.id },
  });
}
