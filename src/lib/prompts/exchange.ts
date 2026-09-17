/* ------------------------------------------------------------------
   Taking prompts out of Nexora and putting them back.

   The file is keyed by stable prompt id, never by display name, so an
   export from one Nexora applies correctly to another even after the
   built-in names change. Nothing is applied without the owner seeing
   what would change first — an import that silently replaced a
   customization would be the one thing this whole system exists to
   prevent.
   ------------------------------------------------------------------ */

import { promptDef, promptDefs, promptView, savePromptOverride } from "./registry";
import {
  EXPORT_FORMAT, EXPORT_VERSION,
  type ImportEntry, type ImportPreview, type PromptExport, type PromptExportEntry, type PromptView,
} from "./types";

/** Everything asked for, as it stands right now. */
export function exportPrompts(ids?: string[]): PromptExport {
  const wanted = ids?.length ? new Set(ids) : null;
  const prompts: PromptExportEntry[] = promptDefs()
    .filter((d) => !wanted || wanted.has(d.id))
    .map((d) => {
      const v = promptView(d);
      return {
        id: v.id,
        name: v.name,
        description: v.description,
        category: v.category,
        built_in_version: v.version,
        customized: v.customized,
        content: v.content,
      };
    });
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exported_at: new Date().toISOString(), prompts };
}

export function exportFileName(now = new Date()): string {
  return `nexora-prompts-${now.toISOString().slice(0, 10)}.json`;
}

/** What an import would do, decided before anything is written. */
export function previewImport(raw: unknown): ImportPreview {
  const empty = { total: 0, update: 0, unchanged: 0, unknown: 0, invalid: 0, conflict: 0 };
  const file = raw as Partial<PromptExport> | null;
  if (!file || typeof file !== "object") return { ok: false, error: "That file is not a Nexora prompt export.", counts: empty, entries: [] };
  if (file.format !== EXPORT_FORMAT) return { ok: false, error: `Expected a "${EXPORT_FORMAT}" file; this one says "${String(file.format ?? "nothing")}".`, counts: empty, entries: [] };
  if (typeof file.version !== "number" || file.version > EXPORT_VERSION) {
    return { ok: false, error: `This file is version ${String(file.version)}; this Nexora understands up to ${EXPORT_VERSION}.`, counts: empty, entries: [] };
  }
  if (!Array.isArray(file.prompts)) return { ok: false, error: "The file has no prompts in it.", counts: empty, entries: [] };

  const entries: ImportEntry[] = file.prompts.map((p) => entryFor(p));
  const counts = { ...empty, total: entries.length };
  for (const e of entries) counts[e.verdict] += 1;
  return { ok: true, exportedAt: typeof file.exported_at === "string" ? file.exported_at : undefined, counts, entries };
}

function entryFor(p: Partial<PromptExportEntry>): ImportEntry {
  const id = typeof p?.id === "string" ? p.id.trim() : "";
  const name = typeof p?.name === "string" && p.name.trim() ? p.name : id || "(no id)";
  const incoming = typeof p?.content === "string" ? p.content.replace(/\r\n/g, "\n") : "";
  if (!id) return { id: "", name, verdict: "invalid", problem: "The entry has no prompt id.", current: "", incoming, currentIsCustom: false };
  const def = promptDef(id);
  if (!def) {
    return { id, name, verdict: "unknown", problem: "This Nexora version has no prompt with that id. It will be skipped.", current: "", incoming, currentIsCustom: false, fileVersion: typeof p.built_in_version === "number" ? p.built_in_version : undefined };
  }
  const view = promptView(def);
  const base = { id, name: def.name, current: view.content, incoming, currentIsCustom: view.customized, fileVersion: typeof p.built_in_version === "number" ? p.built_in_version : undefined, builtInVersion: def.version };
  if (!incoming.trim()) return { ...base, verdict: "invalid", problem: `"${def.name}" would be left empty, which is not allowed.` };
  if (incoming.length > 100_000) return { ...base, verdict: "invalid", problem: `"${def.name}" is longer than the 100,000 character limit.` };
  if (incoming === view.content) return { ...base, verdict: "unchanged" };
  // a customization the owner made themselves is not overwritten quietly
  if (view.customized) return { ...base, verdict: "conflict", problem: "You have your own version of this prompt. Importing replaces it." };
  return { ...base, verdict: "update" };
}

export type ImportResult = {
  applied: string[];
  skipped: { id: string; reason: string }[];
};

/** Apply exactly the ids the owner ticked, and nothing else. */
export function applyImport(raw: unknown, ids: string[], by = "owner"): ImportResult {
  const preview = previewImport(raw);
  if (!preview.ok) throw new Error(preview.error ?? "That file cannot be imported.");
  const wanted = new Set(ids);
  const applied: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const e of preview.entries) {
    if (!wanted.has(e.id)) continue;
    if (e.verdict === "unknown" || e.verdict === "invalid") {
      skipped.push({ id: e.id, reason: e.problem ?? "It cannot be applied." });
      continue;
    }
    if (e.verdict === "unchanged") {
      skipped.push({ id: e.id, reason: "Already exactly this text." });
      continue;
    }
    savePromptOverride(e.id, e.incoming, { by, source: "IMPORT" });
    applied.push(e.id);
  }
  return { applied, skipped };
}

/** The ids an import would sensibly tick by default: everything that can apply. */
export function applicableIds(preview: ImportPreview): string[] {
  return preview.entries.filter((e) => e.verdict === "update" || e.verdict === "conflict").map((e) => e.id);
}

/** Counts for the header of Settings → Prompts. */
export function promptCounts(views: PromptView[]) {
  return {
    all: views.length,
    customized: views.filter((v) => v.customized).length,
    updateAvailable: views.filter((v) => v.updateAvailable).length,
    categories: new Set(views.map((v) => v.category)).size,
  };
}
