export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { SKILL_SOURCE } from "@/lib/skills/imported";
import { skillViews } from "@/lib/skills/library";
import { readDb } from "@/lib/store/db";

/** The library the owner can see: every document, whether it is available, and where it came from. */
export async function GET() {
  const db = readDb();
  const skills = skillViews();
  // a delivery record names a scope and an agent by id; the owner needs the
  // project, the session and the person — that is what "which skills did this
  // piece of work use?" actually means
  const sessions = new Map(db.projectSessions.map((s) => [s.id, s]));
  const projects = new Map(db.projects.map((p) => [p.id, p]));
  const agents = new Map(db.agents.map((a) => [a.id, a.name]));
  const where = (scopeId: string): string => {
    const m = /^session:([^:]+)(?::review:(\d+))?/.exec(scopeId);
    const session = m && sessions.get(m[1]);
    if (!session) return scopeId;
    const project = projects.get(session.projectId);
    return `${project ? `${project.title} · ` : ""}${session.key} ${session.name}${m![2] ? ` · review round ${m![2]}` : ""}`;
  };
  const deliveries = (db.skillDeliveries ?? []).slice(-200).reverse().map((d) => ({
    ...d,
    where: where(d.scopeId),
    agentName: agents.get(d.agentId) ?? d.agentId,
    skillName: skills.find((s) => s.id === d.skillId)?.name ?? d.skillId,
  }));
  return NextResponse.json({
    skills,
    source: { repo: SKILL_SOURCE.repo, url: SKILL_SOURCE.url, revision: SKILL_SOURCE.revision, importedAt: SKILL_SOURCE.importedAt, license: SKILL_SOURCE.license },
    counts: {
      all: skills.length,
      available: skills.filter((s) => s.enabled).length,
      adapted: skills.filter((s) => s.adaptation).length,
      tokens: skills.filter((s) => s.enabled).reduce((n, s) => n + s.approxTokens, 0),
    },
    deliveries,
  });
}
