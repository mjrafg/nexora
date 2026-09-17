/* ------------------------------------------------------------------
   The Prompt Registry.

   Every static instruction Nexora sends to a model is declared here by a
   definition module and read back through getPrompt/renderPrompt. There
   is exactly one place that decides whether the owner's text or the
   built-in text is used, which is why "reset to default" can always be
   trusted: the built-in never leaves source control.

   Registering is a side effect of importing a definition module; the
   index module imports them all, so anything that imports "@/lib/prompts"
   sees the whole registry.
   ------------------------------------------------------------------ */

import { newId, now, readDb, updateDb } from "@/lib/store/db";
import type { PromptDef, PromptOverride, PromptRevision, PromptRevisionSource, PromptView } from "./types";

const defs = new Map<string, PromptDef>();
/**
 * Two definitions claiming one id is a bug, and it must be loud. But a module
 * re-evaluated by the dev server's hot reload registers the same ids again on
 * purpose, and that is not a collision — so the check applies while the
 * registry is still loading, and a later registration simply replaces.
 */
let loading = true;

/**
 * Declare a built-in prompt. Call this at module load; the id must be
 * unique and stable for the life of the product, because overrides,
 * exports and revisions are all keyed by it.
 */
export function registerPrompt(def: PromptDef): PromptDef {
  const id = def.id.trim();
  if (!id) throw new Error("A prompt needs an id.");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Prompt id "${id}" must be lower-case words joined by hyphens.`);
  const existing = defs.get(id);
  if (loading && existing && existing.name !== def.name) throw new Error(`Two different prompts are registered as "${id}": "${existing.name}" and "${def.name}".`);
  if (!def.name.trim()) throw new Error(`Prompt "${id}" needs a name.`);
  if (!def.description.trim()) throw new Error(`Prompt "${id}" needs a description.`);
  if (!def.defaultContent.trim()) throw new Error(`Prompt "${id}" needs built-in content.`);
  if (!Number.isInteger(def.version) || def.version < 1) throw new Error(`Prompt "${id}" needs a whole version number from 1 up.`);
  defs.set(id, { ...def, id });
  return defs.get(id)!;
}

export function promptDefs(): PromptDef[] {
  loading = false;
  return [...defs.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export function promptDef(id: string): PromptDef | undefined {
  return defs.get(id);
}

export function isRegistered(id: string): boolean {
  return defs.has(id);
}

/* ---------------------------------------------------------------- overrides */

function overrides(): PromptOverride[] {
  return readDb().promptOverrides ?? [];
}

export function promptOverride(id: string): PromptOverride | undefined {
  return overrides().find((o) => o.promptId === id);
}

/* ---------------------------------------------------------------- resolve */

/**
 * The text the runtime must use for this prompt: the owner's, if they have
 * written one, else the built-in. This is the ONLY place that choice is made.
 */
export function getPrompt(id: string): string {
  loading = false;
  const def = defs.get(id);
  if (!def) throw new Error(`No prompt is registered as "${id}". Register it with registerPrompt before using it.`);
  const custom = promptOverride(id)?.content;
  return custom && custom.trim() ? custom : def.defaultContent;
}

/** Several at once, in the order asked for. */
export function getPrompts(ids: string[]): string[] {
  return ids.map(getPrompt);
}

/** Resolve, then fill the {{placeholders}} Nexora owns with runtime values. */
export function renderPrompt(id: string, vars: Record<string, string | number | null | undefined> = {}): string {
  return fill(getPrompt(id), vars);
}

/** The same substitution, for text that has already been resolved. */
export function fill(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(vars[k] ?? ""));
}

/* ---------------------------------------------------------------- views */

export function promptView(def: PromptDef): PromptView {
  const o = promptOverride(def.id);
  const customized = !!o?.content?.trim();
  const revisions = (readDb().promptRevisions ?? []).filter((r) => r.promptId === def.id).length;
  return {
    ...def,
    content: customized ? o!.content : def.defaultContent,
    customized,
    customContent: customized ? o!.content : undefined,
    overrideBaseVersion: o?.baseVersion,
    updateAvailable: customized && (o?.baseVersion ?? def.version) < def.version,
    lastModifiedAt: o?.updatedAt,
    lastModifiedBy: o?.updatedBy,
    lastModifiedSource: o?.source,
    revisions,
    status: customized ? "customized" : "built-in",
  };
}

export function promptViews(): PromptView[] {
  return promptDefs().map(promptView);
}

/* ---------------------------------------------------------------- writes */

export class PromptError extends Error {}

/** The owner replaces a prompt's text. Refuses to empty a prompt the product needs. */
export function savePromptOverride(id: string, content: string, opts: { by?: string; source?: "MANUAL" | "IMPORT" } = {}): PromptView {
  const def = defs.get(id);
  if (!def) throw new PromptError(`No prompt is registered as "${id}".`);
  const text = content.replace(/\r\n/g, "\n");
  if (!text.trim()) throw new PromptError(`"${def.name}" cannot be empty — reset it to the built-in text instead.`);
  if (text.length > 100_000) throw new PromptError(`"${def.name}" is too long (limit 100,000 characters).`);
  const by = opts.by ?? "owner";
  const source = opts.source ?? "MANUAL";
  // no-op edits do not deserve a revision
  if (promptOverride(id)?.content === text) return promptView(def);
  updateDb((d) => {
    d.promptOverrides ??= [];
    d.promptRevisions ??= [];
    const existing = d.promptOverrides.find((o) => o.promptId === id);
    const record: PromptOverride = { promptId: id, content: text, baseVersion: def.version, updatedAt: now(), updatedBy: by, source };
    if (existing) Object.assign(existing, record);
    else d.promptOverrides.push(record);
    d.promptRevisions.push(revision(id, text, def.version, by, source));
    trimRevisions(d.promptRevisions, id);
  });
  return promptView(def);
}

/** Drop the owner's text. The built-in was never touched, so it simply applies again. */
export function resetPrompt(id: string, opts: { by?: string } = {}): PromptView {
  const def = defs.get(id);
  if (!def) throw new PromptError(`No prompt is registered as "${id}".`);
  if (!promptOverride(id)) return promptView(def);
  const by = opts.by ?? "owner";
  updateDb((d) => {
    d.promptOverrides = (d.promptOverrides ?? []).filter((o) => o.promptId !== id);
    d.promptRevisions ??= [];
    d.promptRevisions.push(revision(id, null, def.version, by, "RESET"));
    trimRevisions(d.promptRevisions, id);
  });
  return promptView(def);
}

export function promptRevisions(id: string): PromptRevision[] {
  return (readDb().promptRevisions ?? []).filter((r) => r.promptId === id).sort((a, b) => b.changedAt.localeCompare(a.changedAt));
}

/** Put an earlier text back. Restoring a reset point resets. */
export function restoreRevision(revisionId: string, opts: { by?: string } = {}): PromptView {
  const rev = (readDb().promptRevisions ?? []).find((r) => r.id === revisionId);
  if (!rev) throw new PromptError("That revision no longer exists.");
  const def = defs.get(rev.promptId);
  if (!def) throw new PromptError(`No prompt is registered as "${rev.promptId}".`);
  return rev.content === null ? resetPrompt(rev.promptId, opts) : savePromptOverride(rev.promptId, rev.content, { by: opts.by, source: "MANUAL" });
}

function revision(promptId: string, content: string | null, baseVersion: number, by: string, source: PromptRevisionSource): PromptRevision {
  return { id: newId(), promptId, content, baseVersion, changedAt: now(), changedBy: by, source };
}

/** Keep a useful amount of history, not a version-control system. */
function trimRevisions(all: PromptRevision[], promptId: string): void {
  const mine = all.filter((r) => r.promptId === promptId);
  if (mine.length <= 20) return;
  const drop = new Set(mine.sort((a, b) => a.changedAt.localeCompare(b.changedAt)).slice(0, mine.length - 20).map((r) => r.id));
  for (let i = all.length - 1; i >= 0; i--) if (drop.has(all[i].id)) all.splice(i, 1);
}
