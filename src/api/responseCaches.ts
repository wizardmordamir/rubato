/**
 * Clear every external-API response cache in one call. The deploy-metadata
 * clients (Quay tags, GitLab projects/commits/branches) memoize their reads at
 * module scope for a short TTL; tests reset this between scenarios (via the fake
 * upstream's `reset()`), and a forced "refresh now" could call it too.
 */

import { clearGitlabCache } from './gitlab';
import { clearQuayCache } from './quay';

export function clearApiResponseCaches(): void {
  clearQuayCache();
  clearGitlabCache();
}
