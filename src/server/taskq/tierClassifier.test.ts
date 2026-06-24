import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { makeLlmTierClassifier } from './tierClassifier';

type FetchFn = typeof fetch;

const ORIG_API_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (ORIG_API_KEY != null) process.env.ANTHROPIC_API_KEY = ORIG_API_KEY;
  else delete process.env.ANTHROPIC_API_KEY;
});

function withMockFetch(mockFn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>, fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFn as FetchFn;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

describe('makeLlmTierClassifier', () => {
  test('returns null when ANTHROPIC_API_KEY is absent', () => {
    expect(makeLlmTierClassifier()).toBeNull();
  });

  test('returns a classifier function when ANTHROPIC_API_KEY is present', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const classifier = makeLlmTierClassifier();
    expect(typeof classifier).toBe('function');
  });

  test('classifier returns null gracefully on network failure', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const classifier = makeLlmTierClassifier()!;
    await withMockFetch(async () => {
      throw new Error('network error');
    }, async () => {
      expect(await classifier('some task', null)).toBeNull();
    });
  });

  test('classifier returns null on a non-ok API response', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const classifier = makeLlmTierClassifier()!;
    await withMockFetch(
      async () => new Response('Unauthorized', { status: 401 }),
      async () => {
        expect(await classifier('some task', null)).toBeNull();
      },
    );
  });

  test('classifier parses "sonnet" response correctly', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const classifier = makeLlmTierClassifier()!;
    await withMockFetch(
      async () =>
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'sonnet' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      async () => {
        const result = await classifier('rename the helper method', null);
        expect(result?.model).toBe('sonnet');
        expect(result?.think).toBe('medium');
        expect(result?.confidence).toBe('heuristic');
      },
    );
  });

  test('classifier parses "opus" response correctly', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const classifier = makeLlmTierClassifier()!;
    await withMockFetch(
      async () =>
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'opus' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      async () => {
        const result = await classifier('do the widget thing', 'complex edge case handling needed');
        expect(result?.model).toBe('opus');
        expect(result?.think).toBe('high');
      },
    );
  });

  test('classifier returns null for an unexpected model response', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const classifier = makeLlmTierClassifier()!;
    await withMockFetch(
      async () =>
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'maybe' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      async () => {
        expect(await classifier('do the widget thing', null)).toBeNull();
      },
    );
  });
});
