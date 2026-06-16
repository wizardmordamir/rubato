/**
 * The automations plugin — the Playwright browser-automation feature packaged as
 * a composable {@link RubatoPlugin}. It's a thin wrapper: the route handlers and
 * the DB schema already exist; this module just declares which tables, routes, and
 * UI page the feature owns, so a friend app can include *only* automation.
 *
 * The automation DDL lives here (in {@link migrateAutomationsDb}) rather than in
 * the shared `db.ts`, so the schema travels with the plugin. Rubato's own `getDb()`
 * still calls it (the monolith owns every table); a friend app gets it run via
 * `startApp` → this plugin's `migrateDb`.
 */

import type { Database } from 'bun:sqlite';
import { addColumnIfMissing } from 'cwip/sqlite';
import type { RubatoPlugin } from '../plugin/types';
import { handleAutomationApi, handleSessionApi } from '../server/automationRoutes';
import { pageByKey, type UiPage } from '../shared/ui';

/** Configuration for {@link automationsPlugin}. */
export interface AutomationsPluginOptions {
  /**
   * Directory for on-disk capture/run artifacts. Reserved for the friend-app
   * shape (Stage 4+); rubato itself uses its `~/.rubato` default, so leaving this
   * unset keeps the monolith's behavior unchanged.
   */
  captureDir?: string;
}

/**
 * Create/upgrade the automation tables. Idempotent — `CREATE TABLE IF NOT EXISTS`
 * + additive `addColumnIfMissing`, so it's safe to run on every DB open.
 */
export function migrateAutomationsDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      automation TEXT NOT NULL,
      status TEXT NOT NULL,
      steps TEXT NOT NULL,
      scraped TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    )
  `);
  // automation_id locates a run's on-disk artifacts (named by id + startedAt) for
  // cleanup; correlation_id ties a run to the request that launched it (its server
  // logs + captured outbound calls). Both additive — older rows carry NULL.
  addColumnIfMissing(db, 'automation_runs', 'automation_id', 'TEXT');
  addColumnIfMissing(db, 'automation_runs', 'correlation_id', 'TEXT');
}

/** The automations UI page declaration (the canonical entry from the registry). */
const AUTOMATIONS_PAGE = pageByKey('automations') as UiPage;

/**
 * The Playwright browser-automation plugin. Owns the `automation_runs` table, the
 * `/api/automations`, `/api/automation-runs`, and `/api/session/` routes, and the
 * Browser nav page.
 *
 * Requires Playwright at runtime — a friend app must `bun add playwright`
 * separately (it's an optional peer dependency of rubato, not bundled).
 */
export function automationsPlugin(opts: AutomationsPluginOptions = {}): RubatoPlugin {
  // captureDir is part of the public contract now (factory shape); its wiring into
  // capture storage lands with the friend-app build (Stage 4+).
  void opts.captureDir;
  return {
    id: 'automations',
    label: 'Browser Automation',
    migrateDb: migrateAutomationsDb,
    routes: [
      { prefix: ['/api/automations', '/api/automation-runs'], handle: handleAutomationApi },
      { prefix: '/api/session/', handle: handleSessionApi },
    ],
    pages: [AUTOMATIONS_PAGE],
  };
}
