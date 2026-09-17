/* ------------------------------------------------------------------
   Which internal tool servers a given agent gets on every turn.
   Importing this module registers all servers (side effect).
   ------------------------------------------------------------------ */

import type { AgentRecord } from "@/lib/runtime/types";
import { agentHasBrowser, browserToolServer } from "@/lib/browser";
import { capabilityManagerToolServer, nexoraToolServer } from "@/lib/capabilities/tools";
import { paymentsToolServer } from "@/lib/payments/tools";
import { credentialsToolServer } from "@/lib/credentials/tools";
import { companyToolServer, COMPANY_MANAGE_PERMISSION, COMPANY_PERMISSION, CUSTOM_DATA_MANAGE_PERMISSION } from "@/lib/company/tools";
import { ownerActionToolServer } from "@/lib/owner-actions/tools";
import { tasksToolServer } from "@/lib/tasks/tools";
// registration only: the skills server is handed to project turns explicitly
// (Director, Builder, Reviewer) and is deliberately NOT in serversForAgent —
// no company agent gets skill tools by simply existing.
import "@/lib/skills/tools";
import type { InternalToolServer } from "./internal";

export function serversForAgent(agent: AgentRecord): InternalToolServer[] {
  // every agent can ask the owner for something a human must supply, and every
  // agent holds company work (managers also get the management tools)
  const out: InternalToolServer[] = [ownerActionToolServer, tasksToolServer];
  if (agentHasBrowser(agent)) out.push(browserToolServer);
  if (["payments", "payments_use", "payments_manage"].some((p) => agent.toolPermissions.includes(p))) out.push(paymentsToolServer);
  if (agent.toolPermissions.includes("credentials") || agent.toolPermissions.includes("credentials_manage")) out.push(credentialsToolServer);
  if ([COMPANY_PERMISSION, COMPANY_MANAGE_PERMISSION, CUSTOM_DATA_MANAGE_PERMISSION].some((p) => agent.toolPermissions.includes(p)) || agent.system === "capability-manager") out.push(companyToolServer);
  if (agent.system === "capability-manager") out.push(capabilityManagerToolServer);
  else out.push(nexoraToolServer);
  return out;
}
