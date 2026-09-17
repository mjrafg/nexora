/* ------------------------------------------------------------------
   Waking someone with news about work.

   Two outcomes arriving a second apart are one thing to react to, not
   two — a manager whose three reports all finish at once should read one
   message and answer once, not burn three turns saying the same thing.
   So news is held for a moment, merged per conversation, and then
   delivered. sendAgentMessage already serialises turns per agent, so a
   busy agent is never interrupted: its news waits its turn.
   ------------------------------------------------------------------ */

import { renderPrompt } from "@/lib/prompts";

export type Wake = {
  agentId: string;
  /** the execution scope the wake belongs to (the task being resumed) */
  scopeId: string;
  /** the conversation it lands in; without one the scope decides */
  chatId?: string;
  text: string;
};

/** How long news is held so that closely spaced updates arrive together. */
const WINDOW_MS = Number(process.env.NEXORA_WAKE_WINDOW_MS ?? 1_200);

type Slot = { items: Wake[]; timer: NodeJS.Timeout };
const pending = new Map<string, Slot>();

const keyOf = (w: Wake) => `${w.agentId}|${w.scopeId}|${w.chatId ?? ""}`;

export function wakeAgent(w: Wake): void {
  const key = keyOf(w);
  const slot = pending.get(key);
  if (slot) { slot.items.push(w); return; }
  const timer = setTimeout(() => void flush(key), WINDOW_MS);
  timer.unref?.();
  pending.set(key, { items: [w], timer });
}

async function flush(key: string): Promise<void> {
  const slot = pending.get(key);
  if (!slot) return;
  pending.delete(key);
  const head = slot.items[0];
  const text =
    slot.items.length === 1
      ? head.text
      : [
          renderPrompt("several-updates-at-once", { count: slot.items.length }),
          ``,
          ...slot.items.map((w, i) => `--- update ${i + 1} of ${slot.items.length} ---\n${w.text}`),
        ].join("\n");
  try {
    const { sendAgentMessage } = await import("@/lib/runtime");
    await sendAgentMessage(head.agentId, text, { origin: "system", scopeId: head.scopeId, chatId: head.chatId });
  } catch (err) {
    console.error("[tasks] wake failed:", err);
  }
}

/** Deliver everything held right now — used by tests that cannot wait. */
export async function flushWakes(): Promise<void> {
  const keys = [...pending.keys()];
  for (const k of keys) {
    clearTimeout(pending.get(k)!.timer);
    await flush(k);
  }
}
