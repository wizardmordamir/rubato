import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import type { ServerEvent } from "@shared/types";
import { chatStore } from "./chatStore";
import { emitClient } from "./liveBus";
import { useToast } from "./toast";

type LiveStatus = "connecting" | "open" | "closed";
type SideEffects = { qc: ReturnType<typeof useQueryClient>; notify: ReturnType<typeof useToast>["notify"] };

/**
 * One shared /ws connection for the whole app.
 *
 * Both the App shell and the SideNav want the live-connection status — but if each
 * opened its OWN socket, every event would arrive twice: streamed answer tokens
 * would double (e.g. "HelloHello") and run/automation toasts + query invalidations
 * would fire twice. So the socket, its status, and the message pump live at module
 * scope; each `useLive()` caller just subscribes to the status and registers the
 * latest React-bound side-effect handlers (query invalidation + toasts).
 *
 * Auto-reconnects with backoff. Returns the connection state for a status dot.
 */
let status: LiveStatus = "connecting";
const statusListeners = new Set<() => void>();
function setStatus(next: LiveStatus): void {
  if (next === status) return;
  status = next;
  for (const l of statusListeners) l();
}

// Latest query-client + toast fn. Every caller sits under the same providers, so
// these are the same instances each render — last writer wins, harmlessly.
let sideEffects: SideEffects | null = null;
let started = false;

/**
 * Where to open the socket. In production the UI is served from the API origin, so
 * a same-origin `/ws` is right. In dev the Vite server proxies the rest of the app,
 * but its `/ws` proxy is unreliable — under Vite 8 (rolldown) the WebSocket upgrade
 * hangs and never reaches the API, so live answer streaming silently never starts
 * and replies only appear on the next refetch. Connect straight to the API instead
 * (its dev URL is injected at build time, derived from the port the proxy targets).
 */
function socketUrl(): string {
  if (import.meta.env.DEV && typeof __RUBATO_DEV_WS_URL__ === "string") return __RUBATO_DEV_WS_URL__;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

/** Route one parsed server event to its consumers (runs exactly once per event). */
function routeEvent(event: ServerEvent): void {
  emitClient(event); // fan out to component subscribers (e.g. the builder)
  // Ask streaming: token-level updates go to the chat store, not react-query.
  if (event.type.startsWith("ask:")) {
    chatStore.applyEvent(event);
    return;
  }
  const se = sideEffects;
  if (!se) return;
  const { qc, notify } = se;
  if (event.type === "index:status") {
    qc.setQueryData(["index", event.status.app], event.status);
  } else if (event.type === "run:started") {
    notify(`${event.command} started…`);
  } else if (event.type === "run:completed") {
    notify(`${event.run.command} → exit ${event.run.exitCode}`, event.run.exitCode === 0 ? "success" : "error");
    qc.invalidateQueries({ queryKey: ["runs"] });
    qc.invalidateQueries({ queryKey: ["runHistory"] });
  } else if (event.type === "automation:run:completed") {
    notify(`${event.run.automation} → ${event.run.status}`, event.run.status === "passed" ? "success" : "error");
    qc.invalidateQueries({ queryKey: ["automationRuns"] });
  }
}

/** Open the shared socket once, reconnecting with backoff. Idempotent. */
function ensureConnection(): void {
  if (started) return;
  started = true;
  let backoff = 500;
  const connect = () => {
    setStatus("connecting");
    const ws = new WebSocket(socketUrl());
    ws.onopen = () => {
      backoff = 500;
      setStatus("open");
    };
    ws.onmessage = (e) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(e.data) as ServerEvent;
      } catch {
        return;
      }
      routeEvent(event);
    };
    ws.onclose = () => {
      setStatus("closed");
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
    ws.onerror = () => ws.close();
  };
  connect();
}

/**
 * Subscribe to the shared live-connection status (lazily opening the one socket).
 * Safe to call from any number of components — they all share one connection.
 */
export function useLive(): LiveStatus {
  const qc = useQueryClient();
  const { notify } = useToast();
  // Register the latest React-bound handlers for the module-level message pump.
  useEffect(() => {
    sideEffects = { qc, notify };
    ensureConnection();
  }, [qc, notify]);
  return useSyncExternalStore(
    (cb) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    () => status,
  );
}
