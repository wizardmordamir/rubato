/**
 * Integration: per-app shortcut links through `route()` against the seeded test
 * registry — set/normalize/read-back/clear, and a 404 for an unknown app.
 */

import { describe, expect, test } from 'bun:test';
import type { AppConfig } from '../../lib/apps';
import { apiGet, apiPost, useHarness } from '../index';

useHarness();

describe('app links', () => {
  test('sets + normalizes links, surfaces them on /api/apps, then clears them', async () => {
    const set = await apiPost('/api/apps/app/links', {
      links: [
        { text: '  CI ', href: ' https://ci/job ' }, // trimmed
        { href: 'https://quay.io/x' }, // text defaults to href
        { text: 'bad', href: '' }, // blank href → dropped
      ],
    });
    expect(set.status).toBe(200);
    const updated = (await set.json()) as AppConfig;
    expect(updated.links).toEqual([
      { text: 'CI', href: 'https://ci/job' },
      { text: 'https://quay.io/x', href: 'https://quay.io/x' },
    ]);

    const apps = (await (await apiGet('/api/apps')).json()) as AppConfig[];
    expect(apps.find((a) => a.name === 'app')?.links).toHaveLength(2);

    // Empty links removes the field entirely.
    const cleared = (await (await apiPost('/api/apps/app/links', { links: [] })).json()) as AppConfig;
    expect(cleared.links).toBeUndefined();
  });

  test('unknown app → 404', async () => {
    expect((await apiPost('/api/apps/__no_such_app__/links', { links: [] })).status).toBe(404);
  });
});
