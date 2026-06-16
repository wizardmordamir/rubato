import { describe, expect, test } from 'bun:test';
import { createRallyClient, type RallyArtifact } from '.';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** A fake Rally WSAPI: queries return QueryResult, POSTs return OperationResult. */
function fake(opts: { story?: RallyArtifact; task?: RallyArtifact } = {}) {
  const calls: Call[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      url,
      method,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const u = new URL(url);
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

    if (u.pathname.endsWith('/hierarchicalrequirement'))
      return json({ QueryResult: { Results: opts.story ? [opts.story] : [] } });
    if (u.pathname.endsWith('/task') && method === 'GET')
      return json({ QueryResult: { Results: opts.task ? [opts.task] : [] } });
    if (/\/task\/\d+$/.test(u.pathname) && method === 'POST') {
      const sent = init?.body ? (JSON.parse(init.body as string) as { Task: Record<string, unknown> }) : { Task: {} };
      return json({ OperationResult: { Object: { ObjectID: 99, FormattedID: 'TA456', ...sent.Task }, Errors: [] } });
    }
    return json({ OperationResult: { Errors: ['unexpected'] } });
  }) as unknown as typeof fetch;

  return {
    client: createRallyClient({
      baseUrl: 'https://rally.test/slm/webservice/v2.0',
      apiKey: 'key123',
      fetch: fakeFetch,
    }),
    calls,
  };
}

describe('rally client', () => {
  test('getStory / getTask query by FormattedID and send the ZSESSIONID header', async () => {
    const { client, calls } = fake({
      story: { ObjectID: 1, FormattedID: 'US123', State: 'In-Progress' },
      task: { ObjectID: 99, FormattedID: 'TA456', State: 'Defined' },
    });
    expect((await client.getStory('US123'))?.FormattedID).toBe('US123');
    expect((await client.getTask('TA456'))?.State).toBe('Defined');
    expect(calls[0].url).toContain('/hierarchicalrequirement');
    expect(calls[0].url).toContain('US123'); // FormattedID is in the query
    expect(calls[0].headers.ZSESSIONID).toBe('key123');
  });

  test('getTask returns null when nothing matches', async () => {
    const { client } = fake({});
    expect(await client.getTask('TA000')).toBeNull();
  });

  test('updateTask POSTs a wrapped Task body and returns the updated object', async () => {
    const { client, calls } = fake({});
    const updated = await client.updateTask(99, { State: 'In-Progress', Notes: 'hi' });
    expect(updated.State).toBe('In-Progress');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/task/99');
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ Task: { State: 'In-Progress', Notes: 'hi' } });
  });

  test('setTaskInProgress finds the task then flips its state (+ notes)', async () => {
    const { client, calls } = fake({ task: { ObjectID: 99, FormattedID: 'TA456', State: 'Defined' } });
    const res = await client.setTaskInProgress('TA456', 'started via rubato');
    expect(res.State).toBe('In-Progress');
    const post = calls.find((c) => c.method === 'POST');
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ Task: { State: 'In-Progress', Notes: 'started via rubato' } });
  });

  test('setTaskInProgress throws when the task is missing', async () => {
    const { client } = fake({});
    await expect(client.setTaskInProgress('TA000')).rejects.toThrow(/not found/);
  });
});
