import { describe, expect, test } from 'bun:test';
import { ApiError } from '../client';
import { consoleApiBase, createOpenshiftClient, resolveOpenshiftBase, resourceApiPath } from './index';

/** A fake fetch that routes by URL substring → JSON body (records calls). */
function router(routes: Array<{ match: string; body: unknown; status?: number }>) {
  const calls: Array<{ url: string; auth?: string }> = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, auth: (init.headers as Record<string, string>)?.Authorization });
    const route = routes.find((r) => url.includes(r.match));
    return new Response(JSON.stringify(route?.body ?? {}), {
      status: route?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const client = createOpenshiftClient({ baseUrl: 'https://api.cluster:6443', token: 'sha256~tok', fetch: fakeFetch });
  return { client, calls };
}

describe('openshift client', () => {
  test('getPodSummary unwraps items, summarizes, and sends a bearer token', async () => {
    const { client, calls } = router([
      {
        match: '/namespaces/prod/pods',
        body: {
          items: [
            {
              metadata: { name: 'ok' },
              status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
            },
            {
              metadata: { name: 'bad' },
              status: {
                phase: 'Running',
                containerStatuses: [
                  { ready: false, restartCount: 4, state: { waiting: { reason: 'ImagePullBackOff' } } },
                ],
              },
            },
          ],
        },
      },
    ]);
    const summary = await client.getPodSummary('prod');
    expect(summary.total).toBe(2);
    expect(summary.running).toBe(2);
    expect(summary.notReady).toBe(1);
    expect(summary.restarts).toBe(4);
    expect(summary.problematic).toEqual([{ name: 'bad', reason: 'ImagePullBackOff' }]);
    expect(calls[0].url).toContain('/api/v1/namespaces/prod/pods');
    expect(calls[0].auth).toBe('Bearer sha256~tok');
  });

  test('getDeployments maps image, replicas, availability, and deploy time', async () => {
    const { client, calls } = router([
      {
        match: '/deployments',
        body: {
          items: [
            {
              metadata: { name: 'web', creationTimestamp: '2026-06-01T10:00:00Z' },
              spec: { replicas: 3, template: { spec: { containers: [{ name: 'web', image: 'quay.io/app:1.2.3' }] } } },
              status: {
                replicas: 3,
                readyReplicas: 3,
                availableReplicas: 3,
                updatedReplicas: 3,
                conditions: [{ type: 'Available', status: 'True' }],
              },
            },
          ],
        },
      },
    ]);
    const deps = await client.getDeployments('prod');
    expect(deps[0]).toMatchObject({
      name: 'web',
      replicas: 3,
      ready: 3,
      available: 3,
      isAvailable: true,
      image: 'quay.io/app:1.2.3',
      createdAt: '2026-06-01T10:00:00Z',
    });
    expect(calls[0].url).toContain('/apis/apps/v1/namespaces/prod/deployments');
  });

  test('getEvents filters by type and sorts most-recent first', async () => {
    const { client } = router([
      {
        match: '/events',
        body: {
          items: [
            {
              metadata: { name: 'e1' },
              type: 'Normal',
              reason: 'Pulled',
              message: 'ok',
              lastTimestamp: '2026-06-01T10:00:00Z',
              involvedObject: { kind: 'Pod', name: 'web' },
            },
            {
              metadata: { name: 'e2' },
              type: 'Warning',
              reason: 'BackOff',
              message: 'crash',
              count: 5,
              lastTimestamp: '2026-06-02T10:00:00Z',
              involvedObject: { kind: 'Pod', name: 'api' },
            },
            {
              metadata: { name: 'e3' },
              type: 'Warning',
              reason: 'Failed',
              message: 'img',
              lastTimestamp: '2026-06-03T10:00:00Z',
              involvedObject: { kind: 'Pod', name: 'db' },
            },
          ],
        },
      },
    ]);
    const events = await client.getEvents('prod', { type: 'Warning' });
    expect(events).toHaveLength(2);
    expect(events[0].reason).toBe('Failed'); // newest first
    expect(events[0].object).toBe('Pod/db');
    expect(events[1]).toMatchObject({ reason: 'BackOff', count: 5 });
  });

  test('a non-2xx response throws a tagged ApiError', async () => {
    const { client } = router([{ match: '/pods', body: { message: 'forbidden' }, status: 403 }]);
    await expect(client.getPods('prod')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('console-proxy base + resource paths (pure)', () => {
  test('consoleApiBase appends /api/kubernetes and trims trailing slashes', () => {
    expect(consoleApiBase('https://console.apps.cluster')).toBe('https://console.apps.cluster/api/kubernetes');
    expect(consoleApiBase('https://console.apps.cluster/')).toBe('https://console.apps.cluster/api/kubernetes');
  });

  test('resourceApiPath routes core vs apps kinds and rejects unknowns', () => {
    expect(resourceApiPath('pod', 'prod', 'web-1')).toBe('api/v1/namespaces/prod/pods/web-1');
    expect(resourceApiPath('Deployment', 'prod', 'web')).toBe('apis/apps/v1/namespaces/prod/deployments/web');
    expect(resourceApiPath('configmaps', 'prod', 'cfg')).toBe('api/v1/namespaces/prod/configmaps/cfg');
    expect(() => resourceApiPath('widget', 'prod', 'x')).toThrow(/Unsupported resource kind/);
  });
});

describe('resolveOpenshiftBase (direct → console fallback)', () => {
  test('uses the direct cluster API when set', () => {
    expect(resolveOpenshiftBase({ directUrl: 'https://api:6443', directToken: 't' })).toEqual({
      baseUrl: 'https://api:6443',
      token: 't',
      via: 'api',
    });
  });

  test('falls back to the console proxy when only the console is set', () => {
    expect(resolveOpenshiftBase({ consoleUrl: 'https://console.apps', consoleToken: 'sess' })).toEqual({
      baseUrl: 'https://console.apps/api/kubernetes',
      token: 'sess',
      via: 'console',
    });
  });

  test('prefers the direct API even when both are set', () => {
    expect(
      resolveOpenshiftBase({
        directUrl: 'https://api:6443',
        directToken: 't',
        consoleUrl: 'https://console.apps',
        consoleToken: 'sess',
      }).via,
    ).toBe('api');
  });

  test('throws a clear error when a URL is set without its token, or nothing is set', () => {
    expect(() => resolveOpenshiftBase({ directUrl: 'https://api:6443' })).toThrow(/OPENSHIFT_TOKEN/);
    expect(() => resolveOpenshiftBase({ consoleUrl: 'https://console.apps' })).toThrow(/OPENSHIFT_CONSOLE_TOKEN/);
    expect(() => resolveOpenshiftBase({})).toThrow(/not configured/);
  });
});

/** A fake fetch that returns text/plain for the logs subresource, JSON otherwise. */
function mixedFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url.includes('/log')) {
      return new Response('line 1\nline 2\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(JSON.stringify({ kind: 'Pod', metadata: { name: 'web-1' }, spec: { nodeName: 'n1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('openshift logs + manifest (via the console proxy base)', () => {
  test('getPodLogs returns text and builds the /log path + query', async () => {
    const { fetchImpl, calls } = mixedFetch();
    const client = createOpenshiftClient({
      baseUrl: consoleApiBase('https://console.apps'),
      token: 'sess',
      fetch: fetchImpl,
    });
    const logs = await client.getPodLogs('prod', 'web-1', { container: 'web', tailLines: 100 });
    expect(logs).toBe('line 1\nline 2\n');
    // Routed through the console proxy (…/api/kubernetes/api/v1/…) with the container/tail query.
    expect(calls[0]).toContain('/api/kubernetes/api/v1/namespaces/prod/pods/web-1/log');
    expect(calls[0]).toContain('container=web');
    expect(calls[0]).toContain('tailLines=100');
  });

  test("getResource returns the raw manifest at the kind's API path", async () => {
    const { fetchImpl, calls } = mixedFetch();
    const client = createOpenshiftClient({
      baseUrl: consoleApiBase('https://console.apps'),
      token: 'sess',
      fetch: fetchImpl,
    });
    const manifest = await client.getResource('prod', 'pod', 'web-1');
    expect(manifest).toMatchObject({ kind: 'Pod', metadata: { name: 'web-1' } });
    expect(calls[0]).toContain('/api/kubernetes/api/v1/namespaces/prod/pods/web-1');
  });
});
