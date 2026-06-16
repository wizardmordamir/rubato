/**
 * Integration: the cross-app .env discovery route through `route()` against the
 * seeded test registry. Writes a real `.env` into a seeded app's dir, then asserts
 * the search finds it by key — and never echoes the file's secret VALUE.
 */

import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../../lib/apps';
import type { EnvDiscoveryResult } from '../../shared/envDiscovery';
import { apiGet, useHarness } from '../index';

useHarness();

describe('env discovery route', () => {
  test('GET /api/env-discovery finds an app by key without leaking values', async () => {
    const apps = (await (await apiGet('/api/apps')).json()) as AppConfig[];
    const app = apps.find((a) => a.name === 'app');
    expect(app).toBeDefined();
    await writeFile(join(app?.absolutePath ?? '', '.env'), 'API_TOKEN=super-secret\nPORT=3000\n');

    const res = await apiGet('/api/env-discovery?q=API_TOKEN&mode=with');
    expect(res.status).toBe(200);
    const r = (await res.json()) as EnvDiscoveryResult;
    const hit = r.apps.find((a) => a.name === 'app');
    expect(hit).toBeDefined();
    expect(hit?.files.some((f) => f.matchedKeys.includes('API_TOKEN'))).toBe(true);
    // KEY names are returned; the secret VALUE never is.
    expect(JSON.stringify(r)).not.toContain('super-secret');
  });

  test('mode=without surfaces apps lacking the key', async () => {
    const apps = (await (await apiGet('/api/apps')).json()) as AppConfig[];
    const app = apps.find((a) => a.name === 'app');
    await writeFile(join(app?.absolutePath ?? '', '.env'), 'ONLY_THIS=1\n');

    const r = (await (await apiGet('/api/env-discovery?q=NOPE_MISSING&mode=without')).json()) as EnvDiscoveryResult;
    // the app has a .env but lacks NOPE_MISSING → it shows up under "without"
    expect(r.apps.find((a) => a.name === 'app')).toBeDefined();
  });
});
