/* ------------------------------------------------------------------
   Owner notifications.

   One row per owner action state, deduplicated by content hash so an
   unchanged action never announces itself twice. Delivery is in-app
   first (the badge, the live stream and the Needs You page), plus an
   optional outbound webhook for real push — the browser's own
   Notification API is driven from the client off the same stream.
   ------------------------------------------------------------------ */

import { emitActivity } from "@/lib/activity";
import { newId, now, readDb, updateDb } from "@/lib/store/db";
import { actionHash, OWNER_ACTIONS_CHANNEL, patchMeta, patchOwnerAction } from "./store";
import type { OwnerAction, OwnerNotification } from "./types";

const MAX = 500;

export function listNotifications(limit = 50): OwnerNotification[] {
  return readDb().ownerNotifications.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export const unreadCount = () => readDb().ownerNotifications.filter((n) => n.state === "unread").length;

export function markNotificationRead(id: string): void {
  updateDb((d) => {
    const n = d.ownerNotifications.find((x) => x.id === id);
    if (n && n.state === "unread") { n.state = "read"; n.readAt = now(); }
  });
}

export function markAllRead(): void {
  updateDb((d) => { for (const n of d.ownerNotifications) if (n.state === "unread") { n.state = "read"; n.readAt = now(); } });
}

/** What the owner is told — never a secret, always one tap from the action itself. */
function text(a: OwnerAction): { title: string; body: string } {
  switch (a.kind) {
    case "payment": return { title: `${a.agentName} needs a payment approved`, body: a.title.replace(/^Approve /, "") };
    case "capability": return { title: `${a.agentName} needs a purchase approved`, body: a.title.replace(/^Approve /, "") };
    case "credential": return { title: `${a.agentName} needs a login`, body: a.title.replace(/^Login needed: /, "") };
    case "captcha":
    case "browser": return { title: `${a.agentName} needs human verification`, body: a.reason.slice(0, 120) };
    case "otp": return { title: `${a.agentName} needs a verification code`, body: a.reason.slice(0, 120) };
    case "turn_budget": return { title: `${a.agentName} is still working`, body: `${a.payload.turns?.used ?? "Many"} steps used — continue?` };
    case "data": {
      const n = a.payload.fields?.length ?? 1;
      return { title: n > 1 ? `${n} pieces of information are needed` : `${a.agentName} needs information`, body: a.title };
    }
    default: return { title: `${a.agentName} needs you`, body: a.title };
  }
}

/**
 * Announce an action once. A second call for the same content is a no-op, so
 * re-reads, reconciliation and restarts never spam the owner.
 */
export async function notifyOwnerAction(a: OwnerAction): Promise<OwnerNotification | null> {
  const hash = actionHash(a);
  if (a.notification?.hash === hash && a.notification.state === "sent") return null;
  if (readDb().ownerNotifications.some((n) => n.dedupeKey === hash)) return null;
  const { title, body } = text(a);
  const rec: OwnerNotification = {
    id: newId(), actionId: a.id, title, body,
    href: `/action-center?action=${encodeURIComponent(a.id)}`,
    urgency: a.blocking ? "high" : "normal",
    state: "unread", dedupeKey: hash,
    delivery: { inApp: true, push: "skipped" },
    createdAt: now(),
  };
  updateDb((d) => {
    d.ownerNotifications.push(rec);
    if (d.ownerNotifications.length > MAX) d.ownerNotifications.splice(0, d.ownerNotifications.length - MAX);
  });
  const sent = { state: "sent" as const, sentAt: now(), count: (a.notification?.count ?? 0) + 1, hash };
  if (a.sourceRequestType === "native") patchOwnerAction(a.id, { notification: sent });
  else patchMeta(a.id, { notification: sent });
  // the badge, the Needs You list and the browser's own notification all react to this
  emitActivity({ agentId: OWNER_ACTIONS_CHANNEL, turnId: "owner-actions", kind: "status", title: "owner_action", detail: JSON.stringify({ event: "notify", id: a.id, title, body, href: rec.href, urgency: rec.urgency }) });
  await push(rec).catch((err) => console.error("[notify] push failed:", err));
  return rec;
}

/**
 * Announce every open action that has not been announced yet — including the
 * ones projected from Payments, Credentials, Capabilities, company requests
 * and browser handoffs, which are created inside their own domains. Content
 * hashing makes this safe to call as often as we like.
 */
export async function announceNewActions(): Promise<number> {
  const { listOpenOwnerActions } = await import("./store");
  let sent = 0;
  for (const a of listOpenOwnerActions()) {
    if (a.notification?.state === "sent" && a.notification.hash === actionHash(a)) continue;
    if (await notifyOwnerAction(a)) sent += 1;
  }
  return sent;
}

/** Optional outbound push; configured with NEXORA_PUSH_WEBHOOK, skipped when unset. */
async function push(n: OwnerNotification): Promise<void> {
  const url = process.env.NEXORA_PUSH_WEBHOOK;
  if (!url) return;
  const base = process.env.NEXORA_PUBLIC_URL ?? "";
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: n.title, body: n.body, url: `${base}${n.href}`, urgency: n.urgency, actionId: n.actionId }),
      signal: AbortSignal.timeout(8_000),
    });
    updateDb((d) => { const row = d.ownerNotifications.find((x) => x.id === n.id); if (row) row.delivery = { inApp: true, push: r.ok ? "sent" : "failed", error: r.ok ? undefined : `HTTP ${r.status}` }; });
  } catch (err) {
    updateDb((d) => { const row = d.ownerNotifications.find((x) => x.id === n.id); if (row) row.delivery = { inApp: true, push: "failed", error: String((err as Error).message).slice(0, 200) }; });
  }
}

/** A non-blocking heads-up that is not an action (e.g. a long task crossing its warning threshold). */
export async function notifyOwner(input: { title: string; body: string; href: string; dedupeKey: string; urgency?: "normal" | "high" }): Promise<OwnerNotification | null> {
  if (readDb().ownerNotifications.some((n) => n.dedupeKey === input.dedupeKey)) return null;
  const rec: OwnerNotification = {
    id: newId(), actionId: "", title: input.title, body: input.body, href: input.href,
    urgency: input.urgency ?? "normal", state: "unread", dedupeKey: input.dedupeKey,
    delivery: { inApp: true, push: "skipped" }, createdAt: now(),
  };
  updateDb((d) => {
    d.ownerNotifications.push(rec);
    if (d.ownerNotifications.length > MAX) d.ownerNotifications.splice(0, d.ownerNotifications.length - MAX);
  });
  emitActivity({ agentId: OWNER_ACTIONS_CHANNEL, turnId: "owner-actions", kind: "status", title: "owner_action", detail: JSON.stringify({ event: "notify", id: rec.id, title: rec.title, body: rec.body, href: rec.href, urgency: rec.urgency }) });
  await push(rec).catch(() => undefined);
  return rec;
}
