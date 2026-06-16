/**
 * `startApp` — assemble a rubato server from a chosen set of plugins.
 *
 * This is the entry point a friend mini-app uses: it picks the plugins it wants
 * (e.g. just `automationsPlugin()`), points `uiDist` at its own built SPA, and
 * gets a server that serves only those features. Rubato's own boot can use it too
 * (with every plugin) — though the monolith currently still boots via the plain
 * `startServer`/`rubato-serve` path, which is unchanged.
 *
 * It does three things on top of {@link startServer}:
 *   1. opens the DB once and runs every plugin's `migrateDb` (in order);
 *   2. flattens the plugins' `routes` + `pages` into the server's plugin wiring;
 *   3. boots the server, forwarding `uiDist` and any pass-through start options.
 */

import type { RubatoPlugin } from '../plugin/types';
import { getDb } from './db';
import { type ServerHandle, type StartOptions, startServer } from './start';

/** Options for {@link startApp}: the plugins plus the usual server start options. */
export interface StartAppOptions extends Omit<StartOptions, 'pluginRoutes' | 'pluginPages'> {
  /** The plugins to assemble, in order (migrations + route precedence follow it). */
  plugins: RubatoPlugin[];
}

/**
 * Open the DB, run each plugin's migrations, then start the server with the
 * plugins' routes + pages wired in. Returns the same handle as {@link startServer}.
 */
export function startApp(options: StartAppOptions): ServerHandle {
  const { plugins, ...rest } = options;

  // 1. DB init: open once, run every plugin's idempotent migrations in order.
  const db = getDb();
  for (const plugin of plugins) plugin.migrateDb?.(db);

  // 2. Assemble the plugins' route handlers + page declarations.
  const pluginRoutes = plugins.flatMap((p) => p.routes ?? []);
  const pluginPages = plugins.flatMap((p) => p.pages ?? []);

  // 3. Boot — `uiDist` / `scripts` / `port` / `hostname` ride along via `rest`.
  return startServer({ ...rest, pluginRoutes, pluginPages });
}
