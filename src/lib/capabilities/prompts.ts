/* ------------------------------------------------------------------
   The Capability Manager's texts now live in the Prompt Registry
   (src/lib/prompts/defs/capability.ts) so the owner can read and edit
   them in Settings → Prompts. What is left here is the substitution
   these particular texts use: single braces, {like_this}.
   ------------------------------------------------------------------ */

export function render(template: string, vars: Record<string, string | number | undefined | null>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ""));
}
