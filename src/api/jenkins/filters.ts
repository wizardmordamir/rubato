/**
 * Pure helpers for picking apart and filtering Jenkins builds, so callers can
 * ask "the latest successful build on main" without knowing where Jenkins buries
 * that information (changeSets, build actions, parameters).
 *
 * The extractors are heuristic — Jenkins exposes commit/branch data in a few
 * shapes depending on the SCM/plugin — and degrade to null/empty rather than
 * throwing.
 */

import type { BuildResult, JenkinsBuild } from './types';

/** All commit ids referenced by a build (changeSets + SCM lastBuiltRevision). */
export function getBuildCommits(build: JenkinsBuild): string[] {
  const ids: string[] = [];
  for (const cs of build.changeSets ?? []) {
    for (const item of cs.items ?? []) {
      if (item.commitId) ids.push(item.commitId);
    }
  }
  for (const action of build.actions ?? []) {
    const sha = action.lastBuiltRevision?.SHA1;
    if (sha) ids.push(sha);
  }
  return [...new Set(ids)];
}

/** A build parameter value by name, if present. */
export function getBuildParam(build: JenkinsBuild, name: string): unknown {
  for (const action of build.actions ?? []) {
    const param = action.parameters?.find((p) => p.name === name);
    if (param) return param.value;
  }
  return undefined;
}

/**
 * Strip the Git remote/ref prefix off a branch name, returning the local branch.
 * Handles the shapes Jenkins reports: fully-qualified refs (`refs/heads/<b>`,
 * `refs/remotes/<remote>/<b>`, `refs/tags/<t>`) — where the branch itself may
 * contain slashes, e.g. `feature/x` — and the bare remote-tracking form
 * (`origin/<b>`). A bare name with no recognizable prefix is returned unchanged.
 */
function stripRefPrefix(name: string): string {
  const unref = name.replace(/^refs\/(?:heads|remotes\/[^/]+|tags)\//, '');
  if (unref !== name) return unref; // was a fully-qualified ref → fully stripped
  return name.replace(/^[^/]+\//, ''); // bare <remote>/<branch> → drop the remote segment
}

/** The branch a build was built from, from SCM revision data or a BRANCH-ish param. */
export function getBuildBranch(build: JenkinsBuild): string | null {
  for (const action of build.actions ?? []) {
    const name = action.lastBuiltRevision?.branch?.[0]?.name;
    if (name) return stripRefPrefix(name);
  }
  for (const key of ['BRANCH', 'branch', 'GIT_BRANCH', 'BRANCH_NAME']) {
    const value = getBuildParam(build, key);
    if (typeof value === 'string' && value) return stripRefPrefix(value);
  }
  return null;
}

export type StatusFilter = BuildResult | 'success' | 'failure' | 'building';

export interface BuildFilter {
  /** Build result(s). "success"/"failure" are aliases for SUCCESS/FAILURE. */
  status?: StatusFilter | StatusFilter[];
  /** Branch the build was built from (see getBuildBranch). */
  branch?: string;
  /** Commit hash; matched as a prefix against the build's commits. */
  commit?: string;
  /** Whether the build is in progress. */
  building?: boolean;
  /** A build parameter that must equal the given value (e.g. ENV === "stage"). */
  param?: { name: string; value: unknown };
}

function normalizeStatus(status: StatusFilter): StatusFilter {
  if (status === 'success') return 'SUCCESS';
  if (status === 'failure') return 'FAILURE';
  return status;
}

export function filterByStatus(builds: JenkinsBuild[], status: StatusFilter | StatusFilter[]): JenkinsBuild[] {
  const wanted = (Array.isArray(status) ? status : [status]).map(normalizeStatus);
  return builds.filter((b) => wanted.some((w) => (w === 'building' ? b.building === true : b.result === w)));
}

export function filterByBranch(builds: JenkinsBuild[], branch: string): JenkinsBuild[] {
  return builds.filter((b) => getBuildBranch(b) === branch);
}

export function filterByCommit(builds: JenkinsBuild[], commit: string): JenkinsBuild[] {
  const prefix = commit.toLowerCase();
  return builds.filter((b) => getBuildCommits(b).some((id) => id.toLowerCase().startsWith(prefix)));
}

/** Apply any combination of build filters (AND semantics). */
export function filterBuildsBy(builds: JenkinsBuild[], filter: BuildFilter): JenkinsBuild[] {
  let out = builds;
  if (filter.status !== undefined) out = filterByStatus(out, filter.status);
  if (filter.branch !== undefined) out = filterByBranch(out, filter.branch);
  if (filter.commit !== undefined) out = filterByCommit(out, filter.commit);
  if (filter.building !== undefined) out = out.filter((b) => b.building === filter.building);
  if (filter.param) {
    const { name, value } = filter.param;
    out = out.filter((b) => getBuildParam(b, name) === value);
  }
  return out;
}
