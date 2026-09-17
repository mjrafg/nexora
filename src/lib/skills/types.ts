/* ------------------------------------------------------------------
   Skills: instruction documents an agent can be given for one piece of
   work, and only for that piece of work.

   A skill is NOT a permission, NOT a tool, and NOT an orchestration
   engine. Reading one changes what an agent knows about how to work;
   it changes nothing about what it is allowed to do.
   ------------------------------------------------------------------ */

/** Which part of the work a skill is meant for — used to suggest, never to decide. */
export const SKILL_PHASES = ["planning", "build", "review", "repair"] as const;
export type SkillPhase = (typeof SKILL_PHASES)[number];

export type SkillSource = {
  repo: string;
  url: string;
  revision: string;
  path: string;
  license: string;
};

/** One document in the library, as Nexora holds it. */
export type SkillDef = {
  /** stable id — the same string the Director selects and an agent reads */
  id: string;
  name: string;
  /** upstream's own one-line description: what it is for, in its words */
  description: string;
  /** Nexora's note on when to reach for it, in the owner's words */
  use: string;
  phases: SkillPhase[];
  source: SkillSource;
  /** the upstream text, byte for byte */
  body: string;
  /** supporting documents this one cites, available through read_skill_reference */
  references: string[];
  /**
   * What Nexora says about using this document here — conflicts with the
   * engine, tools it assumes that an agent may not have. Delivered next to
   * the body, clearly separated, never merged into it.
   */
  adaptation?: string;
  /** off by default when using it would change an agent's responsibilities */
  defaultEnabled: boolean;
  /** why it ships disabled, when it does */
  disabledReason?: string;
};

/** A supporting document (a checklist) a skill can pull in. */
export type SkillReferenceDef = {
  id: string;
  name: string;
  source: SkillSource;
  body: string;
};

/** The owner's switch. Nothing else about a skill is owner-editable. */
export type SkillSetting = {
  skillId: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string;
};

export type SkillView = Omit<SkillDef, "body"> & {
  enabled: boolean;
  /** true when the owner changed it away from the shipped default */
  overridden: boolean;
  bytes: number;
  /** rough cost of delivering this body, for the owner's judgement */
  approxTokens: number;
  updatedAt?: string;
};

/**
 * What a session recorded when its skills were chosen: the ids, and the
 * library revision they were chosen from. Kept so an execution record can
 * answer "which guidance did this actually run with?".
 */
export type SkillSelection = {
  skillIds: string[];
  revision: string;
  chosenAt: string;
  /** "director" — who made the selection */
  chosenBy: string;
};

export type SkillDelivery = {
  skillId: string;
  revision: string;
  /** "brief" (rendered into the turn message) or "tool" (the agent read it) */
  via: "brief" | "tool";
  at: string;
  bytes: number;
};
