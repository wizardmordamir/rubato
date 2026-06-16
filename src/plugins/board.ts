/**
 * The Board plugin — the kanban task-board feature packaged as a composable
 * {@link RubatoPlugin}. Owns the `board_tasks` table, the `/api/board` routes,
 * and the Board nav page.
 */

import type { Database } from 'bun:sqlite';
import type { RubatoPlugin } from '../plugin/types';
import { handleBoardApi } from '../server/boardRoutes';
import { pageByKey, type UiPage } from '../shared/ui';

/** Configuration for {@link boardPlugin}. */
export type BoardPluginOptions = Record<string, never>;

/**
 * Create/upgrade the Board tables. Idempotent — `CREATE TABLE IF NOT EXISTS`, so
 * it's safe to run on every DB open.
 */
export function migrateBoardDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS board_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      task TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

const BOARD_PAGE = pageByKey('board') as UiPage;

/**
 * The kanban Board plugin. Owns the `board_tasks` table, the `/api/board` routes,
 * and the Board nav page.
 */
export function boardPlugin(opts: BoardPluginOptions = {}): RubatoPlugin {
  void opts;
  return {
    id: 'board',
    label: 'Board',
    migrateDb: migrateBoardDb,
    routes: [{ prefix: ['/api/board'], handle: handleBoardApi }],
    pages: [BOARD_PAGE],
  };
}
