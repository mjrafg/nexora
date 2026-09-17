/* ------------------------------------------------------------------
   Reading skills.

   Two tools and a third for the documents a skill cites. They return
   text and nothing else: no permission, no tool, no file access comes
   with them. An agent that reads the security skill is exactly as
   sandboxed afterwards as it was before.
   ------------------------------------------------------------------ */

import { registerToolServer, type InternalToolDef, type InternalToolServer, type ToolCallContext } from "@/lib/tools/internal";
import { availableSkills, isEnabled, referenceIsReachable, skillDef, skillReference, LIBRARY_REVISION } from "./library";
import { recordDelivery } from "./deliveries";
import { SKILL_PHASES, type SkillPhase } from "./types";

const ok = (text: string) => ({ ok: true, text });
const fail = (text: string) => ({ ok: false, text });
const s = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const TOOLS: InternalToolDef[] = [
  {
    name: "list_skills",
    description:
      "The engineering skills available for this work: id, what each is for, and which part of the work it suits. Descriptions only — call read_skill for the instructions themselves. Use it when you are deciding how to approach something, or when what you were given does not cover what you have run into.",
    inputSchema: {
      type: "object",
      properties: { phase: { type: "string", description: `Narrow the list to skills usually reached for in one part of the work: ${SKILL_PHASES.join(" | ")}. This is a filter on the listing, not a restriction: any skill may be given to any role when the work calls for it. Omit for everything available.` } },
    },
  },
  {
    name: "read_skill",
    description:
      "The full instructions of one skill, by its exact id from list_skills. Read a skill when you are about to do the kind of work it covers — not to browse. Where Nexora's own rules differ from the document, the note at the top of the reply is what applies here.",
    inputSchema: { type: "object", properties: { skill_id: { type: "string" } }, required: ["skill_id"] },
  },
  {
    name: "read_skill_reference",
    description:
      "One supporting document (a checklist) that a skill cites, by its id. Only the references of skills available to you can be read.",
    inputSchema: { type: "object", properties: { reference_id: { type: "string" } }, required: ["reference_id"] },
  },
];

export const skillsToolServer: InternalToolServer = registerToolServer({
  slug: "skills",
  name: "Skills",
  tools: TOOLS,

  async call(tool: string, args: Record<string, unknown>, ctx: ToolCallContext) {
    switch (tool) {
      case "list_skills": {
        const phase = s(args.phase, 20).toLowerCase();
        if (phase && !SKILL_PHASES.includes(phase as SkillPhase)) return fail(`Unknown phase "${phase}". Use one of: ${SKILL_PHASES.join(", ")}.`);
        const list = availableSkills(phase ? (phase as SkillPhase) : undefined);
        if (!list.length) return ok(JSON.stringify({ skills: [], note: "No skills are available. The owner controls this in Settings → Skills." }, null, 1));
        return ok(JSON.stringify({
          library_revision: LIBRARY_REVISION,
          note: "\"phases\" says where a skill usually earns its keep. It is guidance, not a restriction — a Reviewer judging a UI may legitimately be given the UI skill.",
          skills: list.map((x) => ({
            skill_id: x.id,
            name: x.name,
            what_it_is_for: x.description,
            use_it_when: x.use,
            phases: x.phases,
            approx_tokens_to_read: x.approxTokens,
            ...(x.references.length ? { references: x.references } : {}),
            ...(x.adaptation ? { nexora_note: "Nexora adapts this one — read_skill shows how." } : {}),
            source: `${x.source.repo}@${x.source.revision.slice(0, 7)}`,
          })),
        }, null, 1));
      }

      case "read_skill": {
        const id = s(args.skill_id, 80);
        if (!id) return fail("skill_id is required — take it from list_skills.");
        const def = skillDef(id);
        if (!def) return fail(`No skill with id "${id}". Call list_skills for the exact ids.`);
        if (!isEnabled(id)) return fail(`"${def.name}" is not available in this company. The owner controls that in Settings → Skills.`);
        recordDelivery({ scopeId: ctx.scopeId ?? `turn:${ctx.turnId}`, agentId: ctx.agentId, skillId: def.id, revision: def.source.revision, via: "tool", bytes: def.body.length });
        return ok(renderSkill(def.id)!);
      }

      case "read_skill_reference": {
        const id = s(args.reference_id, 80);
        if (!id) return fail("reference_id is required.");
        const ref = skillReference(id);
        if (!ref) return fail(`No reference document with id "${id}". The skills you can read list their own references.`);
        if (!referenceIsReachable(id)) return fail(`"${ref.name}" belongs to a skill that is not available here.`);
        recordDelivery({ scopeId: ctx.scopeId ?? `turn:${ctx.turnId}`, agentId: ctx.agentId, skillId: `reference:${id}`, revision: ref.source.revision, via: "tool", bytes: ref.body.length });
        return ok([
          `# Reference: ${ref.name}`,
          `Source: ${ref.source.repo} · ${ref.source.path} @ ${ref.source.revision.slice(0, 7)} · ${ref.source.license}`,
          ``,
          ref.body,
        ].join("\n"));
      }

      default:
        return fail(`Unknown skills tool: ${tool}`);
    }
  },
});

/**
 * One skill as an agent receives it: where it came from, what Nexora says
 * about using it here, then the upstream text unchanged. The note comes
 * first on purpose — by the time a conflict matters, it has been read.
 */
export function renderSkill(id: string): string | null {
  const def = skillDef(id);
  if (!def) return null;
  const head = [
    `# Skill: ${def.name}`,
    `id: ${def.id} · source: ${def.source.repo} · ${def.source.path} @ ${def.source.revision.slice(0, 7)} · ${def.source.license}`,
  ];
  if (def.adaptation) head.push(``, `## How this applies in Nexora (Nexora's note, not the source's)`, def.adaptation);
  if (def.references.length) head.push(``, `Supporting documents you can read with read_skill_reference: ${def.references.join(", ")}.`);
  head.push(``, `## The document, as published`, ``, ``);
  // the document follows verbatim; everything above it is Nexora's framing
  return head.join("\n") + def.body;
}
