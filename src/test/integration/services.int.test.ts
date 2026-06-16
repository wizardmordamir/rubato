/**
 * Integration: the generic Services catalog through `route()` against the fake
 * upstream — one happy-path operation per catalogued service (datadog, dynatrace,
 * github, gitlab, quay, rancher, harness), plus the param-guard and upstream-error
 * paths. Exercises the real catalog → real `*FromConfig()` client → fake API.
 */

import { describe, expect, test } from 'bun:test';
import type { ServiceInfo, ServiceRunResponse } from '../../shared/types';
import { apiGet, apiPost, useHarness } from '../index';

const h = useHarness();

const runOp = (service: string, operation: string, params: Record<string, string> = {}) =>
  apiPost('/api/services/run', { service, operation, params });

/** One representative happy-path op per service, with the shape we expect back. */
const CASES: Array<{
  service: string;
  operation: string;
  params?: Record<string, string>;
  check: (result: unknown) => void;
}> = [
  { service: 'datadog', operation: 'validate', check: (r) => expect(r).toBe(true) },
  {
    service: 'dynatrace',
    operation: 'getProblems',
    check: (r) => expect((r as Array<{ title: string }>)[0]?.title).toBe('High CPU'),
  },
  {
    service: 'github',
    operation: 'getRepo',
    params: { repo: 'owner/app' },
    check: (r) => expect((r as { full_name: string }).full_name).toBe('owner/app'),
  },
  {
    service: 'gitlab',
    operation: 'getProject',
    params: { project: 'team/app' },
    check: (r) => expect((r as { path_with_namespace: string }).path_with_namespace).toBe('team/app'),
  },
  {
    service: 'quay',
    operation: 'getTags',
    params: { repository: 'team/app' },
    check: (r) => expect((r as Array<{ name: string }>).length).toBeGreaterThan(0),
  },
  {
    service: 'rancher',
    operation: 'getClusters',
    check: (r) => expect((r as Array<{ name: string }>)[0]?.name).toBe('production'),
  },
  {
    service: 'harness',
    operation: 'listPipelines',
    params: { org: 'default', project: 'proj' },
    check: (r) => expect((r as Array<{ identifier: string }>)[0]?.identifier).toBe('pipe-1'),
  },
];

describe('services catalog integration', () => {
  test('GET /api/services reports every service configured', async () => {
    const res = await apiGet('/api/services');
    expect(res.status).toBe(200);
    const services = (await res.json()) as ServiceInfo[];
    for (const name of ['datadog', 'dynatrace', 'github', 'gitlab', 'quay', 'rancher', 'harness']) {
      expect(services.find((s) => s.name === name)?.configured).toBe(true);
    }
  });

  for (const c of CASES) {
    test(`POST /api/services/run ${c.service}/${c.operation} hits the fake and parses`, async () => {
      h.fake.reset();
      const res = await runOp(c.service, c.operation, c.params);
      expect(res.status).toBe(200);
      const { result } = (await res.json()) as ServiceRunResponse;
      c.check(result);
      // The real client reached the fake under this service's prefix.
      expect(h.fake.requests.some((r) => r.service === c.service)).toBe(true);
    });
  }

  test('auth headers differ per service (bearer / private-token / x-api-key / dd-api-key)', async () => {
    h.fake.reset();
    await runOp('github', 'getRepo', { repo: 'owner/app' });
    await runOp('gitlab', 'getProject', { project: 'team/app' });
    await runOp('harness', 'listPipelines', { org: 'default', project: 'proj' });
    await runOp('datadog', 'validate');

    const auth = (svc: string, header: string) => h.fake.requests.find((r) => r.service === svc)?.headers[header];
    expect(auth('github', 'authorization')).toBe('Bearer fake-github');
    expect(auth('gitlab', 'private-token')).toBe('fake-gitlab');
    expect(auth('harness', 'x-api-key')).toBe('fake-harness');
    expect(auth('datadog', 'dd-api-key')).toBe('fake-dd-api');
    // Harness scopes every call to the account.
    expect(h.fake.requests.find((r) => r.service === 'harness')?.query.accountIdentifier).toBe('acct-1');
  });

  test('missing required param is rejected before any network call (400)', async () => {
    h.fake.reset();
    const res = await runOp('github', 'getRepo', {}); // repo is required
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('missing required');
    expect(h.fake.requests).toHaveLength(0);
  });

  test('an upstream error surfaces as a 502', async () => {
    h.fake.reset();
    h.fake.handler = (ctx) => (ctx.service === 'quay' ? ctx.json({ error: 'boom' }, 500) : undefined);
    const res = await runOp('quay', 'getTags', { repository: 'team/app' });
    expect(res.status).toBe(502);
  });
});
