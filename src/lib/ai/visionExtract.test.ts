import { describe, expect, test } from 'bun:test';
import type { ChatChunk, ChatOptions, LlmMessage, LlmProvider } from '../../api/llm/types';
import { extractVisionDiagnostic } from './visionExtract';

/** A provider that records what it was called with and replies with fixed text. */
function recordingProvider(reply: string): {
  provider: LlmProvider;
  seen: { messages: LlmMessage[]; opts?: ChatOptions };
} {
  const seen: { messages: LlmMessage[]; opts?: ChatOptions } = { messages: [] };
  const provider: LlmProvider = {
    name: 'fake',
    async *streamChat(messages: LlmMessage[], opts?: ChatOptions): AsyncIterable<ChatChunk> {
      seen.messages = messages;
      seen.opts = opts;
      yield { kind: 'text', text: reply };
      yield { kind: 'done' };
    },
  };
  return { provider, seen };
}

describe('extractVisionDiagnostic', () => {
  test('sends images on the user message, routes to the vision model, returns trimmed text', async () => {
    const { provider, seen } = recordingProvider('  ## Errors\n- boom  ');
    const out = await extractVisionDiagnostic(provider, ['IMG1', 'IMG2'], 'why is this broken?', {
      model: 'qwen3-vl:8b',
    });

    expect(out).toBe('## Errors\n- boom'); // trimmed
    expect(seen.opts?.model).toBe('qwen3-vl:8b'); // routed to the vision model
    expect(seen.messages[0]?.role).toBe('system');
    const user = seen.messages[1];
    expect(user?.role).toBe('user');
    expect(user?.images).toEqual(['IMG1', 'IMG2']);
    expect(user?.content).toContain('why is this broken?');
  });

  test('propagates a provider error (caller decides how to degrade)', async () => {
    const provider: LlmProvider = {
      name: 'fake',
      // eslint-disable-next-line require-yield
      async *streamChat(): AsyncIterable<ChatChunk> {
        yield { kind: 'error', message: 'model qwen3-vl:8b not found' };
      },
    };
    await expect(extractVisionDiagnostic(provider, ['IMG1'], 'q', { model: 'qwen3-vl:8b' })).rejects.toThrow(
      'not found',
    );
  });
});
