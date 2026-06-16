/**
 * Embeddable entry point: run rubato's local server + web UI from inside another
 * app.
 *
 *   import { on } from "rubato/server";
 *   on();   // boots the server + UI only when RUBATO_ON=true, else a no-op
 *
 * The pattern: the host app calls `on()` unconditionally, and whether the server
 * actually boots is controlled by the operator via the `RUBATO_ON` environment
 * variable. The same code ships everywhere; it only serves where it's switched
 * on. Calling `on()` with the var unset (or anything but the string "true") is a
 * safe no-op that returns `undefined`.
 *
 * Returns a {@link ServerHandle} (with `.url` and `.stop()`) when it boots, so
 * the host can address or shut it down.
 *
 * This module is also the public `rubato/server` surface: alongside `on()` it
 * re-exports {@link startApp} (the plugin-assembly factory) and the plugin types,
 * so a friend mini-app can `import { startApp } from 'rubato/server'`.
 */

import type { PluginRouteHandler, RubatoPlugin } from './plugin/types';
import { type ServerHandle, type StartOptions, startServer } from './server/start';
import { type StartAppOptions, startApp } from './server/startApp';

/** Env var that gates {@link on}. Set to the string `"true"` to enable. */
export const RUBATO_ON_ENV = 'RUBATO_ON';

/** Whether the server is switched on via `RUBATO_ON=true`. */
export function isEnabled(): boolean {
  return process.env[RUBATO_ON_ENV] === 'true';
}

/**
 * Start the rubato server + UI, but only when enabled via `RUBATO_ON=true`.
 * No-op (returns `undefined`) otherwise.
 */
export function on(options: StartOptions = {}): ServerHandle | undefined {
  if (!isEnabled()) return undefined;
  return startServer(options);
}

export type { UiBranding } from './server/router';
export type { PluginRouteHandler, RubatoPlugin, ServerHandle, StartAppOptions, StartOptions };
export { startApp };
