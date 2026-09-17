/**
 * Two-level turn budget for one agent turn (one tool call = one step).
 *
 * `warnAt` only tells the owner a task is long; `approveAt` is the ceiling at
 * which the turn stops and the owner is asked whether to continue, and
 * `grant` is what "continue" adds. Kept in its own module so both the runtime
 * and the tool runner can read it without importing each other.
 */
export const TURN_BUDGET = {
  warnAt: Number(process.env.NEXORA_TURN_WARN ?? 120),
  approveAt: Number(process.env.NEXORA_TURN_LIMIT ?? 200),
  grant: Number(process.env.NEXORA_TURN_GRANT ?? 200),
};
