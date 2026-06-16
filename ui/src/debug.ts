// A tiny global "show AI debug info" preference, mirrored to localStorage and
// read reactively via useSyncExternalStore (same shape as chatStore). When on,
// assistant messages reveal a debug panel with their timing/decision trace.

import { useSyncExternalStore } from "react";

const KEY = "rubato.debug";
const listeners = new Set<() => void>();

let enabled = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();

function notify() {
  for (const l of listeners) l();
}

export function toggleDebug(): void {
  enabled = !enabled;
  try {
    localStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {
    // private mode / storage disabled — preference still applies this session.
  }
  notify();
}

/** Subscribe a component to the debug preference. */
export function useDebug(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => enabled,
  );
}
