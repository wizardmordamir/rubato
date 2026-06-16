import { describe, expect, test } from 'bun:test';
import { ApiError } from '../client';
import { createDatadogClient } from './index';

function stub(body: unknown, status = 200) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({
      url,
      method: (init.method as string) ?? 'GET',
      headers: (init.headers as Record<string, string>) ?? {},
      body: init.body as string | undefined,
    });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const client = createDatadogClient({
    baseUrl: 'https://api.datadoghq.com',
    apiKey: 'ddapi',
    appKey: 'ddapp',
    fetch: fakeFetch,
  });
  return { client, calls };
}

describe('datadog client', () => {
  test('validate hits api/v1/validate with the DD-* headers and returns valid', async () => {
    const { client, calls } = stub({ valid: true });
    const ok = await client.validate();
    expect(ok).toBe(true);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/api/v1/validate');
    expect(calls[0].headers['DD-API-KEY']).toBe('ddapi');
    expect(calls[0].headers['DD-APPLICATION-KEY']).toBe('ddapp');
  });

  test('searchLogs POSTs the filter/page body and returns the data array', async () => {
    const { client, calls } = stub({
      data: [
        { id: '1', type: 'log' },
        { id: '2', type: 'log' },
      ],
    });
    const logs = await client.searchLogs({ query: 'service:web status:error', limit: 10 });
    expect(logs.map((l) => l.id)).toEqual(['1', '2']);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/api/v2/logs/events/search');
    expect(calls[0].headers['DD-API-KEY']).toBe('ddapi');
    expect(JSON.parse(calls[0].body as string)).toEqual({
      filter: { query: 'service:web status:error', from: 'now-15m', to: 'now' },
      page: { limit: 10 },
    });
  });

  test('searchLogs applies default from/to/limit', async () => {
    const { client, calls } = stub({ data: [] });
    await client.searchLogs({ query: '*' });
    expect(JSON.parse(calls[0].body as string)).toEqual({
      filter: { query: '*', from: 'now-15m', to: 'now' },
      page: { limit: 50 },
    });
  });

  test('queryMetrics GETs api/v1/query with query params and returns series', async () => {
    const { client, calls } = stub({ series: [{ metric: 'system.cpu.user' }] });
    const series = await client.queryMetrics({ query: 'avg:system.cpu.user{*}', from: 1000, to: 2000 });
    expect(series[0].metric).toBe('system.cpu.user');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/api/v1/query');
    expect(calls[0].url).toContain('query=avg%3Asystem.cpu.user%7B*%7D');
    expect(calls[0].url).toContain('from=1000');
    expect(calls[0].url).toContain('to=2000');
  });

  test('a non-2xx response throws a tagged ApiError', async () => {
    const { client } = stub({ errors: ['Forbidden'] }, 403);
    await expect(client.validate()).rejects.toBeInstanceOf(ApiError);
  });
});
