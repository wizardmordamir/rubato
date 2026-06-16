import { describe, expect, test } from 'bun:test';
import { ApiError } from '../client';
import { createRancherClient } from './index';

function stub(body: unknown, status = 200) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers: (init.headers as Record<string, string>) ?? {},
    });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return {
    client: createRancherClient({ baseUrl: 'https://rancher.example.com', token: 'token-abc:xyz', fetch: fakeFetch }),
    calls,
  };
}

describe('rancher client', () => {
  test('getClusters unwraps the data envelope and sends a bearer token', async () => {
    const { client, calls } = stub({ data: [{ id: 'c-1', name: 'prod', state: 'active' }] });
    const clusters = await client.getClusters();
    expect(clusters).toHaveLength(1);
    expect(clusters[0].name).toBe('prod');
    expect(calls[0].url).toContain('/v3/clusters');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.Authorization).toBe('Bearer token-abc:xyz');
  });

  test('getProjects unwraps the data envelope', async () => {
    const { client, calls } = stub({ data: [{ id: 'c-1:p-1', name: 'default', state: 'active' }] });
    const projects = await client.getProjects();
    expect(projects[0].id).toBe('c-1:p-1');
    expect(calls[0].url).toContain('/v3/projects');
  });

  test('getNodes filters by clusterId when provided', async () => {
    const { client, calls } = stub({ data: [{ id: 'n-1', name: 'node-1', state: 'active' }] });
    const nodes = await client.getNodes({ clusterId: 'c-1' });
    expect(nodes[0].name).toBe('node-1');
    expect(calls[0].url).toContain('/v3/nodes');
    expect(calls[0].url).toContain('clusterId=c-1');
  });

  test('getNodes omits the clusterId query when not given', async () => {
    const { client, calls } = stub({ data: [] });
    await client.getNodes();
    expect(calls[0].url).toContain('/v3/nodes');
    expect(calls[0].url).not.toContain('clusterId');
  });

  test('getWorkloads puts the projectId straight into the path', async () => {
    const { client, calls } = stub({ data: [{ id: 'w-1', name: 'web', state: 'active' }] });
    const workloads = await client.getWorkloads({ projectId: 'c-abc:p-xyz' });
    expect(workloads[0].name).toBe('web');
    expect(calls[0].url).toContain('/v3/project/c-abc:p-xyz/workloads');
  });

  test('a non-2xx response throws a tagged ApiError', async () => {
    const { client } = stub({ message: 'unauthorized' }, 401);
    await expect(client.getClusters()).rejects.toBeInstanceOf(ApiError);
  });
});
