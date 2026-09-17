"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A CSS media query, read on the client only. The server snapshot is false —
 * pages prerender as the wide layout and settle into the real one on
 * hydration, with no mismatch.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (fn: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", fn);
      return () => mql.removeEventListener("change", fn);
    },
    [query]
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

/** The workspace has room for the chat plus at most one side panel below this. */
export const NARROW_WORKSPACE = "(max-width: 1100px)";
