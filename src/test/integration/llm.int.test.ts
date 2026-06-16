/**
 * Integration: the LLM provider seam. The real `llmFromConfig()` builds a direct
 * (OpenAI-style) provider pointed at the fake `/llm` endpoint; we drive real
 * streaming + SSE parsing against the fake's `chat/completions` stream.
 */

import { describe, expect, test } from 'bun:test';
import { completeText } from '../../api/llm/complete';
import { llmFromConfig } from '../../api/llm/fromConfig';
import type { ChatChunk } from '../../api/llm/types';
import { useHarness } from '../index';

const h = useHarness();

async function drain(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe('llm provider integration', () => {
  test('completeText drains the fake SSE stream into the full reply', async () => {
    h.fake.reset();
    const provider = await llmFromConfig();
    expect(provider.name).toBe('direct');
    const text = await completeText(provider, [{ role: 'user', content: 'hi' }]);
    expect(text).toBe('Hello world');

    // The real client posted to the chat endpoint with bearer auth + streaming on.
    const req = h.fake.requests.find((r) => r.service === 'llm');
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('chat/completions');
    expect(req?.headers.authorization).toBe('Bearer fake-llm');
    const sent = req?.parsed as { messages?: Array<{ content: string }>; stream?: boolean };
    expect(sent?.stream).toBe(true);
    expect(sent?.messages?.at(-1)?.content).toBe('hi');
  });

  test('streamChat yields normalized text chunks then done', async () => {
    h.fake.reset();
    const provider = await llmFromConfig();
    const chunks = await drain(provider.streamChat([{ role: 'user', content: 'hi' }]));
    expect(chunks.filter((c) => c.kind === 'text').map((c) => (c as { text: string }).text)).toEqual([
      'Hello',
      ' world',
    ]);
    expect(chunks.some((c) => c.kind === 'done')).toBe(true);
  });

  test('an upstream error surfaces (the stream rejects)', async () => {
    h.fake.reset();
    h.fake.handler = (ctx) => (ctx.service === 'llm' ? ctx.json({ error: 'model overloaded' }, 500) : undefined);
    const provider = await llmFromConfig();
    await expect(completeText(provider, [{ role: 'user', content: 'hi' }])).rejects.toThrow();
  });
});
