/** Small presentation helpers shared by the Jenkins command scripts. */

import type { JenkinsBuild } from './types';

/** Human-readable build duration, e.g. "2m 5s" or "45s" ("—" when unknown). */
export function fmtDuration(ms?: number): string {
  if (!ms || ms <= 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/** A build's status: BUILDING while in progress, else its result (or UNKNOWN). */
export function buildStatus(build: JenkinsBuild): string {
  if (build.building) return 'BUILDING';
  return build.result ?? 'UNKNOWN';
}
