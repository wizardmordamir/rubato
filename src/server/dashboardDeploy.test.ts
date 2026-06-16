import { describe, expect, test } from 'bun:test';
import type { QuayClient, QuayTag } from '../api/quay';
import type { AppConfig } from '../lib/apps';
import type { CollectedRecord, DeployClients } from '../lib/deploy/collect';
import { collectDeploy, toDashboardDeploy } from './dashboardDeploy';

const app = (over: Partial<AppConfig> & { name: string }): AppConfig => ({
  absolutePath: `/code/${over.name}`,
  dirName: over.name,
  group: null,
  aliases: [],
  ...over,
});

describe('toDashboardDeploy', () => {
  test('maps a quay tag (+ jenkins enrichment) to the deploy cell', () => {
    const rec: CollectedRecord = {
      app: app({ name: 'a' }),
      label: 'team/a',
      quay: {
        tag: { name: '1.2.3', manifest_digest: 'sha256:DEADbeef' } as QuayTag,
        version: '1.2.3',
        sha256: 'deadbeef',
      },
      jenkins: {
        build: { number: 99, timestamp: 1_700_000_000_000 } as never,
        number: 99,
        status: 'SUCCESS',
        branch: null,
        commit: 'abc1234def',
      },
      errors: [],
    };
    const d = toDashboardDeploy(rec, 'stage');
    expect(d.available).toBe(true);
    expect(d.version).toBe('1.2.3');
    expect(d.imageSha).toBe('deadbeef');
    expect(d.imageDigest).toBe('sha256:DEADbeef');
    expect(d.commit).toBe('abc1234def'); // completes version↔sha↔commit
    expect(d.env).toBe('stage');
    expect(d.buildNumber).toBe(99);
    expect(d.publishedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  test('no quay/jenkins → unavailable; a soft error is surfaced', () => {
    expect(toDashboardDeploy({ app: app({ name: 'a' }), label: 'a', errors: [] }).available).toBe(false);
    const withErr = toDashboardDeploy({ app: app({ name: 'a' }), label: 'a', errors: ['quay: 404'] });
    expect(withErr.available).toBe(false);
    expect(withErr.error).toBe('quay: 404');
  });
});

describe('collectDeploy', () => {
  const apps = [app({ name: 'a', apis: [{ name: 'quay', repository: 'team/a' }] })];

  test('uses injected clients to resolve the latest published image', async () => {
    const quay = {
      getLatestTag: async (_repo: string): Promise<QuayTag> =>
        ({ name: '9.9.9', manifest_digest: 'sha256:cafe' }) as QuayTag,
    } as unknown as QuayClient;
    const { configured, byApp } = await collectDeploy(apps, { quay } as DeployClients);
    expect(configured).toBe(true);
    expect(byApp.get('a')).toMatchObject({ available: true, version: '9.9.9', imageSha: 'cafe' });
  });

  test('no clients configured → configured:false and an empty map (no creds path)', async () => {
    const { configured, byApp } = await collectDeploy(apps, {} as DeployClients);
    expect(configured).toBe(false);
    expect(byApp.size).toBe(0);
  });
});
