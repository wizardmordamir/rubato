import { describe, expect, test } from 'bun:test';
import { createRemoteEmbeddingProvider } from './remote';

describe('createRemoteEmbeddingProvider', () => {
  test('posts {model,input} and returns embeddings ordered by index', async () => {
    let sent: unknown;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0.2, 0.2] },
            { index: 0, embedding: [0.1, 0.1] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = createRemoteEmbeddingProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      dimensions: 2,
      fetch: fakeFetch,
    });
    const out = await provider.embed(['a', 'b']);
    expect(sent).toEqual({ model: 'm', input: ['a', 'b'] });
    expect(out).toEqual([
      [0.1, 0.1],
      [0.2, 0.2],
    ]);
    expect(provider.dimensions).toBe(2);
  });

  test('empty input makes no request', async () => {
    const provider = createRemoteEmbeddingProvider({
      baseUrl: 'http://x',
      model: 'm',
      fetch: (async () => {
        throw new Error('should not fetch');
      }) as unknown as typeof fetch,
    });
    expect(await provider.embed([])).toEqual([]);
  });
});
