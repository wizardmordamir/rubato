// A tiny localStorage-backed boolean preference, read reactively via
// useSyncExternalStore (same shape as debug.ts). For sticky UI choices like the
// automation run options (headless / keep open) that should survive a reload.

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function read(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

/** A boolean preference persisted under `key`; returns [value, setValue]. */
export function usePersistentBoolean(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key, fallback),
    () => fallback,
  );
  const set = useCallback(
    (v: boolean) => {
      try {
        localStorage.setItem(key, v ? "1" : "0");
      } catch {
        // private mode / storage disabled — choice still applies this session.
      }
      for (const l of listeners) l();
    },
    [key],
  );
  return [value, set];
}

// JSON-object preferences (e.g. the nav/hub customization in navPrefs.ts). We
// cache the parsed value per key so `getSnapshot` returns a STABLE reference while
// the stored string is unchanged — otherwise useSyncExternalStore would see a new
// object every render and loop. Callers must pass a stable (module-constant)
// `fallback`, since that exact reference is returned when nothing is stored yet.
const jsonCache = new Map<string, { raw: string; value: unknown }>();

function readJson<T>(key: string, fallback: T): T {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return fallback;
  }
  if (raw == null) return fallback;
  const cached = jsonCache.get(key);
  if (cached && cached.raw === raw) return cached.value as T;
  try {
    const value = JSON.parse(raw) as T;
    jsonCache.set(key, { raw, value });
    return value;
  } catch {
    return fallback;
  }
}

/** A JSON-object preference persisted under `key`. Returns [value, setValue]. */
export function usePersistentJson<T>(key: string, fallback: T): [T, (v: T) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readJson(key, fallback),
    () => fallback,
  );
  const set = useCallback(
    (v: T) => {
      try {
        const raw = JSON.stringify(v);
        localStorage.setItem(key, raw);
        jsonCache.set(key, { raw, value: v });
      } catch {
        // private mode / storage disabled — choice still applies this session.
      }
      for (const l of listeners) l();
    },
    [key],
  );
  return [value, set];
}

function readStr<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const raw = localStorage.getItem(key) as T | null;
    return raw != null && allowed.includes(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A string-enum preference persisted under `key` (constrained to `allowed`), for
 * sticky choices like run speed. Returns [value, setValue].
 */
export function usePersistentString<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): [T, (v: T) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readStr(key, fallback, allowed),
    () => fallback,
  );
  const set = useCallback(
    (v: T) => {
      try {
        localStorage.setItem(key, v);
      } catch {
        // private mode / storage disabled — choice still applies this session.
      }
      for (const l of listeners) l();
    },
    [key],
  );
  return [value, set];
}
