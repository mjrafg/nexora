export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { listNotifications, markAllRead, markNotificationRead, unreadCount } from "@/lib/owner-actions/notify";
import { jsonError, readJson, str } from "@/lib/api-helpers";

export async function GET() {
  return NextResponse.json({ notifications: listNotifications(50), unread: unreadCount() });
}

export async function POST(req: Request) {
  try {
    const b = await readJson<{ id?: string; all?: boolean }>(req);
    if (b.all) markAllRead();
    else if (str(b.id, 80)) markNotificationRead(str(b.id, 80)!);
    return NextResponse.json({ ok: true, unread: unreadCount() });
  } catch (err) {
    return jsonError(err);
  }
}
