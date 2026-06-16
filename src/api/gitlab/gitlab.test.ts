import { describe, expect, test } from 'bun:test';
import { createGitlabClient, projectId } from './index';

function stub(body: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, headers: (init.headers as Record<string, string>) ?? {} });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { client: createGitlabClient({ baseUrl: 'https://gitlab.com', token: 'glpat', fetch: fakeFetch }), calls };
}

describe('projectId', () => {
  test('URL-encodes the full namespace/name path', () => {
    expect(projectId('team/sub/app')).toBe('team%2Fsub%2Fapp');
  });
});

describe('gitlab client', () => {
  test('getProject uses the encoded path and PRIVATE-TOKEN auth', async () => {
    const { client, calls } = stub({ id: 1, name: 'app', path_with_namespace: 'team/app', web_url: 'x' });
    const project = await client.getProject('team/app');
    expect(project.name).toBe('app');
    expect(calls[0].url).toContain('/api/v4/projects/team%2Fapp');
    expect(calls[0].headers['PRIVATE-TOKEN']).toBe('glpat');
  });

  test('getLatestCommit passes ref and per_page=1', async () => {
    const { client, calls } = stub([{ id: 'abc', short_id: 'abc', title: 'fix' }]);
    const commit = await client.getLatestCommit('team/app', { ref: 'main' });
    expect(commit?.id).toBe('abc');
    expect(calls[0].url).toContain('/repository/commits');
    expect(calls[0].url).toContain('ref_name=main');
    expect(calls[0].url).toContain('per_page=1');
  });
});
