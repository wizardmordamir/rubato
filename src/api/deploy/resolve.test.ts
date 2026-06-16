import { describe, expect, test } from 'bun:test';
import type { JenkinsClient } from '../jenkins';
import type { JenkinsBuild } from '../jenkins/types';
import type { QuayClient, QuayTag } from '../quay';
import { effectiveVersionStrategy, resolveBuildForVersion, resolveQuayTagForVersion } from './resolve';

const build = (number: number, over: Partial<JenkinsBuild> = {}): JenkinsBuild => ({
  number,
  url: `u/${number}`,
  result: 'SUCCESS',
  building: false,
  timestamp: 0,
  ...over,
});

function jenkinsStub(builds: JenkinsBuild[]): JenkinsClient {
  return { getBuilds: async () => builds } as unknown as JenkinsClient;
}

function quayStub(tags: QuayTag[]): { client: QuayClient; opts: unknown[] } {
  const opts: unknown[] = [];
  const client = {
    getTags: async (_repo: string, o: unknown) => {
      opts.push(o);
      return tags;
    },
  } as unknown as QuayClient;
  return { client, opts };
}

describe('resolveQuayTagForVersion', () => {
  test('returns the exactly-named tag and queries including expired tags', async () => {
    const { client, opts } = quayStub([{ name: '1.1.13.739', manifest_digest: 'sha256:a' }]);
    const tag = await resolveQuayTagForVersion(client, 'team/my-app', '1.1.13.739');
    expect(tag?.manifest_digest).toBe('sha256:a');
    expect(opts[0]).toMatchObject({ tag: '1.1.13.739', onlyActive: false });
  });

  test('returns null when no tag has that exact name', async () => {
    const { client } = quayStub([{ name: '1.1.13.738' }]);
    expect(await resolveQuayTagForVersion(client, 'r', '1.1.13.739')).toBeNull();
  });
});

describe('resolveBuildForVersion', () => {
  test('matches via embedded version (param) before the number fallback', async () => {
    const builds = [
      build(740, { actions: [{ _class: 'p', parameters: [{ name: 'IMAGE_VERSION', value: '1.1.13.739' }] }] }),
      build(739),
    ];
    const res = await resolveBuildForVersion(jenkinsStub(builds), 'job/x', '1.1.13.739', {
      strategy: effectiveVersionStrategy({
        name: 'jenkins',
        versionStrategy: { source: 'param', param: 'IMAGE_VERSION' },
      }),
    });
    expect(res.strategy).toBe('embedded');
    expect(res.build?.number).toBe(740);
  });

  test('falls back to build-number heuristic (739) and flags it', async () => {
    const res = await resolveBuildForVersion(jenkinsStub([build(740), build(739)]), 'job/x', '1.1.13.739');
    expect(res.strategy).toBe('buildNumber');
    expect(res.build?.number).toBe(739);
  });

  test('returns none when nothing matches and the fallback is disabled', async () => {
    const res = await resolveBuildForVersion(jenkinsStub([build(500)]), 'job/x', '1.1.13.739', {
      strategy: effectiveVersionStrategy({ name: 'jenkins', versionStrategy: { buildNumberFallback: false } }),
    });
    expect(res).toEqual({ build: null, strategy: 'none' });
  });
});

describe('effectiveVersionStrategy', () => {
  test('per-app overrides global, with defaults', () => {
    expect(
      effectiveVersionStrategy(
        { name: 'jenkins', versionStrategy: { source: 'param', param: 'V' } },
        { versionStrategy: { source: 'displayName', buildNumberFallback: false } },
      ),
    ).toEqual({ source: 'param', param: 'V', buildNumberFallback: false });
  });
});
