import { describe, expect, test } from 'bun:test';
import { completeText } from './complete';
import type { ChatChunk, LlmMessage, LlmProvider } from './types';

function fakeProvider(chunks: ChatChunk[]): LlmProvider {
  return {
    name: 'fake',
    async *streamChat(_messages: LlmMessage[]) {
      for (const c of chunks) yield c;
    },
  };
}

describe('completeText', () => {
  test('concatenates text chunks, ignoring thinking/tool/done', async () => {
    const p = fakeProvider([
      { kind: 'thinking', text: 'hmm' },
      { kind: 'text', text: 'hello ' },
      { kind: 'tool', toolCallId: '1', tool: 'x' },
      { kind: 'text', text: 'world' },
      { kind: 'done' },
    ]);
    expect(await completeText(p, [])).toBe('hello world');
  });

  test('throws on an error chunk', async () => {
    const p = fakeProvider([
      { kind: 'text', text: 'partial' },
      { kind: 'error', message: 'boom' },
    ]);
    await expect(completeText(p, [])).rejects.toThrow('boom');
  });
});
