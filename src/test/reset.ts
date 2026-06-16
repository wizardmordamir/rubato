/**
 * Reset every piece of cached/global rubato state in one call, so a test (or a
 * re-seed) starts clean without having to remember each cache. Several
 * independent caches (config/apps/env keyed off RUBATO_HOME, plus the external-API
 * response caches) collapse into this one call.
 */

import { clearEnvCache } from '../api/env';
import { clearApiResponseCaches } from '../api/responseCaches';
import { clearAppsCache } from '../lib/apps';
import { clearConfigCache } from '../lib/config';
import { __resetDbForTests } from '../server/db';

export function resetRubatoState(): void {
  __resetDbForTests();
  clearConfigCache();
  clearAppsCache();
  clearEnvCache();
  clearApiResponseCaches();
}
