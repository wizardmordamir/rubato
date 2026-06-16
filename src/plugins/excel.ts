/**
 * The Excel plugin — the Excel Automations feature (upload workbook → declarative
 * step engine → revision chain) packaged as a composable {@link RubatoPlugin}.
 *
 * The Excel DDL lives here (in {@link migrateExcelDb}) rather than in the shared
 * `db.ts`, so the schema travels with the plugin. Rubato's own `getDb()` still
 * calls it; a friend app gets it run via `startApp` → this plugin's `migrateDb`.
 */

import type { Database } from 'bun:sqlite';
import type { RubatoPlugin } from '../plugin/types';
import { handleExcelAutomationApi } from '../server/excelAutomationRoutes';
import { pageByKey, type UiPage } from '../shared/ui';

/** Configuration for {@link excelPlugin}. */
export interface ExcelPluginOptions {
  /**
   * Directory where workbook revision bytes are stored on disk. Reserved for the
   * friend-app shape; rubato itself uses its `~/.rubato/excel` default, so leaving
   * this unset keeps the monolith's behavior unchanged.
   */
  workbooksDir?: string;
}

/**
 * Create/upgrade the Excel Automations tables. Idempotent — `CREATE TABLE IF NOT
 * EXISTS` + indexed, so it's safe to run on every DB open.
 */
export function migrateExcelDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS excel_automations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL DEFAULT 'xlsx',
      source_name TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL DEFAULT '[]',
      original_revision_id TEXT,
      current_revision_id TEXT,
      result_revision_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS excel_revisions (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      parent_revision_id TEXT,
      seq INTEGER NOT NULL DEFAULT 0,
      label TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'step',
      produced_by_step_index INTEGER,
      produced_by_step_id TEXT,
      byte_size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      hidden_mask_json TEXT NOT NULL DEFAULT '{}',
      step_result_json TEXT NOT NULL DEFAULT '{}'
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_excel_revisions_automation ON excel_revisions(automation_id, seq)');
  db.run(`
    CREATE TABLE IF NOT EXISTS excel_recipes (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL DEFAULT '[]'
    )
  `);
}

const EXCEL_PAGE = pageByKey('excel') as UiPage;
const EXCEL_AUTOMATIONS_PAGE = pageByKey('excel-automations') as UiPage;

/**
 * The Excel Automations plugin. Owns the `excel_automations`, `excel_revisions`,
 * and `excel_recipes` tables, the `/api/excel-automations` and `/api/excel-recipes`
 * routes, and the Excel nav page.
 */
export function excelPlugin(opts: ExcelPluginOptions = {}): RubatoPlugin {
  void opts.workbooksDir;
  return {
    id: 'excel',
    label: 'Excel Automations',
    migrateDb: migrateExcelDb,
    routes: [
      {
        prefix: ['/api/excel-automations', '/api/excel-recipes'],
        handle: handleExcelAutomationApi,
      },
    ],
    pages: [EXCEL_PAGE, EXCEL_AUTOMATIONS_PAGE],
  };
}
