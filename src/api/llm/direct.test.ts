import { describe, expect, test } from 'bun:test';
import { createDirectProvider } from './direct';
import type { ChatChunk } from './types';

function sseResponse(lines: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('createDirectProvider', () => {
  test('streams OpenAI-style deltas as text chunks', async () => {
    const fakeFetch = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: [DONE]\n\n',
      ])) as unknown as typeof fetch;

    const provider = createDirectProvider({ baseUrl: 'http://x', fetch: fakeFetch });
    const chunks = await drain(provider.streamChat([{ role: 'user', content: 'hi' }]));
    const text = chunks
      .filter((c) => c.kind === 'text')
      .map((c) => (c.kind === 'text' ? c.text : ''))
      .join('');
    expect(text).toBe('Hello');
    expect(chunks.some((c) => c.kind === 'done')).toBe(true);
  });

  test('surfaces reasoning_content as thinking chunks', async () => {
    const fakeFetch = (async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n',
        'data: [DONE]\n\n',
      ])) as unknown as typeof fetch;
    const provider = createDirectProvider({ baseUrl: 'http://x', fetch: fakeFetch });
    const chunks = await drain(provider.streamChat([{ role: 'user', content: 'hi' }]));
    expect(chunks.some((c) => c.kind === 'thinking')).toBe(true);
  });

  test('honors a custom buildRequest + parseEvent', async () => {
    let sentBody: unknown;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return sseResponse(['data: ping\n\n']);
    }) as unknown as typeof fetch;

    const provider = createDirectProvider({
      baseUrl: 'http://x',
      fetch: fakeFetch,
      buildRequest: (messages) => ({ custom: true, n: messages.length }),
      parseEvent: (data) => (data === 'ping' ? [{ kind: 'text', text: 'pong' }] : []),
    });
    const chunks = await drain(provider.streamChat([{ role: 'user', content: 'hi' }]));
    expect(sentBody).toEqual({ custom: true, n: 1 });
    expect(chunks.find((c) => c.kind === 'text')).toEqual({ kind: 'text', text: 'pong' });
  });
});
