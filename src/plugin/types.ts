/**
 * The rubato plugin interface — the contract a feature implements to be packaged
 * as a composable unit and assembled into a friend-specific mini-app.
 *
 * A plugin owns three things: its DB tables (idempotent DDL run at DB-open time),
 * the server routes it serves, and the UI page declarations it contributes to the
 * nav. The host (`startApp`) flattens these across all chosen plugins, so a friend
 * app that includes only `automationsPlugin()` gets just the automation tables,
 * routes, and page — nothing else.
 *
 * Plugins are **factory functions** returning a {@link RubatoPlugin}
 * (`automationsPlugin({ storage, runStore, captureStore })`), not plain objects, so
 * each plugin can accept configuration without a separate wiring step. This module is types-only
 * (no runtime imports beyond the `bun:sqlite` Database type), so it's cheap to
 * import from both the server and a plugin module.
 */

import type { Database } from 'bun:sqlite';
import type { UiPage } from '../shared/ui';

/**
 * A server route a plugin owns. Dispatched before rubato's built-in route chain:
 * the first handler whose prefix matches the request pathname handles it.
 */
export interface PluginRouteHandler {
  /** Path prefix(es) this handler claims, e.g. `'/api/automations'` or a list. */
  prefix: string | string[];
  /** Handle a matched request. Same `(pathname, req) → Response` shape as the
   *  built-in `handle*Api` functions, so existing handlers wrap with no rewrite. */
  handle(pathname: string, req: Request): Promise<Response>;
}

/**
 * A composable rubato feature. Returned by a plugin factory function (e.g.
 * `automationsPlugin(opts)`), so plugins can be configured at assembly time.
 */
export interface RubatoPlugin {
  /** Stable key, e.g. `'automations'`. */
  id: string;
  /** Human label for a future plugin/settings UI. */
  label: string;
  /** Idempotent DDL (CREATE TABLE IF NOT EXISTS + `addColumnIfMissing`), run once
   *  per plugin at DB-open time. Safe to run repeatedly. */
  migrateDb?(db: Database): void;
  /** Server routes this plugin owns. */
  routes?: PluginRouteHandler[];
  /** UI page declarations (for the nav + `GET /api/ui`). */
  pages?: UiPage[];
}
