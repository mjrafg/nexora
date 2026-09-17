/* ------------------------------------------------------------------
   The skill library.

   Imported documents live in source control (imported.ts, generated and
   pinned to one upstream commit). What the owner controls is a single
   switch per skill: available or not. There is deliberately no editor
   here — Nexora's own instruction text is edited in Settings → Prompts,
   and an imported document is something you read and trust, or turn
   off. Two editable copies of the same paragraph is exactly the
   confusion this boundary exists to avoid.
   ------------------------------------------------------------------ */

import { now, readDb, updateDb } from "@/lib/store/db";
import { IMPORTED_REFERENCES, IMPORTED_SKILLS, SKILL_SOURCE } from "./imported";
import type { SkillDef, SkillPhase, SkillReferenceDef, SkillSetting, SkillView } from "./types";

export const LIBRARY_REVISION = SKILL_SOURCE.revision;

const sourceFor = (path: string) => ({
  repo: SKILL_SOURCE.repo,
  url: `${SKILL_SOURCE.url}/blob/${SKILL_SOURCE.revision}/${path}`,
  revision: SKILL_SOURCE.revision,
  path,
  license: SKILL_SOURCE.license,
});

const imported = (id: string) => {
  const doc = IMPORTED_SKILLS.find((s) => s.id === id);
  if (!doc) throw new Error(`skill "${id}" is not in the imported set`);
  return doc;
};

/**
 * Nexora's view of each imported document: when to use it here, which phase
 * it belongs to, and what it gets wrong about this product.
 */
const CATALOG: Omit<SkillDef, "body" | "description" | "name">[] = [
  {
    id: "debugging-and-error-recovery",
    use: "A build broke, a test fails, or behaviour does not match what was asked. Systematic root-cause work instead of guessing.",
    phases: ["build", "repair"],
    source: sourceFor("skills/debugging-and-error-recovery/SKILL.md"),
    references: [],
    defaultEnabled: true,
  },
  {
    id: "frontend-ui-engineering",
    use: "The session builds or changes something a person looks at: components, layout, state, accessibility, responsive behaviour.",
    phases: ["build", "repair"],
    source: sourceFor("skills/frontend-ui-engineering/SKILL.md"),
    references: ["accessibility-checklist", "performance-checklist"],
    defaultEnabled: true,
    adaptation:
      "This document assumes a browser/DevTools integration for visual checking. A Nexora Builder has Read, Glob, Grep, Write, Edit, Bash, WebSearch and WebFetch — no browser. Use it for what it says about structure, accessibility and state; where it asks you to look at a rendered page, say plainly in your result that you could not, rather than claiming you did.",
  },
  {
    id: "code-review-and-quality",
    use: "A Reviewer judging a change: what to look at first, and what not to waste a round on.",
    phases: ["review"],
    source: sourceFor("skills/code-review-and-quality/SKILL.md"),
    references: [],
    defaultEnabled: true,
    adaptation:
      "Nexora's review contract wins over this document's format. Your reply MUST still begin with exactly PASS or FINDINGS, and each finding MUST be `N. [major|minor] <title> — <file>:<line>` — Nexora parses it. Ignore the upstream severity words (Critical:, Nit:, Optional:, FYI): map anything merge-blocking to [major] and anything optional to [minor], or leave it out. The review limit is two rounds and the final repair is never re-reviewed; do not ask for more rounds, and do not propose a different review process. Use the document for its axes and its judgement about what matters, not for its output shape.",
  },
  {
    id: "test-driven-development",
    use: "Red-green-refactor: prove a bug with a failing test before fixing it, and leave the proof behind.",
    phases: ["build", "repair"],
    source: sourceFor("skills/test-driven-development/SKILL.md"),
    references: ["testing-patterns"],
    defaultEnabled: false,
    disabledReason:
      "Nexora does not currently tell anyone to write tests: neither the Builder brief nor the Reviewer contract mentions them, and the Reviewer is read-only. Turning this on makes writing and running tests part of every Builder session it is selected for — a real change to what a Builder is responsible for, and an owner's decision rather than an import's.",
    adaptation:
      "The Builder writes and runs the tests; the Reviewer inspects and never runs anything. This document's browser/DevTools verification and its subagent suggestions do not apply — a Nexora session has neither.",
  },
];

export function skillDefs(): SkillDef[] {
  return CATALOG.map((meta) => {
    const doc = imported(meta.id);
    return { ...meta, name: doc.name, description: doc.description, body: doc.body };
  });
}

export function skillDef(id: string): SkillDef | undefined {
  return skillDefs().find((s) => s.id === id);
}

/* ---------------------------------------------------------------- the owner's switch */

function settings(): SkillSetting[] {
  return readDb().skillSettings ?? [];
}

export function isEnabled(id: string): boolean {
  const def = skillDef(id);
  if (!def) return false;
  return settings().find((s) => s.skillId === id)?.enabled ?? def.defaultEnabled;
}

export function setSkillEnabled(id: string, enabled: boolean, by = "owner"): SkillView {
  const def = skillDef(id);
  if (!def) throw new Error(`No skill with id "${id}".`);
  updateDb((d) => {
    d.skillSettings ??= [];
    const existing = d.skillSettings.find((s) => s.skillId === id);
    const record: SkillSetting = { skillId: id, enabled, updatedAt: now(), updatedBy: by };
    if (existing) Object.assign(existing, record);
    else d.skillSettings.push(record);
  });
  return skillView(def);
}

/* ---------------------------------------------------------------- views */

/** Rough enough for the owner to judge what a body costs to deliver. */
const approxTokens = (text: string) => Math.round(text.length / 4);

export function skillView(def: SkillDef): SkillView {
  const setting = settings().find((s) => s.skillId === def.id);
  const { body, ...rest } = def;
  return {
    ...rest,
    enabled: setting?.enabled ?? def.defaultEnabled,
    overridden: !!setting && setting.enabled !== def.defaultEnabled,
    bytes: body.length,
    approxTokens: approxTokens(body),
    updatedAt: setting?.updatedAt,
  };
}

export function skillViews(): SkillView[] {
  return skillDefs().map(skillView);
}

/** Only what an agent may be given: available skills, no bodies. */
export function availableSkills(phase?: SkillPhase): SkillView[] {
  return skillViews().filter((s) => s.enabled && (!phase || s.phases.includes(phase)));
}

/* ---------------------------------------------------------------- references */

export function skillReference(id: string): SkillReferenceDef | undefined {
  const doc = IMPORTED_REFERENCES.find((r) => r.id === id);
  if (!doc) return undefined;
  return { id: doc.id, name: doc.name, source: sourceFor(doc.path), body: doc.body };
}

/** A reference is readable only through a skill that actually cites it. */
export function referenceIsReachable(referenceId: string): boolean {
  return skillDefs().some((s) => isEnabled(s.id) && s.references.includes(referenceId));
}

export { SKILL_SOURCE };
