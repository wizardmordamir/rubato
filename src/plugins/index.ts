/**
 * Plugin registry — re-exports every plugin factory and assembles ALL_PLUGINS,
 * the full set rubato uses internally. A friend app can import individual plugin
 * factories from their dedicated sub-modules (`rubato/plugins/automations`, etc.)
 * or grab a curated subset from here.
 */

export { automationsPlugin, migrateAutomationsDb } from './automations';
export type { AutomationsPluginOptions } from './automations';

export { boardPlugin, migrateBoardDb } from './board';
export type { BoardPluginOptions } from './board';

export { excelPlugin, migrateExcelDb } from './excel';
export type { ExcelPluginOptions } from './excel';

export { linksPlugin, migrateLinksDb } from './links';
export type { LinksPluginOptions } from './links';

export { vaultPlugin, migrateVaultDb } from './vault';
export type { VaultPluginOptions } from './vault';

import { automationsPlugin } from './automations';
import { boardPlugin } from './board';
import { excelPlugin } from './excel';
import { linksPlugin } from './links';
import { vaultPlugin } from './vault';
import type { RubatoPlugin } from '../plugin/types';

/** The full set of plugins rubato uses when running as the monolith. */
export const ALL_PLUGINS: RubatoPlugin[] = [
  automationsPlugin(),
  excelPlugin(),
  boardPlugin(),
  linksPlugin(),
  vaultPlugin(),
];
