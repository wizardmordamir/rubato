import { describe, expect, test } from 'bun:test';
import type { QuayClient, QuayTag } from '../../api/quay';
import type { AppConfig } from '../apps';
import { checkImageList } from './checkImages';
import type { ImageShaEntry } from './parseList';

const app = (over: Partial<AppConfig>): AppConfig =>
  ({ name: 'x', absolutePath: '/x', dirName: 'x', group: null, aliases: [], ...over }) as AppConfig;

const apps = [
  app({
    name: 'web-monitoring',
    dirName: 'web-monitoring',
    apis: [{ name: 'quay', repository: 'team/my-monitor' }],
  }),
];

function quayStub(tags: QuayTag[]): QuayClient {
  return { getTags: async () => tags } as unknown as QuayClient;
}

const entry = (over: Partial<ImageShaEntry>): ImageShaEntry => ({ sha256: 'a'.repeat(64), sourceLine: 1, ...over });

describe('checkImageList', () => {
  test("FOUND when a tag's digest matches", async () => {
    const quay = quayStub([{ name: '1.6.3.701', manifest_digest: `sha256:${'a'.repeat(64)}` }]);
    const [r] = await checkImageList([entry({ app: 'team/my-monitor', version: '1.6.3.701' })], apps, quay);
    expect(r.status).toBe('FOUND');
    expect(r.tag).toBe('1.6.3.701');
  });

  test('MISSING when no tag carries the digest', async () => {
    const quay = quayStub([{ name: '1.6.3.700', manifest_digest: 'sha256:other' }]);
    const [r] = await checkImageList([entry({ app: 'web-monitoring' })], apps, quay);
    expect(r.status).toBe('MISSING');
  });

  test('SKIPPED when the line has no app context', async () => {
    const [r] = await checkImageList([entry({})], apps, quayStub([]));
    expect(r.status).toBe('SKIPPED');
    expect(r.note).toContain('no app context');
  });

  test('SKIPPED when Quay is not configured', async () => {
    const [r] = await checkImageList([entry({ app: 'web-monitoring' })], apps, null);
    expect(r.status).toBe('SKIPPED');
    expect(r.note).toContain('Quay not configured');
  });
});
