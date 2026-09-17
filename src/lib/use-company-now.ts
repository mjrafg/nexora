"use client";

import { useEffect, useState } from "react";
import type { Floor } from "@/lib/office/floor";

/**
 * What the company is actually doing, for the chrome that is on every page.
 *
 * The office itself subscribes to the activity stream; the header and the
 * sidebar only need a number every so often, and a quiet poll costs less
 * than another open connection on every page.
 */
export function useCompanyNow(intervalMs = 20_000): { totals: Floor["totals"] | null; actions: number } {
  const [totals, setTotals] = useState<Floor["totals"] | null>(null);
  const [actions, setActions] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void fetch("/api/office", { cache: "no-store" })
        .then((r) => r.json())
        .then((d: Floor) => { if (alive && d?.totals) setTotals(d.totals); })
        .catch(() => undefined);
      void fetch("/api/action-center", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => { if (alive && d?.counts) setActions(d.counts.total ?? 0); })
        .catch(() => undefined);
    };
    const first = setTimeout(load, 0);
    const t = setInterval(load, intervalMs);
    return () => { alive = false; clearTimeout(first); clearInterval(t); };
  }, [intervalMs]);

  return { totals, actions };
}
