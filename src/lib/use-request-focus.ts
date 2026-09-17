"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";

const subscribe = (fn: () => void) => {
  window.addEventListener("popstate", fn);
  return () => window.removeEventListener("popstate", fn);
};

/**
 * A query parameter, read on the client only — the server snapshot is null, so
 * pages that link to a specific request still prerender and there is no
 * hydration mismatch.
 */
export function useLinkedRequestId(param = "request"): string | null {
  return useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(window.location.search).get(param),
    () => null,
  );
}

/**
 * Deep links from an agent's waiting status carry ?request=<id>. The surface
 * that owns the request highlights it and scrolls it into view, so the owner
 * lands on the exact thing that is blocking the agent.
 */
export function useRequestFocus() {
  const focusId = useLinkedRequestId("request");
  const scrolled = useRef(false);
  const focusRef = useCallback((el: HTMLElement | null) => {
    if (!el || scrolled.current) return;
    scrolled.current = true;
    setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
  }, []);
  const isFocused = (id: string) => !!focusId && id === focusId;
  return {
    focusId,
    isFocused,
    /** spread onto the element that renders the request */
    focusProps: (id: string) => (isFocused(id) ? { ref: focusRef } : {}),
    /** highlight ring for the focused card */
    focusClass: (id: string) => (isFocused(id) ? "ring-2 ring-warning/70" : ""),
  };
}
