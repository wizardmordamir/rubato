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
import type { AutomationStore } from '../lib/automations';
import type { CaptureStore } from '../lib/captureStore';
import type { RubatoPlugin } from '../plugin/types';
import { handleAutomationApi, handleSessionApi } from '../server/automationRoutes';
import { setSessionCaptureStore } from '../server/browserSession';
import { handleCaptureApi } from '../server/captureRoutes';
import type { RunStore } from '../server/runStore';
import { pageByKey, type UiPage } from '../shared/ui';

// Cross-platform, binary-safe data-dir helper so a friend app can place its store
// files in a sensible per-user location (`~/.<name>`, env-overridable) without
// hand-rolling OS paths — important for apps shipped as compiled binaries.
export { appDataDir } from '../lib/appData';
// Re-export the whole storage seam so a friend app builds a backend from one import:
// the interface + input type, the file-store default, and the shared save helpers
// (buildAutomationRecord/slugify) so a custom store reuses rubato's id/timestamp/
// capture-merge semantics instead of re-deriving — and can't drift from them.
export {
  type AutomationInput,
  type AutomationStore,
  buildAutomationRecord,
  createFileAutomationStore,
  slugify,
} from '../lib/automations';
export { type CaptureStore, createFileCaptureStore } from '../lib/captureStore';
export { createSqliteRunStore, type RunStore } from '../server/runStore';

/** Configuration for {@link automationsPlugin}. */
export interface AutomationsPluginOptions {
  /**
   * Where saved automations are persisted. Defaults to rubato's file store
   * (`~/.rubato/automations/`); a friend app can inject its own {@link AutomationStore}
   * (a database, an object store, an in-memory map) to keep automations off local
   * disk — no rubato change or republish needed. Leaving it unset keeps the
   * monolith's behavior unchanged.
   */
  storage?: AutomationStore;
  /**
   * Where automation run history is persisted. Defaults to rubato's SQLite
   * `automation_runs` table; inject a {@link RunStore} to keep run records in your
   * own backend. (Run *artifacts* on disk are separate.) Unset → unchanged.
   */
  runStore?: RunStore;
  /**
   * Where capture sessions (manifests + HTML/screenshot artifacts + bundles) are
   * persisted. Defaults to rubato's file store under `RUBATO_HOME`. A friend app
   * usually just relocates the directory —
   * `createFileCaptureStore(resolve(appDataDir("my-app"), "captures"))` — but can
   * inject any {@link CaptureStore}. Mounting this plugin also serves the
   * `/api/capture/*` routes (which rubato's monolith owns directly).
   */
  captureStore?: CaptureStore;
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
  // Inject the chosen backends into the handlers (each undefined → the handler's own
  // default). The live build session is a singleton, so its capture writes are
  // pointed at the store via a setter rather than a per-request arg.
  const { storage, runStore, captureStore } = opts;
  if (captureStore) setSessionCaptureStore(captureStore);
  const stores = { automations: storage, runs: runStore, captures: captureStore };
  return {
    id: 'automations',
    label: 'Browser Automation',
    migrateDb: migrateAutomationsDb,
    routes: [
      {
        prefix: ['/api/automations', '/api/automation-runs'],
        handle: (pathname, req) => handleAutomationApi(pathname, req, stores),
      },
      { prefix: '/api/session/', handle: handleSessionApi },
      // Capture library/import/export — owned by the monolith's router directly, so
      // a friend app only gets these by mounting this plugin.
      {
        prefix: '/api/capture',
        handle: (pathname, req) => handleCaptureApi(pathname, req, { captures: captureStore, automations: storage }),
      },
    ],
    pages: [AUTOMATIONS_PAGE],
  };
}
