import { describe, expect, test } from 'bun:test';
import { createFormSseProvider } from './formSse';
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

describe('createFormSseProvider', () => {
  test('posts FormData and maps named events to chunks', async () => {
    let body: FormData | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = init.body as FormData;
      return sseResponse([
        'event: thinking\ndata: {"content":"hmm"}\n\n',
        'event: final_answer\ndata: {"content":"Hello"}\n\n',
      ]);
    }) as unknown as typeof fetch;

    const provider = createFormSseProvider({ baseUrl: 'http://x', token: 't', model: 'm', fetch: fakeFetch });
    const chunks = await drain(
      provider.streamChat([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ]),
    );

    expect(body?.get('message')).toBe('hi');
    expect(body?.get('prompt_template')).toBe('sys');
    expect(body?.get('model')).toBe('m');
    expect(chunks.some((c) => c.kind === 'thinking')).toBe(true);
    const text = chunks
      .filter((c) => c.kind === 'text')
      .map((c) => (c.kind === 'text' ? c.text : ''))
      .join('');
    expect(text).toBe('Hello');
  });
});
