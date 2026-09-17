/* ------------------------------------------------------------------
   Putting selected skills in front of the agent that needs them.

   Delivery is by MESSAGE, never by system prompt. A CLI session that is
   resumed keeps the system prompt it started with — whether a changed
   one is applied on `--resume` is not something Nexora can currently
   verify — but the message of a turn always reaches the model, on every
   runtime, fresh or resumed. So that is the path used.

   A body is sent once per conversation. When findings come back, the
   Builder is reminded by name that the skills still apply and can call
   read_skill; sending 20KB of the same document again would buy nothing
   and cost a great deal.
   ------------------------------------------------------------------ */

import { availableSkills, LIBRARY_REVISION, isEnabled, skillDef } from "./library";
import { recordDelivery } from "./deliveries";
import { renderSkill, skillsToolServer } from "./tools";
import type { InternalToolServer } from "@/lib/tools/internal";
import { renderPrompt } from "@/lib/prompts";
import type { SkillSelection } from "./types";

/** Ids that are still selectable: chosen, known, and still available. */
function usable(sel: SkillSelection | null | undefined): string[] {
  return (sel?.skillIds ?? []).filter((id) => skillDef(id) && isEnabled(id));
}

export function selectedNames(sel: SkillSelection | null | undefined): string[] {
  return usable(sel).map((id) => skillDef(id)!.name);
}

/**
 * The block that precedes a Builder's brief or a Reviewer's request.
 * Returns null when nothing was selected — a session with no skills is
 * assembled exactly as it was before this feature existed.
 */
export function skillBlock(sel: SkillSelection | null | undefined, ctx: { scopeId: string; agentId: string }): string | null {
  const ids = usable(sel);
  if (!ids.length) return null;
  const bodies: string[] = [];
  for (const id of ids) {
    const def = skillDef(id)!;
    const rendered = renderSkill(id)!;
    // a document that has moved on since it was chosen says so rather than
    // quietly being a different text than the one the plan recorded
    const moved = sel!.revision && sel!.revision !== LIBRARY_REVISION
      ? `\n(Note: this was selected from library revision ${sel!.revision.slice(0, 7)}; you are reading ${LIBRARY_REVISION.slice(0, 7)}.)\n`
      : "";
    bodies.push(`${moved}${rendered}`);
    recordDelivery({ scopeId: ctx.scopeId, agentId: ctx.agentId, skillId: id, revision: LIBRARY_REVISION, via: "brief", bytes: def.body.length });
  }
  return renderPrompt("skills-selected-block", {
    count: ids.length,
    names: ids.map((id) => skillDef(id)!.name).join(", "),
    skills: bodies.join("\n\n"),
  });
}

/** One line for a repair turn: the documents are already in this session. */
export function skillReminder(sel: SkillSelection | null | undefined): string | null {
  const names = selectedNames(sel);
  if (!names.length) return null;
  return renderPrompt("skills-repair-reminder", { names: names.join(", ") });
}

/**
 * The skills tool server, when there is anything to reach for. With every
 * skill turned off it is absent, so a company that does not use this feature
 * runs turns exactly as it did before the library existed — no extra tool
 * definitions, nothing to explain away.
 */
export function skillServers(): InternalToolServer[] {
  return availableSkills().length ? [skillsToolServer] : [];
}

/** The compact catalog the Director carries: ids and one line each, no bodies. */
export function catalogLines(): string {
  const list = availableSkills();
  if (!list.length) return "(none — the owner has turned every skill off in Settings → Skills)";
  return list
    .map((s) => `- ${s.id} — ${s.use} [${s.phases.join("/")}${s.adaptation ? ", Nexora-adapted" : ""}, ~${s.approxTokens} tokens]`)
    .join("\n");
}
