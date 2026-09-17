/* ------------------------------------------------------------------
   Which guidance actually reached a model, and how.

   Selection says what was chosen; this says what was delivered. The two
   are different often enough to be worth recording separately: a skill
   can be selected and never read, or read on the agent's own initiative
   without having been selected at all.
   ------------------------------------------------------------------ */

import { now, readDb, updateDb } from "@/lib/store/db";
import type { SkillDelivery } from "./types";

export type SkillDeliveryRecord = SkillDelivery & { scopeId: string; agentId: string };

export function recordDelivery(rec: Omit<SkillDeliveryRecord, "at">): void {
  updateDb((d) => {
    d.skillDeliveries ??= [];
    d.skillDeliveries.push({ ...rec, at: now() });
    if (d.skillDeliveries.length > 2_000) d.skillDeliveries.splice(0, d.skillDeliveries.length - 2_000);
  });
}

export function deliveriesFor(scopeId: string): SkillDeliveryRecord[] {
  return (readDb().skillDeliveries ?? []).filter((r) => r.scopeId === scopeId);
}

/** Everything delivered under a project, whatever the session or round. */
export function deliveriesUnder(prefix: string): SkillDeliveryRecord[] {
  return (readDb().skillDeliveries ?? []).filter((r) => r.scopeId.startsWith(prefix));
}
