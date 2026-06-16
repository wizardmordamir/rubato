/**
 * Integration: the Splunk surface end-to-end through the real `route()` handler,
 * against a fake Splunk upstream. Exercises the no-network build paths and the
 * networked run path (real splunkFromConfig → real client → fake export endpoint).
 */

import { describe, expect, test } from 'bun:test';
import type { SplunkAppInfo, SplunkQueryResponse, SplunkRunResponse, SplunkStatus } from '../../shared/types';
import { apiGet, apiPost, useHarness } from '../index';

const h = useHarness();

describe('splunk integration', () => {
  test('GET /api/splunk/apps lists apps carrying a splunk config', async () => {
    const res = await apiGet('/api/splunk/apps');
    expect(res.status).toBe(200);
    const apps = (await res.json()) as SplunkAppInfo[];
    const app = apps.find((a) => a.app === 'app');
    expect(app).toBeDefined();
    expect(app?.appId).toBe('app');
    expect(app?.index).toBe('main');
    expect(app?.envs).toContain('prod');
  });

  test('GET /api/splunk/status reports configured when URL + token are set', async () => {
    const status = (await (await apiGet('/api/splunk/status')).json()) as SplunkStatus;
    expect(status.configured).toBe(true);
  });

  test('POST /api/splunk/query builds the query string (no network)', async () => {
    const res = await apiPost('/api/splunk/query', { app: 'app', env: 'prod' });
    expect(res.status).toBe(200);
    const built = (await res.json()) as SplunkQueryResponse;
    expect(built.query).toContain('index=main');
    expect(built.query).toContain('dom IN("app-prod")');
    expect(built.missing).toEqual([]);
    expect(h.fake.requests.filter((r) => r.service === 'splunk')).toHaveLength(0);
  });

  test('POST /api/splunk/run executes against the fake and returns rows', async () => {
    h.fake.reset();
    const res = await apiPost('/api/splunk/run', { app: 'app', env: 'prod' });
    expect(res.status).toBe(200);
    const out = (await res.json()) as SplunkRunResponse;
    expect(out.count).toBe(2);
    expect(out.fields).toContain('status');
    expect(out.rows.map((r) => r.status)).toEqual(['200', '500']);

    const req = h.fake.requests.find((r) => r.service === 'splunk');
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('services/search/jobs/export');
    expect(req?.headers.authorization).toBe('Bearer fake-splunk');
    expect(String((req?.parsed as Record<string, string>)?.search)).toContain('dom IN("app-prod")');
  });

  test('POST /api/splunk/run on a custom query missing vars is refused (400)', async () => {
    h.fake.reset();
    const res = await apiPost('/api/splunk/run', { domain: '${app}-${env}' });
    expect(res.status).toBe(400);
    expect(h.fake.requests.filter((r) => r.service === 'splunk')).toHaveLength(0);
  });

  test('POST /api/splunk/run surfaces a Splunk error as a failure', async () => {
    h.fake.reset();
    h.fake.handler = (ctx) =>
      ctx.service === 'splunk'
        ? ctx.text(`${JSON.stringify({ messages: [{ type: 'FATAL', text: 'search quota exceeded' }] })}\n`)
        : undefined;
    const res = await apiPost('/api/splunk/run', { app: 'app', env: 'prod' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Canonical envelope: the message lives at error.message.
    const body = (await res.json()) as { error: { message?: string } };
    expect(body.error.message).toContain('quota');
  });
});
