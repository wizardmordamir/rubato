import { describe, expect, test } from 'bun:test';
import { createOllamaProvider, nativeOllamaRoot } from './ollama';
import type { ChatChunk } from './types';

function ndjsonResponse(lines: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

async function drain(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('nativeOllamaRoot', () => {
  test('strips the OpenAI-compat /v1 suffix', () => {
    expect(nativeOllamaRoot('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(nativeOllamaRoot('http://localhost:11434/v1/chat/completions')).toBe('http://localhost:11434');
    expect(nativeOllamaRoot('http://localhost:11434/')).toBe('http://localhost:11434');
  });
});

describe('createOllamaProvider', () => {
  test('parses ndjson message.content as text chunks, ending on done', async () => {
    const fakeFetch = (async () =>
      ndjsonResponse([
        '{"message":{"role":"assistant","content":"Hel"},"done":false}\n',
        '{"message":{"role":"assistant","content":"lo"},"done":false}\n',
        '{"message":{"role":"assistant","content":""},"done":true}\n',
      ])) as unknown as typeof fetch;
    const provider = createOllamaProvider({ baseUrl: 'http://x/v1', model: 'm', fetch: fakeFetch });
    const chunks = await drain(provider.streamChat([{ role: 'user', content: 'hi' }]));
    const text = chunks
      .filter((c) => c.kind === 'text')
      .map((c) => (c.kind === 'text' ? c.text : ''))
      .join('');
    expect(text).toBe('Hello');
    expect(chunks.some((c) => c.kind === 'done')).toBe(true);
  });

  test('tolerates a JSON object split across two network chunks', async () => {
    const fakeFetch = (async () =>
      ndjsonResponse([
        '{"message":{"content":"par', // packet 1 cuts mid-object
        'tial"},"done":false}\n{"message":{"content":"!"},"done":true}\n',
      ])) as unknown as typeof fetch;
    const provider = createOllamaProvider({ baseUrl: 'http://x', model: 'm', fetch: fakeFetch });
    const chunks = await drain(provider.streamChat([{ role: 'user', content: 'hi' }]));
    const text = chunks
      .filter((c) => c.kind === 'text')
      .map((c) => (c.kind === 'text' ? c.text : ''))
      .join('');
    expect(text).toBe('partial!');
  });

  test('sends num_ctx + sampling options in the native body', async () => {
    let sentBody: Record<string, unknown> = {};
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return ndjsonResponse(['{"message":{"content":"ok"},"done":true}\n']);
    }) as unknown as typeof fetch;
    const provider = createOllamaProvider({
      baseUrl: 'http://x/v1',
      model: 'qwen2.5-coder:14b',
      options: { num_ctx: 32768, temperature: 0.1, repeat_penalty: 1.1 },
      fetch: fakeFetch,
    });
    await drain(provider.streamChat([{ role: 'user', content: 'hi' }]));
    expect(sentBody.model).toBe('qwen2.5-coder:14b');
    expect(sentBody.stream).toBe(true);
    expect(sentBody.options).toEqual({ num_ctx: 32768, temperature: 0.1, repeat_penalty: 1.1 });
  });

  test('forwards base64 images on a message (multimodal), omitting the key when absent', async () => {
    let sentBody: { messages?: Array<{ role: string; content: string; images?: string[] }> } = {};
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return ndjsonResponse(['{"message":{"content":"ok"},"done":true}\n']);
    }) as unknown as typeof fetch;
    const provider = createOllamaProvider({ baseUrl: 'http://x', model: 'qwen3-vl:8b', fetch: fakeFetch });
    await drain(
      provider.streamChat([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'what is wrong here?', images: ['BASE64A', 'BASE64B'] },
      ]),
    );
    expect(sentBody.messages?.[0]).toEqual({ role: 'system', content: 'sys' }); // no images key
    expect(sentBody.messages?.[1]).toEqual({
      role: 'user',
      content: 'what is wrong here?',
      images: ['BASE64A', 'BASE64B'],
    });
  });
});
