import { describe, expect, test } from 'bun:test';
import type { AppConfig } from './apps';
import { appDeployPipelines, deployApps } from './deployApps';

const app = (over: Partial<AppConfig>): AppConfig => ({
  name: 'x',
  absolutePath: '/code/x',
  dirName: 'x',
  group: null,
  aliases: [],
  ...over,
});

describe('appDeployPipelines', () => {
  test('detects a jenkins api integration', () => {
    expect(appDeployPipelines(app({ apis: [{ name: 'jenkins', project: 'Deploys/x' }] }))).toEqual(['jenkins']);
  });

  test('detects a harness free-form tag', () => {
    expect(appDeployPipelines(app({ tags: ['Harness'] }))).toEqual(['harness']);
  });

  test('detects both, in canonical order', () => {
    expect(appDeployPipelines(app({ apis: [{ name: 'jenkins' }], tags: ['harness'] }))).toEqual(['jenkins', 'harness']);
  });

  test('empty when the app neither deploys via jenkins nor harness', () => {
    expect(appDeployPipelines(app({ apis: [{ name: 'quay', repository: 'team/x' }], db: ['mongodb'] }))).toEqual([]);
  });
});

describe('deployApps', () => {
  test('keeps only jenkins/harness apps, sorted by name, with their pipelines', () => {
    const apps = [
      app({ name: 'zeta', apis: [{ name: 'jenkins' }] }),
      app({ name: 'alpha', tags: ['harness'] }),
      app({ name: 'plain', apis: [{ name: 'quay', repository: 'team/plain' }] }),
      app({ name: 'both', apis: [{ name: 'jenkins' }], tags: ['harness'], group: 'core' }),
    ];
    expect(deployApps(apps)).toEqual([
      { name: 'alpha', group: null, deploysVia: ['harness'] },
      { name: 'both', group: 'core', deploysVia: ['jenkins', 'harness'] },
      { name: 'zeta', group: null, deploysVia: ['jenkins'] },
    ]);
  });

  test('excludes missing apps even when they deploy', () => {
    const apps = [
      app({ name: 'gone', apis: [{ name: 'jenkins' }], missing: true }),
      app({ name: 'live', tags: ['harness'] }),
    ];
    expect(deployApps(apps).map((a) => a.name)).toEqual(['live']);
  });

  test('empty registry → empty list', () => {
    expect(deployApps([])).toEqual([]);
  });
});
