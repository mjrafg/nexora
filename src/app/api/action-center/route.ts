export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { listOpenOwnerActions, listRecentResolved, openOwnerActionCount } from "@/lib/owner-actions/store";
import { reconcileOwnerActions } from "@/lib/owner-actions/service";
import { announceNewActions, listNotifications, unreadCount } from "@/lib/owner-actions/notify";
import { reconcileAgentWaiting } from "@/lib/agents/waiting";
import "@/lib/tools/servers";

/**
 * Everything that needs the owner, from every subsystem. An empty `actions`
 * array is the product promise: nothing is waiting on a human anywhere.
 */
export async function GET() {
  // an action whose agent or backing request is gone must never linger here
  reconcileOwnerActions();
  reconcileAgentWaiting();
  await announceNewActions();
  return NextResponse.json({
    actions: listOpenOwnerActions(),
    recent: listRecentResolved(10),
    counts: openOwnerActionCount(),
    notifications: listNotifications(20),
    unread: unreadCount(),
  });
}
