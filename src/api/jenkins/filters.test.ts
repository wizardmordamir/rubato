import { describe, expect, test } from 'bun:test';
import {
  filterBuildsBy,
  filterByCommit,
  filterByStatus,
  getBuildBranch,
  getBuildCommits,
  getBuildParam,
} from './filters';
import type { JenkinsBuild } from './types';

function build(over: Partial<JenkinsBuild> & { number: number }): JenkinsBuild {
  return { url: `https://j/${over.number}`, result: 'SUCCESS', building: false, timestamp: over.number, ...over };
}

const builds: JenkinsBuild[] = [
  build({
    number: 3,
    result: 'FAILURE',
    actions: [
      { parameters: [{ name: 'ENV', value: 'stage' }] },
      { lastBuiltRevision: { SHA1: 'abc123', branch: [{ name: 'origin/main' }] } },
    ],
  }),
  build({
    number: 2,
    result: 'SUCCESS',
    changeSets: [{ items: [{ commitId: 'deadbeef' }, { commitId: 'cafef00d' }] }],
    actions: [{ parameters: [{ name: 'ENV', value: 'dev' }] }],
  }),
  build({ number: 1, result: 'SUCCESS', building: true }),
];

describe('extractors', () => {
  test('getBuildCommits gathers changeSet + lastBuiltRevision shas', () => {
    expect(getBuildCommits(builds[1])).toEqual(['deadbeef', 'cafef00d']);
    expect(getBuildCommits(builds[0])).toEqual(['abc123']);
  });

  test('getBuildBranch strips the remote prefix', () => {
    expect(getBuildBranch(builds[0])).toBe('main');
    expect(getBuildBranch(builds[1])).toBeNull();
  });

  const branchFromRevision = (name: string) =>
    getBuildBranch(build({ number: 9, actions: [{ lastBuiltRevision: { branch: [{ name }] } }] }));

  test('getBuildBranch handles fully-qualified ref shapes Jenkins reports', () => {
    // The non-greedy strip used to drop only the first segment for these.
    expect(branchFromRevision('refs/remotes/origin/main')).toBe('main');
    expect(branchFromRevision('refs/heads/main')).toBe('main');
    // A branch name that itself contains slashes must survive intact.
    expect(branchFromRevision('refs/remotes/origin/feature/login')).toBe('feature/login');
    expect(branchFromRevision('origin/feature/login')).toBe('feature/login');
    expect(branchFromRevision('refs/tags/v1.2.3')).toBe('v1.2.3');
    // A bare branch name with no prefix is returned unchanged.
    expect(branchFromRevision('main')).toBe('main');
  });

  test('getBuildBranch falls back to a BRANCH-ish param, prefix-stripped', () => {
    const fromParam = (key: string, value: string) =>
      getBuildBranch(build({ number: 8, actions: [{ parameters: [{ name: key, value }] }] }));
    expect(fromParam('GIT_BRANCH', 'refs/remotes/origin/release')).toBe('release');
    expect(fromParam('BRANCH_NAME', 'develop')).toBe('develop');
    expect(fromParam('branch', 'origin/main')).toBe('main');
  });

  test('getBuildParam reads parameters', () => {
    expect(getBuildParam(builds[0], 'ENV')).toBe('stage');
    expect(getBuildParam(builds[0], 'NOPE')).toBeUndefined();
  });
});

describe('filters', () => {
  test('filterByStatus with aliases and arrays', () => {
    expect(filterByStatus(builds, 'success').map((b) => b.number)).toEqual([2, 1]);
    expect(filterByStatus(builds, ['failure', 'building']).map((b) => b.number)).toEqual([3, 1]);
  });

  test('filterByCommit matches by prefix', () => {
    expect(filterByCommit(builds, 'dead').map((b) => b.number)).toEqual([2]);
    expect(filterByCommit(builds, 'ABC').map((b) => b.number)).toEqual([3]);
  });

  test('filterBuildsBy combines filters (AND)', () => {
    expect(
      filterBuildsBy(builds, { status: 'success', param: { name: 'ENV', value: 'dev' } }).map((b) => b.number),
    ).toEqual([2]);
    expect(filterBuildsBy(builds, { branch: 'main' }).map((b) => b.number)).toEqual([3]);
    expect(filterBuildsBy(builds, { building: true }).map((b) => b.number)).toEqual([1]);
  });
});
