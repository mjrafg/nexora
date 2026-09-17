/* ------------------------------------------------------------------
   Which of an agent's permissions survive into a project turn.

   Import-free so the rule can be checked directly: it is what decided
   that a Reviewer asked to run `npm test` would be handed Read, Glob
   and Grep.
   ------------------------------------------------------------------ */

/*
 * What a Reviewer keeps: it looks, it does not act.
 *
 * `read_files` is here because the runtime's "reader" profile hands the
 * Reviewer Read/Glob/Grep whatever its permissions say — describing it is
 * honest, and omitting it would tell a Reviewer it cannot read the code it
 * was asked to judge. `browser` is here because a Reviewer cannot judge an
 * interface it is not allowed to look at.
 *
 * `run_commands` is here because a Reviewer is routinely asked to judge work
 * whose definition of done is a command: `npm run build`, `npm test`, a type
 * check. Withholding it did not make the review read-only — it made the review
 * impossible, and the Reviewer said so: "I have no command-execution tool in
 * this session (Read/Glob/Grep/browser only), so I could not run `npm install`,
 * `npm run build` or `npm test` myself. What I have is second-hand."
 *
 * It is not a blanket grant. The Reviewer still holds it only if the owner gave
 * it to that agent or the Director granted it to this session, and it still
 * cannot write files — so it can run the project's checks without being able to
 * edit its way to a pass.
 *
 * Everything else — spending, company logins, writing to company data — is
 * withheld for the length of the review, whatever the agent holds elsewhere.
 */
export const REVIEWER_KEEPS = new Set(["read_files", "browser", "run_commands"]);

/** Permissions that have no meaning inside a build session. */
export const NOT_IN_A_SESSION = new Set<string>(["send_email", "crm"]);


/** The permissions a turn may use — and therefore the only ones its prompt may describe. */
export function scopePermissions(held: string[], role: "builder" | "reviewer", granted: string[] = []): string[] {
  const all = [...new Set([...held, ...granted])].filter((p) => !NOT_IN_A_SESSION.has(p));
  return role === "reviewer" ? all.filter((p) => REVIEWER_KEEPS.has(p)) : all;
}
