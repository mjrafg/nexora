/* ------------------------------------------------------------------
   What a project session's agents can actually reach.

   The invariant: an agent is never told it holds a capability it cannot
   invoke. A system prompt is assembled from the agent's tool permissions,
   so the tools attached to the turn and the permissions described in the
   prompt have to be decided together — which is what this does.

   Project turns used to receive no internal tool servers at all, while
   their prompt still listed every permission the owner had granted. An
   agent holding "browser" was told it could drive Nexora's Chromium and
   then found no such function in its runtime.
   ------------------------------------------------------------------ */

import type { AgentRecord } from "@/lib/runtime/types";
import type { InternalToolServer } from "@/lib/tools/internal";
import { serversForAgent } from "@/lib/tools/servers";
import { skillServers } from "@/lib/skills/deliver";
import { scopePermissions } from "./capability-scope";

export type TurnCapabilities = {
  /** internal tool servers to attach to this turn */
  servers: InternalToolServer[];
  /** exactly the permissions the prompt may describe */
  permissions: string[];
};

/**
 * Decide, together, what a session turn can reach and what its prompt says.
 *
 * A Builder keeps the permissions the owner gave it, plus anything the
 * Director granted this session. A Reviewer keeps only what it needs to look
 * at the work — it must be able to open a page to judge a UI, but it has no
 * business spending money or using company logins while reviewing.
 */
export function turnCapabilities(agent: AgentRecord, role: "builder" | "reviewer", granted: string[] = []): TurnCapabilities {
  const permissions = scopePermissions(agent.toolPermissions, role, granted);

  // servers are chosen from the SAME list the prompt will describe, so the two
  // cannot drift apart again
  const asAttached: AgentRecord = { ...agent, toolPermissions: permissions };
  const servers = serversForAgent(asAttached)
    // company task management is not project work: a build session should not
    // be opening or closing the company's tasks while it builds
    .filter((s) => s.slug !== "work")
    .concat(skillServers());

  return { servers, permissions };
}
