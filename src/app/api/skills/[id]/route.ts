export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { skillDef, skillView, setSkillEnabled } from "@/lib/skills/library";
import { renderSkill } from "@/lib/skills/tools";
import { SKILL_SOURCE } from "@/lib/skills/imported";

/** One skill exactly as an agent receives it — the owner reads the same text the model does. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const def = skillDef(id);
  if (!def) return NextResponse.json({ error: "Unknown skill." }, { status: 404 });
  return NextResponse.json({ skill: skillView(def), delivered: renderSkill(def.id), license: SKILL_SOURCE.licenseText });
}

/** The single owner control: available here, or not. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!skillDef(id)) return NextResponse.json({ error: "Unknown skill." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled must be true or false." }, { status: 400 });
  return NextResponse.json({ skill: setSkillEnabled(id, body.enabled) });
}
