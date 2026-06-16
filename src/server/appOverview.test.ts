import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JenkinsBuild } from '../api/jenkins';
import type { OpenshiftAppApi } from '../lib/appApis';
import type { AppConfig } from '../lib/apps';
import { git } from '../lib/git';
import { getAppDeploy, getAppJenkins, getAppSources, resolveNamespace, toBuildRow } from './appOverview';

const asApp = (over: Partial<AppConfig> & { absolutePath: string }): AppConfig =>
  ({ name: 'x', group: null, aliases: [], ...over }) as AppConfig;

describe('toBuildRow', () => {
  test('flattens a raw build; branch/commit absent → null', () => {
    const build = {
      number: 42,
      url: 'https://jenkins/job/x/42/',
      result: 'SUCCESS',
      building: false,
      timestamp: 1_700_000_000_000,
      duration: 1234,
    } as unknown as JenkinsBuild;
    const row = toBuildRow(build);
    expect(row.number).toBe(42);
    expect(row.url).toBe('https://jenkins/job/x/42/');
    expect(row.building).toBe(false);
    expect(row.branch).toBeNull();
    expect(row.commit).toBeNull();
    expect(row.timestamp).toBe(1_700_000_000_000);
    expect(row.durationMs).toBe(1234);
    expect(typeof row.status).toBe('string');
  });
});

describe('resolveNamespace', () => {
  const api = {
    name: 'openshift',
    namespace: 'svc-default',
    namespaces: { prod: 'svc-prod', dev: 'svc-dev' },
  } as OpenshiftAppApi;
  test('per-env override, default fallback, first-value, and none', () => {
    expect(resolveNamespace(api, 'prod')).toBe('svc-prod');
    expect(resolveNamespace(api, 'missing')).toBe('svc-default');
    expect(resolveNamespace({ name: 'openshift', namespaces: { dev: 'd' } } as OpenshiftAppApi, undefined)).toBe('d');
    expect(resolveNamespace({ name: 'openshift' } as OpenshiftAppApi, undefined)).toBeUndefined();
  });
});

describe('getAppSources', () => {
  test('non-git dir + declared apis → git:false, apis reflected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rubato-src-'));
    const sources = await getAppSources(
      asApp({ absolutePath: dir, apis: [{ name: 'jenkins' }, { name: 'quay' }] as any }),
    );
    expect(sources).toEqual({ git: false, jenkins: true, quay: true, openshift: false, gitlab: false, github: false });
  });

  test('git repo + github cloneUrl → git:true, github:true', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rubato-src-git-'));
    await git(dir, ['init', '-q']);
    const sources = await getAppSources(asApp({ absolutePath: dir, cloneUrl: 'https://github.com/org/repo.git' }));
    expect(sources.git).toBe(true);
    expect(sources.github).toBe(true);
    expect(sources.jenkins).toBe(false);
  });
});

describe('graceful gating (no creds / no api)', () => {
  test('getAppJenkins with no jenkins config → ok:false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rubato-jk-'));
    expect(await getAppJenkins(asApp({ absolutePath: dir }))).toEqual({
      ok: false,
      builds: [],
      error: 'no jenkins config',
    });
  });

  test('getAppDeploy with no creds → ok:true, configured:false (never errors)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rubato-dep-'));
    const res = await getAppDeploy(
      asApp({ absolutePath: dir, apis: [{ name: 'quay', repository: 'org/app' }] as any }),
    );
    expect(res.ok).toBe(true);
    expect(res.configured).toBe(false);
  });
});
