/**
 * Boot the rubato explorer server — the reusable core behind both the
 * `rubato-serve` CLI and the embeddable {@link import("../on").on} entry point.
 *
 * A small web UI + read API over your app registry, commands, and config, built
 * on Bun's server. Binds to loopback only (never the network). Returns a handle
 * so an embedding host can stop it; logs nothing by itself (library-friendly) —
 * callers that want a banner print their own.
 */

import type { Server, ServerWebSocket } from 'bun';
import { type RegisteredScript, registerScripts } from '../lib/scriptRegistry';
import type { PluginRouteHandler } from '../plugin/types';
import type { UiPage } from '../shared/ui';
import { BUILTIN_SCRIPTS } from './builtinScripts';
import { initDebugCapture } from './debugCapture';
import { subscribe } from './events';
import { route } from './router';

export interface StartOptions {
  /** Port to bind (default 4747, or `RUBATO_PORT`). */
  port?: number;
  /** Hostname to bind (default loopback `127.0.0.1`). */
  hostname?: string;
  /**
   * Custom in-process scripts to register before serving — the embedding app's
   * own functions, runnable from the UI and as pipeline `script` stages. Same as
   * calling {@link registerScript} for each before `startServer`.
   */
  scripts?: RegisteredScript[];
  /**
   * Plugin-owned server routes, dispatched ahead of rubato's built-in route chain
   * (the first prefix match wins). Assembled by {@link startApp} from the chosen
   * plugins; rubato's own boot leaves it unset (its routes are the built-ins).
   */
  pluginRoutes?: PluginRouteHandler[];
  /**
   * Plugin-contributed UI page declarations, surfaced to the client via
   * `GET /api/ui` so the nav can include them. Assembled by {@link startApp}.
   */
  pluginPages?: UiPage[];
  /**
   * Absolute path to the built SPA to serve (`index.html` + assets). Defaults to
   * rubato's own `ui/dist`; a friend app points it at its own built UI.
   */
  uiDist?: string;
}

export interface ServerHandle {
  server: Server<undefined>;
  url: string;
  /** Stop the server (does not wait for in-flight requests). */
  stop(): void;
}

/** Start the server and return a handle. Throws if the port is unavailable. */
export function startServer(options: StartOptions = {}): ServerHandle {
  // `Number(undefined)` is NaN (not nullish), so a bare `?? Number(env) ?? 4747`
  // would bind NaN → a random port. Validate the env var and fall back to 4747
  // whenever it's unset OR non-numeric (a bad value should never bind NaN).
  // Built-ins first, then embedder scripts (so an embedder can override by id).
  registerScripts(BUILTIN_SCRIPTS);
  registerScripts(options.scripts);
  // Install the outbound-fetch capture hook (a no-op unless RUBATO_CAPTURE / the toggle is on).
  initDebugCapture();
  const envPort = Number(process.env.RUBATO_PORT);
  const port = options.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 4747);
  const hostname = options.hostname ?? '127.0.0.1';

  // Each socket gets a live subscription to server events; cleaned up on close.
  const unsubscribers = new Map<ServerWebSocket, () => void>();

  const server = Bun.serve({
    port,
    hostname,
    fetch(req, srv) {
      if (new URL(req.url).pathname === '/ws') {
        return srv.upgrade(req) ? undefined : new Response('expected a websocket', { status: 426 });
      }
      return route(req, {
        pluginRoutes: options.pluginRoutes,
        pluginPages: options.pluginPages,
        uiDist: options.uiDist,
      });
    },
    websocket: {
      open(ws) {
        unsubscribers.set(
          ws,
          subscribe((event) => ws.send(JSON.stringify(event))),
        );
        ws.send(JSON.stringify({ type: 'hello' }));
      },
      close(ws) {
        unsubscribers.get(ws)?.();
        unsubscribers.delete(ws);
      },
      message() {}, // clients only listen
    },
  });

  return {
    server,
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}
