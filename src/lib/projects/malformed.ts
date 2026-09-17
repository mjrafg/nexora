/* ------------------------------------------------------------------
   Recognising a tool call whose arguments did not survive the trip.

   Import-free so it can be checked directly against the real payload
   that caused a run to stall.
   ------------------------------------------------------------------ */

/*
 * A tool call whose arguments arrived mangled, and the one useful thing to say
 * about it.
 *
 * A Director once emitted a literal `<parameter name="sessions">` tag inside
 * the JSON string value of `reasoning`, so `sessions` never existed as a key.
 * The engine answered "Provide at least one session." — true, and useless: it
 * described the symptom rather than the malformed encoding. Nine attempts
 * later the run stalled and the owner was asked for help.
 *
 * Nothing here tries to rescue the arguments. Guessing at the intent of a
 * broken call is how a plan ends up containing something nobody wrote. It
 * only says precisely what went wrong, so the next attempt can be right.
 */
export function swallowedParameter(args: Record<string, unknown>): { field: string; param: string } | null {
  for (const [field, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const m = value.match(/<\s*parameter\s+name\s*=\s*["']?([\w.-]+)/i) ?? value.match(/<\/\s*parameter\s*>/i);
    if (m) return { field, param: m[1] ?? "another argument" };
  }
  return null;
}
