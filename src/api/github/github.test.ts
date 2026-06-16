import { describe, expect, test } from 'bun:test';
import { ApiError } from '../client';
import { createGithubClient } from './index';

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
  return { client: createGithubClient({ baseUrl: 'https://api.github.com', token: 'ghp', fetch: fakeFetch }), calls };
}

describe('github client', () => {
  test('getRepo uses the owner/repo path, bearer auth, and GitHub headers', async () => {
    const { client, calls } = stub({ id: 1, name: 'app', full_name: 'owner/app', html_url: 'x' });
    const repo = await client.getRepo('owner/app');
    expect(repo.full_name).toBe('owner/app');
    expect(calls[0].url).toContain('/repos/owner/app');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.Authorization).toBe('Bearer ghp');
    expect(calls[0].headers.Accept).toBe('application/vnd.github+json');
  });

  test('getCommits passes sha and per_page', async () => {
    const { client, calls } = stub([{ sha: 'abc' }]);
    const commits = await client.getCommits('owner/app', { sha: 'main', perPage: 5 });
    expect(commits[0].sha).toBe('abc');
    expect(calls[0].url).toContain('/repos/owner/app/commits');
    expect(calls[0].url).toContain('sha=main');
    expect(calls[0].url).toContain('per_page=5');
  });

  test('getLatestCommit requests per_page=1 and returns the first commit', async () => {
    const { client, calls } = stub([{ sha: 'abc' }]);
    const commit = await client.getLatestCommit('owner/app', { sha: 'main' });
    expect(commit?.sha).toBe('abc');
    expect(calls[0].url).toContain('per_page=1');
  });

  test('getLatestCommit returns null when there are no commits', async () => {
    const { client } = stub([]);
    expect(await client.getLatestCommit('owner/app')).toBeNull();
  });

  test('getPullRequests defaults to state=open', async () => {
    const { client, calls } = stub([{ id: 1, number: 7, title: 'fix' }]);
    const prs = await client.getPullRequests('owner/app');
    expect(prs[0].number).toBe(7);
    expect(calls[0].url).toContain('/repos/owner/app/pulls');
    expect(calls[0].url).toContain('state=open');
    expect(calls[0].url).toContain('per_page=20');
  });

  test('getPullRequests honors an explicit state', async () => {
    const { client, calls } = stub([]);
    await client.getPullRequests('owner/app', { state: 'closed', perPage: 3 });
    expect(calls[0].url).toContain('state=closed');
    expect(calls[0].url).toContain('per_page=3');
  });

  test('getWorkflowRuns unwraps the workflow_runs array', async () => {
    const { client, calls } = stub({ total_count: 1, workflow_runs: [{ id: 42, status: 'completed' }] });
    const runs = await client.getWorkflowRuns('owner/app', { perPage: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(42);
    expect(calls[0].url).toContain('/repos/owner/app/actions/runs');
    expect(calls[0].url).toContain('per_page=10');
  });

  test('a non-2xx response throws an ApiError tagged with the client name', async () => {
    const { client } = stub({ message: 'Not Found' }, 404);
    let error: unknown;
    try {
      await client.getRepo('owner/missing');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).client).toBe('github');
    expect((error as ApiError).status).toBe(404);
  });
});
