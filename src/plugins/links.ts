/**
 * The Links plugin — the bookmark/link-manager feature packaged as a composable
 * {@link RubatoPlugin}. Owns the `links` table, the `/api/links` routes, and the
 * Links nav page.
 */

import type { Database } from 'bun:sqlite';
import type { RubatoPlugin } from '../plugin/types';
import { handleLinksApi } from '../server/linksRoutes';
import { pageByKey, type UiPage } from '../shared/ui';

/** Configuration for {@link linksPlugin}. */
export type LinksPluginOptions = Record<string, never>;

/**
 * Create/upgrade the Links tables. Idempotent — `CREATE TABLE IF NOT EXISTS` +
 * `CREATE UNIQUE INDEX IF NOT EXISTS`, so it's safe to run on every DB open.
 */
export function migrateLinksDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      folder TEXT NOT NULL DEFAULT '',
      favicon TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_links_url ON links(url)`);
}

const LINKS_PAGE = pageByKey('links') as UiPage;

/**
 * The Links (bookmark manager) plugin. Owns the `links` table, the `/api/links`
 * routes, and the Links nav page.
 */
export function linksPlugin(opts: LinksPluginOptions = {}): RubatoPlugin {
  void opts;
  return {
    id: 'links',
    label: 'Links',
    migrateDb: migrateLinksDb,
    routes: [{ prefix: ['/api/links'], handle: handleLinksApi }],
    pages: [LINKS_PAGE],
  };
}
