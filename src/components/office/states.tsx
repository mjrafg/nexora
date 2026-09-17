"use client";

import { Ban, Brain, CreditCard, Hand, KeyRound, Loader2, MonitorSmartphone, Moon, PauseCircle, Users, Wrench, type LucideIcon } from "lucide-react";
import type { FloorState } from "@/lib/office/floor";

/**
 * The words the owner sees for each state, in one place.
 *
 * These are deliberately plain. "Working" means a model is running right
 * now; everything else says what is actually being waited for, because a
 * pretty animation over a wrong status is worse than no picture at all.
 */
export const STATE_META: Record<FloorState, { label: string; short: string; color: string; icon: LucideIcon }> = {
  WORKING: { label: "Working", short: "Working", color: "#4f8bff", icon: Brain },
  WAITING_TEAM: { label: "Waiting for its team", short: "Waiting for team", color: "#8b9cff", icon: Users },
  WAITING_CAPABILITY: { label: "Waiting for a capability", short: "Needs a tool", color: "#2fd4e6", icon: Wrench },
  WAITING_LOGIN: { label: "Waiting for login information", short: "Needs a login", color: "#f5b942", icon: KeyRound },
  WAITING_INFO: { label: "Waiting for company information", short: "Needs information", color: "#f5b942", icon: Hand },
  WAITING_APPROVAL: { label: "Waiting for approval", short: "Needs approval", color: "#f5b942", icon: CreditCard },
  WAITING_OWNER: { label: "Waiting for you", short: "Needs you", color: "#f5b942", icon: Hand },
  BROWSER: { label: "Browser handed to you", short: "Browser is yours", color: "#f5b942", icon: MonitorSmartphone },
  BLOCKED: { label: "Blocked", short: "Blocked", color: "#ff5c7a", icon: Ban },
  STALLED: { label: "Stopped part-way", short: "Stopped", color: "#ff8a3d", icon: PauseCircle },
  IDLE: { label: "Available", short: "Available", color: "#7c8699", icon: Moon },
};

/** A small round state marker, the same one everywhere. */
export function StateDot({ state, size = 14, spin = false }: { state: FloorState; size?: number; spin?: boolean }) {
  const m = STATE_META[state];
  const Icon = state === "WORKING" && spin ? Loader2 : m.icon;
  return (
    <span
      className="grid place-items-center rounded-full border"
      style={{ width: size, height: size, background: `${m.color}22`, borderColor: `${m.color}88`, color: m.color }}
      title={m.label}
    >
      <Icon className={state === "WORKING" && spin ? "animate-spin" : undefined} style={{ width: size * 0.62, height: size * 0.62 }} strokeWidth={2.4} />
    </span>
  );
}
