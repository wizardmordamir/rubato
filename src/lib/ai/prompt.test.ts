import { describe, expect, test } from 'bun:test';
import { buildGeneralPrompt, buildPrompt, formatAttachments } from './prompt';
import type { RetrievedChunk } from './types';

const chunk = (path: string, text: string): RetrievedChunk => ({
  relativePath: path,
  startLine: 1,
  endLine: 5,
  text,
  score: 1,
});

describe('buildPrompt (app-scoped)', () => {
  test('includes retrieved context and the app name in the system prompt', () => {
    const built = buildPrompt('myapp', 'how does auth work?', [chunk('src/auth.ts', 'export const auth = 1;')]);
    expect(built.messages[0].content).toContain('"myapp"');
    expect(built.messages[1].content).toContain('src/auth.ts:1-5');
    expect(built.messages[1].content).toContain('Question: how does auth work?');
    expect(built.used.length).toBe(1);
  });

  test('falls back to answering from general knowledge when no context matched', () => {
    const built = buildPrompt('myapp', 'what is a closure?', []);
    // The user turn is just the question — no "(no context)" refusal-bait note.
    expect(built.messages[1].content).toBe('Question: what is a closure?');
    // The system prompt tells the model to answer general questions itself rather
    // than refuse, while still flagging the missing index for app-specific ones.
    expect(built.messages[0].content).toContain('answer it directly');
    expect(built.messages[0].content).toContain("isn't indexed");
    expect(built.used.length).toBe(0);
  });

  test('attachments appear alongside retrieved context', () => {
    const built = buildPrompt('myapp', 'q', [chunk('a.ts', 'code')], {
      attachments: [{ name: 'notes.txt', content: 'remember this' }],
    });
    expect(built.messages[0].content).toContain('attached files');
    expect(built.messages[1].content).toContain('// Attached file: notes.txt');
    expect(built.messages[1].content).toContain('remember this');
    expect(built.messages[1].content).toContain('Context from the codebase');
  });
});

describe('buildGeneralPrompt (no repo)', () => {
  test('is just the question with a general system prompt', () => {
    const built = buildGeneralPrompt('what is a monad?');
    expect(built.messages[0].content).toContain('helpful assistant');
    expect(built.messages[0].content).not.toContain('app');
    expect(built.messages[1].content).toBe('what is a monad?');
    expect(built.used.length).toBe(0);
  });

  test('includes attached files when present', () => {
    const built = buildGeneralPrompt('summarize this', {
      attachments: [{ name: 'log.txt', content: 'ERROR boom' }],
    });
    expect(built.messages[0].content).toContain('attached files');
    expect(built.messages[1].content).toContain('// Attached file: log.txt');
    expect(built.messages[1].content).toContain('ERROR boom');
    expect(built.messages[1].content).toContain('Question: summarize this');
  });
});

describe('history (multi-turn memory)', () => {
  const history = [
    { role: 'user' as const, content: 'first question' },
    { role: 'assistant' as const, content: 'first answer' },
  ];

  test('buildPrompt weaves history between system and the current question', () => {
    const built = buildPrompt('myapp', 'follow-up', [chunk('a.ts', 'code')], { history });
    expect(built.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(built.messages[1].content).toBe('first question');
    expect(built.messages[2].content).toBe('first answer');
    expect(built.messages[3].content).toContain('Question: follow-up');
  });

  test('buildGeneralPrompt weaves history too', () => {
    const built = buildGeneralPrompt('follow-up', { history });
    expect(built.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(built.messages[3].content).toBe('follow-up');
  });
});

describe('formatAttachments', () => {
  test('truncates content past the token budget', () => {
    const big = 'x'.repeat(100_000);
    const { block, tokens } = formatAttachments([{ name: 'big.txt', content: big }], 100);
    expect(block).toContain('… (truncated)');
    expect(tokens).toBeLessThanOrEqual(100);
    expect(block.length).toBeLessThan(big.length);
  });

  test('empty when no attachments', () => {
    expect(formatAttachments([], 100)).toEqual({ block: '', tokens: 0 });
  });
});
