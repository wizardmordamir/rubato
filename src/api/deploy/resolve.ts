/**
 * Resolve a deploy-list version to its live Quay tag and (best-effort) Jenkins
 * build. The Quay tag is the trustworthy anchor: a tag literally named the version
 * carries the immutable manifest digest. The Jenkins build is enrichment only —
 * see version.ts for why the mapping can't be trusted as a gate.
 */

import type { JenkinsClient } from '../jenkins';
import type { JenkinsAppApi, JenkinsBuild, JenkinsDefaults, JenkinsVersionStrategy } from '../jenkins/types';
import type { QuayClient, QuayTag } from '../quay';
import { buildNumberFromVersion, versionFromBuild } from './version';

/** Find the Quay tag whose name equals `version` (including expired tags). */
export async function resolveQuayTagForVersion(
  quay: QuayClient,
  repository: string,
  version: string,
): Promise<QuayTag | null> {
  const tags = await quay.getTags(repository, { tag: version, onlyActive: false });
  return tags.find((t) => t.name === version) ?? null;
}

/** Merge per-app over global version strategy, with sane defaults. */
export function effectiveVersionStrategy(
  app?: JenkinsAppApi,
  defaults?: JenkinsDefaults,
): Required<JenkinsVersionStrategy> {
  const s = { ...defaults?.versionStrategy, ...app?.versionStrategy };
  return {
    source: s.source ?? 'displayName',
    param: s.param ?? '',
    buildNumberFallback: s.buildNumberFallback ?? true,
  };
}

export type MatchStrategy = 'embedded' | 'buildNumber' | 'none';

export interface ResolveBuildResult {
  build: JenkinsBuild | null;
  strategy: MatchStrategy;
}

export interface ResolveBuildOptions {
  /** How many recent builds to scan. Default 50. */
  limit?: number;
  /** Effective version strategy (use effectiveVersionStrategy). */
  strategy?: Required<JenkinsVersionStrategy>;
}

/**
 * Find the Jenkins build that produced `version`, in descending confidence:
 *   1. a build whose embedded version (param or displayName) equals `version`
 *   2. (fallback, flagged) the build whose number == the version's trailing segment
 * Returns the match strategy so callers can flag low-confidence (buildNumber) hits.
 */
export async function resolveBuildForVersion(
  jenkins: JenkinsClient,
  jobPath: string,
  version: string,
  opts: ResolveBuildOptions = {},
): Promise<ResolveBuildResult> {
  const strategy = opts.strategy ?? effectiveVersionStrategy();
  const param = strategy.source === 'param' ? strategy.param || undefined : undefined;
  const builds = await jenkins.getBuilds(jobPath, { limit: opts.limit ?? 50 });

  for (const b of builds) {
    if (versionFromBuild(b, { param }) === version) return { build: b, strategy: 'embedded' };
  }

  if (strategy.buildNumberFallback) {
    const n = buildNumberFromVersion(version);
    if (n != null) {
      const b = builds.find((x) => x.number === n);
      if (b) return { build: b, strategy: 'buildNumber' };
    }
  }

  return { build: null, strategy: 'none' };
}
