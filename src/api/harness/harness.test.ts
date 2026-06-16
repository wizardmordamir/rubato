import { describe, expect, test } from 'bun:test';
import { ApiError } from '../client';
import { createHarnessClient } from './index';

function stub(body: unknown, status = 200) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers: (init.headers as Record<string, string>) ?? {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return {
    client: createHarnessClient({
      baseUrl: 'https://app.harness.io',
      apiKey: 'pat.abc',
      accountId: 'acct123',
      fetch: fakeFetch,
    }),
    calls,
  };
}

describe('harness client', () => {
  test('listPipelines POSTs the filter and unwraps data.content', async () => {
    const { client, calls } = stub({ data: { content: [{ identifier: 'p1', name: 'Pipe One' }] } });
    const pipelines = await client.listPipelines({ org: 'default', project: 'demo', size: 10 });

    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].identifier).toBe('p1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/pipeline/api/pipelines/list');
    expect(calls[0].headers['x-api-key']).toBe('pat.abc');
    expect(calls[0].url).toContain('accountIdentifier=acct123');
    expect(calls[0].url).toContain('orgIdentifier=default');
    expect(calls[0].url).toContain('projectIdentifier=demo');
    expect(calls[0].url).toContain('size=10');
    expect(calls[0].body).toEqual({ filterType: 'PipelineSetup' });
  });

  test('listPipelines defaults size to 25 and returns [] when content is absent', async () => {
    const { client, calls } = stub({ data: {} });
    const pipelines = await client.listPipelines({ org: 'default', project: 'demo' });

    expect(pipelines).toEqual([]);
    expect(calls[0].url).toContain('size=25');
  });

  test('getExecutions POSTs the execution filter and unwraps data.content', async () => {
    const { client, calls } = stub({ data: { content: [{ identifier: 'e1', name: 'Exec One' }] } });
    const executions = await client.getExecutions({ org: 'default', project: 'demo' });

    expect(executions[0].identifier).toBe('e1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/pipeline/api/pipelines/execution/summary');
    expect(calls[0].url).toContain('accountIdentifier=acct123');
    expect(calls[0].url).toContain('size=25');
    expect(calls[0].body).toEqual({ filterType: 'PipelineExecution' });
  });

  test('getServices GETs servicesV2 with the account + scope query', async () => {
    const { client, calls } = stub({ data: { content: [{ identifier: 's1', name: 'Svc One' }] } });
    const services = await client.getServices({ org: 'default', project: 'demo' });

    expect(services[0].identifier).toBe('s1');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/ng/api/servicesV2');
    expect(calls[0].headers['x-api-key']).toBe('pat.abc');
    expect(calls[0].url).toContain('accountIdentifier=acct123');
    expect(calls[0].url).toContain('orgIdentifier=default');
    expect(calls[0].url).toContain('projectIdentifier=demo');
  });

  test('getServices returns [] when data.content is absent', async () => {
    const { client } = stub({ data: {} });
    expect(await client.getServices({ org: 'default', project: 'demo' })).toEqual([]);
  });

  test('a non-2xx response throws ApiError', async () => {
    const { client } = stub({ message: 'forbidden' }, 403);
    await expect(client.listPipelines({ org: 'default', project: 'demo' })).rejects.toBeInstanceOf(ApiError);
  });
});
