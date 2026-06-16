/**
 * The Vault plugin — the encrypted, master-password-gated credential store
 * packaged as a composable {@link RubatoPlugin}. Owns the `vault_items` and
 * `vault_meta` tables, the `/api/vault` routes, and the Vault nav page.
 *
 * The at-rest encryption key is read from the env var named by `vaultKeyEnv`
 * (default `'RUBATO_VAULT_SECRET'`). If absent the route handler auto-generates
 * and persists one to `~/.rubato/.env` — the same behavior rubato itself uses.
 */

import type { Database } from 'bun:sqlite';
import type { RubatoPlugin } from '../plugin/types';
import { handleVaultApi } from '../server/vaultRoutes';
import { pageByKey, type UiPage } from '../shared/ui';

/** Configuration for {@link vaultPlugin}. */
export interface VaultPluginOptions {
  /**
   * Environment variable name for the server-held at-rest encryption key.
   * Reserved for the friend-app shape; rubato itself always uses
   * `'RUBATO_VAULT_SECRET'`, so leaving this unset keeps the monolith's behavior.
   */
  vaultKeyEnv?: string;
}

/**
 * Create/upgrade the Vault tables. Idempotent — `CREATE TABLE IF NOT EXISTS`, so
 * it's safe to run on every DB open.
 */
export function migrateVaultDb(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS vault_items (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS vault_meta (
      id TEXT PRIMARY KEY,
      master_hash TEXT NOT NULL,
      master_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

const VAULT_PAGE = pageByKey('vault') as UiPage;

/**
 * The Vault plugin. Owns the `vault_items` and `vault_meta` tables, the
 * `/api/vault` routes, and the Vault nav page.
 */
export function vaultPlugin(opts: VaultPluginOptions = {}): RubatoPlugin {
  void opts.vaultKeyEnv;
  return {
    id: 'vault',
    label: 'Vault',
    migrateDb: migrateVaultDb,
    routes: [{ prefix: ['/api/vault'], handle: handleVaultApi }],
    pages: [VAULT_PAGE],
  };
}
