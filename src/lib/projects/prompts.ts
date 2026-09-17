/* ------------------------------------------------------------------
   The Project Director engine's texts now live in the Prompt Registry
   (src/lib/prompts/defs/project.ts) so the owner can read and edit them
   in Settings → Prompts. What stays here is the engine's own tuning:
   how many review rounds a plan or a result gets.
   ------------------------------------------------------------------ */

export const MAX_REVIEW_ROUNDS = 2;
export const MAX_PLAN_REVIEW_ROUNDS = 3;

export { fill as render } from "@/lib/prompts";
