/* ------------------------------------------------------------------
   The shapes the Prompt Registry works in.

   A prompt is a piece of static instruction text Nexora composes into a
   system prompt or sends to an agent as a system message. Its built-in
   text lives in source control; the owner's edit lives in Nexora's data;
   the resolver picks between them. Nothing else in the codebase decides
   which one to use.
   ------------------------------------------------------------------ */

export const PROMPT_CATEGORIES = [
  "executive",
  "management",
  "task",
  "engineering",
  "capability",
  "browser",
  "credentials",
  "payments",
  "company",
  "runtime",
  "project",
  "other",
] as const;

export type PromptCategory = (typeof PROMPT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<PromptCategory, string> = {
  executive: "Executive",
  management: "Management",
  task: "Task execution",
  engineering: "Engineering",
  capability: "Capability Manager",
  browser: "Browser",
  credentials: "Credentials",
  payments: "Payments",
  company: "Company",
  runtime: "Runtime & safety",
  project: "Project engine",
  other: "Other",
};

/** A built-in prompt, as declared in source. */
export type PromptDef = {
  /** stable, never derived from the display name */
  id: string;
  name: string;
  description: string;
  category: PromptCategory;
  /** bumped whenever the built-in text changes, so a customization can be told it is behind */
  version: number;
  /** {{placeholders}} Nexora fills with runtime values — not owner-editable data */
  placeholders?: string[];
  /** where this text ends up, in the owner's words */
  usedBy?: string[];
  /** the product cannot run without it: an empty customization is refused */
  required?: boolean;
  defaultContent: string;
};

/** The owner's replacement for one prompt. Absent means "use the built-in". */
export type PromptOverride = {
  promptId: string;
  content: string;
  /** the built-in version the owner started from */
  baseVersion: number;
  updatedAt: string;
  updatedBy: string;
  source: "MANUAL" | "IMPORT";
};

export type PromptRevisionSource = "MANUAL" | "IMPORT" | "RESET";

/** One step in a prompt's history, enough to put an earlier text back. */
export type PromptRevision = {
  id: string;
  promptId: string;
  /** what the prompt resolved to AFTER this change; null means it went back to the built-in */
  content: string | null;
  baseVersion: number;
  changedAt: string;
  changedBy: string;
  source: PromptRevisionSource;
};

/** A prompt as the owner sees it: the definition plus what it actually resolves to. */
export type PromptView = PromptDef & {
  /** what the runtime uses right now */
  content: string;
  customized: boolean;
  customContent?: string;
  /** the built-in version the customization was made from */
  overrideBaseVersion?: number;
  /** customized, and the built-in has moved on since */
  updateAvailable: boolean;
  lastModifiedAt?: string;
  lastModifiedBy?: string;
  lastModifiedSource?: PromptOverride["source"];
  revisions: number;
  status: "built-in" | "customized";
};

/* ---------------------------------------------------------------- transfer */

export const EXPORT_FORMAT = "nexora-prompts";
export const EXPORT_VERSION = 1;

export type PromptExportEntry = {
  id: string;
  name: string;
  description: string;
  category: PromptCategory;
  built_in_version: number;
  customized: boolean;
  content: string;
};

export type PromptExport = {
  format: typeof EXPORT_FORMAT;
  version: number;
  exported_at: string;
  prompts: PromptExportEntry[];
};

export type ImportVerdict = "update" | "unchanged" | "unknown" | "invalid" | "conflict";

export type ImportEntry = {
  id: string;
  name: string;
  verdict: ImportVerdict;
  /** why it cannot be applied, when it cannot */
  problem?: string;
  current: string;
  incoming: string;
  currentIsCustom: boolean;
  /** the built-in version the file was exported from, when it says */
  fileVersion?: number;
  builtInVersion?: number;
};

export type ImportPreview = {
  ok: boolean;
  error?: string;
  exportedAt?: string;
  counts: { total: number; update: number; unchanged: number; unknown: number; invalid: number; conflict: number };
  entries: ImportEntry[];
};
