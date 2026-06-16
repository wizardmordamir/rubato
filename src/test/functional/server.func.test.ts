/**
 * Functional: the REAL `rubato-serve` running as a subprocess (the same binary a
 * user runs), pointed at a seeded throwaway home + fake upstream, exercised over
 * HTTP. This is the full stack — process boot, request routing, config/registry
 * loading, and a live client call out to the fake — that the in-process
 * integration tests can't cover. `useFunctional()` boots/tears it all down.
 */

import { describe, expect, test } from 'bun:test';
import type { SplunkRunResponse } from '../../shared/types';
import { useFunctional } from '../index';

const h = useFunctional();

describe('rubato-serve functional', () => {
  test('GET /api/health is ok with commands loaded', async () => {
    const res = await h.server.request('/api/health');
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { ok: boolean; commands: number };
    expect(body.ok).toBe(true);
    expect(body.commands).toBeGreaterThan(0);
  });

  test('GET /api/apps serves the seeded registry', async () => {
    const res = await h.server.request('/api/apps');
    expect(res.status).toBe(200);
    const apps = (await res.json()) as Array<{ name: string }>;
    const names = apps.map((a) => a.name);
    expect(names).toContain('app');
    expect(names).toContain('billing');
  });

  test('POST /api/splunk/run goes server → real client → fake upstream', async () => {
    h.fake.reset();
    const res = await h.server.request('/api/splunk/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'app', env: 'prod' }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as SplunkRunResponse;
    expect(out.count).toBe(2);

    // The server's subprocess really reached the fake (which runs in this process).
    const req = h.fake.requests.find((r) => r.service === 'splunk');
    expect(req?.path).toBe('services/search/jobs/export');
    expect(req?.headers.authorization).toBe('Bearer fake-splunk');
  });
});
