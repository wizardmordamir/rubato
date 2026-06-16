// A tiny global "auto-scroll chat to the latest output" preference, mirrored to
// localStorage and read reactively via useSyncExternalStore (same shape as
// debug.ts). On by default — when off, the Ask thread never auto-pins to the
// bottom as answers stream in, so the user stays wherever they scrolled.

import { useSyncExternalStore } from "react";

const KEY = "rubato.autoscroll";
const listeners = new Set<() => void>();

// Default ON: only an explicit "0" disables it (preserves prior behavior).
let enabled = (() => {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
})();

function notify() {
  for (const l of listeners) l();
}

export function toggleAutoScroll(): void {
  enabled = !enabled;
  try {
    localStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {
    // private mode / storage disabled — preference still applies this session.
  }
  notify();
}

/** Subscribe a component to the auto-scroll preference. */
export function useAutoScroll(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => enabled,
  );
}
