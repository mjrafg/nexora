/* ------------------------------------------------------------------
   Text direction for user- and model-written text.

   Agents answer in the language they are addressed in, so a reply can be
   Persian, Arabic or Hebrew with English technical terms mixed in. The
   browser's own `dir="auto"` only looks at the first strong character,
   which flips a whole Persian answer to left-to-right as soon as it
   happens to start with a Latin word. We look at the balance of strong
   characters instead, and let each block fall back to `dir="auto"`.
   ------------------------------------------------------------------ */

/** Arabic, Hebrew, Syriac, Thaana, NKo, Samaritan + their supplements and presentation forms. */
const RTL = /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿߀-߿ࠀ-࠿ࢠ-ࣿיִ-﷿ﹰ-﻿]/g;
/** Latin, Greek, Cyrillic, Armenian + Latin supplements — the strong left-to-right letters we care about. */
const LTR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ԰-֏]/g;

/** Text that should not sway the decision: code spans, fenced blocks, URLs. */
function stripTechnical(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, " ");
}

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

/**
 * "rtl" when the prose is written in a right-to-left script. A fifth of the
 * letters is enough: right-to-left answers routinely carry English product
 * names, tool names and code identifiers that would otherwise outvote them.
 */
export function textDirection(text: string | null | undefined): "rtl" | "ltr" {
  if (!text) return "ltr";
  const prose = stripTechnical(text);
  const rtl = count(prose, RTL);
  if (!rtl) return "ltr";
  const ltr = count(prose, LTR);
  return rtl / (rtl + ltr) >= 0.2 ? "rtl" : "ltr";
}

export const isRtl = (text: string | null | undefined) => textDirection(text) === "rtl";
