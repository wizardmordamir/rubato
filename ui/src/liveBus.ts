/**
 * Client-side fan-out of server events. useLive owns the single /ws socket and
 * pushes every parsed ServerEvent here; components (e.g. the automation builder)
 * subscribe to the ones they care about without opening a second socket.
 */

import { useEffect, useRef } from "react";
import type { ServerEvent } from "@shared/types";

type Handler = (e: ServerEvent) => void;

const listeners = new Set<Handler>();

export function emitClient(event: ServerEvent): void {
  for (const l of listeners) l(event);
}

export function onServerEvent(handler: Handler): () => void {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

/** Subscribe to live server events; always calls the latest handler. */
export function useServerEvent(handler: Handler): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => onServerEvent((e) => ref.current(e)), []);
}
