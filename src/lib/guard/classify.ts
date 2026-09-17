/* ------------------------------------------------------------------
   Side-effect classification of tools.

     READ_ONLY   — may run any number of times (search, list, get…)
     SIDE_EFFECT — mutates the outside world (send, create, update…)
     FINANCIAL   — moves money (purchase, refund, subscribe…)

   Resolution order: explicit override (owner / Capability Manager) →
   MCP tool annotations (readOnlyHint / destructiveHint) → name and
   description heuristics. A third-party tool that clearly looks mutating
   is never assumed safe; a tool that looks like a read stays read-only.
   ------------------------------------------------------------------ */

export type SideEffectClass = "READ_ONLY" | "SIDE_EFFECT" | "FINANCIAL";

export type ToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };

const FINANCIAL = /\b(purchase|buy|pay|payment|payout|refund|charge|checkout|subscribe|subscription|billing|invoice|transfer(?:_?funds)?|withdraw|deposit|topup|top_up|ad_?spend|spend|order)\b/i;
const MUTATING = /\b(send|create|update|delete|remove|post|publish|add|set|put|patch|insert|upload|move|archive|mark|reply|forward|write|edit|modify|rename|register|signup|sign_up|submit|schedule|cancel|revoke|grant|attach|detach|assign|enable|disable|start|stop|restart|deploy|trigger|run|execute|import|sync|merge|push|tag|label|flag|snooze|resolve|close|reopen|approve|reject|invite|accept|book|reserve|generate|reset|clear|purge|drop|truncate|kill|terminate|provision|install|uninstall|configure)\b/i;
const READ = /\b(get|list|search|read|fetch|find|query|describe|check|status|lookup|count|view|browse|show|retrieve|inspect|preview|export|download|verify|validate|test|ping|whoami|info|summar|analy|compare|diff|watch|tail|head|stat|exists|has_)/i;

function words(s: string): string {
  // camelCase / PascalCase / snake / kebab → space separated lowercase
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.:/]+/g, " ").toLowerCase();
}

/** Classify by tool name (+ description as a tie-breaker). */
export function classifyByHeuristic(name: string, description = ""): SideEffectClass {
  const n = words(name);
  if (FINANCIAL.test(n)) return "FINANCIAL";
  if (MUTATING.test(n)) return "SIDE_EFFECT";
  if (READ.test(n)) return "READ_ONLY";
  // name gave nothing: only a clearly mutating description flips it
  const d = words(description.slice(0, 300));
  if (FINANCIAL.test(d) && /\b(make|process|issue|perform)\b/.test(d)) return "FINANCIAL";
  if (/\b(sends?|creates?|updates?|deletes?|removes?|publishes?|posts?|writes?|modif|submits?|registers?)\b/.test(d) && !/\b(read[- ]?only|does not modify|no side effects?)\b/.test(d)) return "SIDE_EFFECT";
  return "READ_ONLY";
}

export function classifyTool(input: { name: string; description?: string; annotations?: ToolAnnotations | null; override?: SideEffectClass | null }): SideEffectClass {
  if (input.override) return input.override;
  const a = input.annotations;
  if (a) {
    if (a.readOnlyHint === true) return "READ_ONLY";
    if (a.readOnlyHint === false || a.destructiveHint === true) {
      const h = classifyByHeuristic(input.name, input.description);
      return h === "FINANCIAL" ? "FINANCIAL" : "SIDE_EFFECT";
    }
  }
  return classifyByHeuristic(input.name, input.description);
}

export function isSideEffecting(c: SideEffectClass): boolean {
  return c !== "READ_ONLY";
}
