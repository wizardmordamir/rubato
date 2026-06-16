import { describe, expect, test } from 'bun:test';
import { ApiError } from '../client';
import { createDynatraceClient } from './index';

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
    client: createDynatraceClient({
      baseUrl: 'https://abc.live.dynatrace.com',
      token: 'dt0c01.SECRET',
      fetch: fakeFetch,
    }),
    calls,
  };
}

describe('dynatrace client', () => {
  test('getProblems hits api/v2/problems with Api-Token auth and returns problems', async () => {
    const { client, calls } = stub({ problems: [{ problemId: 'P-1', title: 'boom', status: 'OPEN' }] });
    const problems = await client.getProblems({ from: 'now-2h', pageSize: 50 });
    expect(problems).toHaveLength(1);
    expect(problems[0].problemId).toBe('P-1');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/api/v2/problems');
    expect(calls[0].url).toContain('from=now-2h');
    expect(calls[0].url).toContain('pageSize=50');
    expect(calls[0].headers.Authorization).toBe('Api-Token dt0c01.SECRET');
  });

  test('queryMetric passes metricSelector and returns the result array', async () => {
    const { client, calls } = stub({ result: [{ metricId: 'builtin:host.cpu.usage', data: [] }] });
    const result = await client.queryMetric({
      metricSelector: 'builtin:host.cpu.usage',
      from: 'now-1h',
      resolution: '1m',
    });
    expect(result).toHaveLength(1);
    expect(result[0].metricId).toBe('builtin:host.cpu.usage');
    expect(calls[0].url).toContain('/api/v2/metrics/query');
    expect(calls[0].url).toContain('metricSelector=builtin%3Ahost.cpu.usage');
    expect(calls[0].url).toContain('resolution=1m');
    expect(calls[0].headers.Authorization).toBe('Api-Token dt0c01.SECRET');
  });

  test('getEntities passes entitySelector and returns the entities array', async () => {
    const { client, calls } = stub({ entities: [{ entityId: 'HOST-1', displayName: 'web-01', type: 'HOST' }] });
    const entities = await client.getEntities({ entitySelector: 'type("HOST")', pageSize: 10 });
    expect(entities).toHaveLength(1);
    expect(entities[0].entityId).toBe('HOST-1');
    expect(calls[0].url).toContain('/api/v2/entities');
    expect(calls[0].url).toContain('entitySelector=type%28%22HOST%22%29');
    expect(calls[0].url).toContain('pageSize=10');
    expect(calls[0].headers.Authorization).toBe('Api-Token dt0c01.SECRET');
  });

  test('throws ApiError on a non-2xx response', async () => {
    const { client } = stub({ error: { code: 401, message: 'Token is invalid' } }, 401);
    await expect(client.getProblems()).rejects.toBeInstanceOf(ApiError);
  });
});
