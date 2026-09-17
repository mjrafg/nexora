/* ------------------------------------------------------------------
   What the Director may hand a session.

   An agent's toolPermissions are permanent and agent-global: granting
   one for a build would follow that agent into every other project it
   ever works on. So a Director's grant is scoped to the session — it
   applies to that session's turns, is recorded on its record, and is
   gone when the session ends.

   The ceiling is the owner's, not the Director's. A planning model may
   give a Builder what it needs to build; it may not give it money, the
   company's logins, or the ability to rewrite company data. An agent
   that genuinely needs those still goes through the Capability Manager,
   which asks a human.
   ------------------------------------------------------------------ */

import { readDb } from "@/lib/store/db";
import { TOOL_CATALOG } from "@/lib/runtime/catalog";
import type { ProjectRecord, SessionGrant } from "./types";

/** Set by the owner. Everything outside it is refused, with a reason. */
export const GRANTABLE = [
  "read_files",
  "write_files",
  "run_commands",
  "web_search",
  "web_fetch",
  "browser",
  "company_profile",
] as const;

/** Why a permission is not the Director's to give. */
const WHY_NOT: Record<string, string> = {
  payments: "spending is the owner's decision",
  payments_use: "spending is the owner's decision",
  payments_manage: "spending is the owner's decision",
  credentials: "company logins are the owner's decision",
  credentials_manage: "company logins are the owner's decision",
  company_profile_manage: "writing to company data is the owner's decision",
  company_custom_data_manage: "writing to company data is the owner's decision",
};

export type GrantOutcome = { grant: SessionGrant | null; refused: { id: string; why: string }[] };

/**
 * Decide a session's grant from what the Director asked for.
 *
 * Unknown ids and anything above the ceiling are refused individually and
 * reported back, rather than failing the plan: a bad ask is a mis-selection,
 * not a reason to lose a milestone's decomposition.
 */
export function resolveGrant(project: ProjectRecord, tools: string[] | undefined, servers: string[] | undefined): GrantOutcome {
  const refused: { id: string; why: string }[] = [];
  const keep: string[] = [];
  for (const raw of tools ?? []) {
    const id = String(raw).trim();
    if (!id) continue;
    if (keep.includes(id)) continue;
    if (!TOOL_CATALOG.some((t) => t.id === id)) { refused.push({ id, why: "no such permission" }); continue; }
    if (!(GRANTABLE as readonly string[]).includes(id)) {
      refused.push({ id, why: WHY_NOT[id] ?? "outside what a Director may grant" });
      continue;
    }
    keep.push(id);
  }

  // An MCP server may only be pointed at a session if the owner already
  // trusted it for someone on this project. The Director re-uses access that
  // exists; it never conjures new reach into an outside system.
  const db = readDb();
  const team = [project.directorAgentId, project.builderAgentId, project.reviewerAgentId];
  const alreadyTrusted = new Set(
    db.agents.filter((a) => team.includes(a.id)).flatMap((a) => (a.mcpGrants ?? []).map((g) => g.serverId))
  );
  const keepServers: string[] = [];
  for (const raw of servers ?? []) {
    const wanted = String(raw).trim();
    if (!wanted) continue;
    const srv = db.mcpServers.find((x) => x.id === wanted || x.slug === wanted || x.name === wanted);
    if (!srv) { refused.push({ id: wanted, why: "no such tool server" }); continue; }
    if (!alreadyTrusted.has(srv.id)) {
      refused.push({ id: srv.name, why: "nobody on this project has been given that server — ask the owner through the Capability Manager" });
      continue;
    }
    if (!keepServers.includes(srv.id)) keepServers.push(srv.id);
  }

  if (!keep.length && !keepServers.length) return { grant: null, refused };
  return {
    grant: { tools: keep, servers: keepServers, grantedAt: new Date().toISOString(), grantedBy: "director" },
    refused,
  };
}

/** The permissions a session's turns actually run with. */
export function effectivePermissions(base: string[], grant: SessionGrant | null | undefined): string[] {
  if (!grant?.tools.length) return base;
  return [...new Set([...base, ...grant.tools])];
}
