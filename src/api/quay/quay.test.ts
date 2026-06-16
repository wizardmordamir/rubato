import { describe, expect, test } from 'bun:test';
import { createQuayClient, type QuayTag } from './index';

function stub(tags: QuayTag[]) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, headers: (init.headers as Record<string, string>) ?? {} });
    return new Response(JSON.stringify({ tags }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { client: createQuayClient({ baseUrl: 'https://quay.io', token: 't', fetch: fakeFetch }), calls };
}

describe('quay client', () => {
  test('getTags hits the repository tag endpoint with bearer auth, newest first', async () => {
    const { client, calls } = stub([
      { name: 'v1', start_ts: 100 },
      { name: 'v3', start_ts: 300 },
      { name: 'v2', start_ts: 200 },
    ]);
    const tags = await client.getTags('myorg/app', { onlyActive: true });
    expect(tags.map((t) => t.name)).toEqual(['v3', 'v2', 'v1']);
    expect(calls[0].url).toContain('/api/v1/repository/myorg/app/tag/');
    expect(calls[0].url).toContain('onlyActiveTags=true');
    expect(calls[0].headers.Authorization).toBe('Bearer t');
  });

  test('getLatestTag returns the newest; findTags filters', async () => {
    const { client } = stub([
      { name: 'build-12', start_ts: 100 },
      { name: 'build-34', start_ts: 300 },
    ]);
    expect((await client.getLatestTag('o/a'))?.name).toBe('build-34');
    const found = await client.findTags('o/a', (t) => t.name.includes('12'));
    expect(found.map((t) => t.name)).toEqual(['build-12']);
  });
});
