import { describe, expect, test } from 'bun:test';
import {
  buildGeneralPrompt,
  buildPrompt,
  CODE_GROUNDING_RULES,
  formatAttachments,
  isCodeQuestion,
  packContext,
} from './prompt';
import type { RetrievedChunk } from './types';

const chunk = (path: string, text: string): RetrievedChunk => ({
  relativePath: path,
  startLine: 1,
  endLine: 5,
  text,
  score: 1,
});

describe('packContext', () => {
  test('caps chunks per file so one file cannot crowd out others', () => {
    const many: RetrievedChunk[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        relativePath: 'big.ts',
        startLine: i * 10 + 1,
        endLine: i * 10 + 9,
        text: 'x',
        score: 1,
      })),
      { relativePath: 'other.ts', startLine: 1, endLine: 9, text: 'y', score: 0.5 },
    ];
    const kept = packContext(many, 100_000, 6);
    expect(kept.filter((c) => c.relativePath === 'big.ts').length).toBe(6); // capped
    expect(kept.some((c) => c.relativePath === 'other.ts')).toBe(true); // other file survives
  });

  test('prepends the app map to the system prompt when provided', () => {
    const { messages } = buildPrompt('demo', 'q', [chunk('a.ts', 'code')], { appMap: '### App map\n- /private' });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('/private');
  });
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

describe('isCodeQuestion', () => {
  test('true for code-shaped asks', () => {
    expect(isCodeQuestion('write a script to parse usage')).toBe(true);
    expect(isCodeQuestion('fix the bug in foo.ts')).toBe(true);
    expect(isCodeQuestion('show me an example')).toBe(true);
  });

  test('false for plain prose questions', () => {
    expect(isCodeQuestion('what does this app do?')).toBe(false);
    expect(isCodeQuestion('who is the owner of the project')).toBe(false);
  });
});

describe('code grounding injection', () => {
  test('buildPrompt injects code rules only when codeMode is set', () => {
    const on = buildPrompt('app', 'q', [], { codeMode: true });
    expect(on.messages[0].content).toContain('Code-generation rules');
    const off = buildPrompt('app', 'q', [], { codeMode: false });
    expect(off.messages[0].content).not.toContain('Code-generation rules');
  });

  test('buildPrompt injects the runtime reference block when provided', () => {
    const built = buildPrompt('app', 'q', [], { runtimeRef: '[Runtime Reference]\nRuntime: Bun 1.2.3' });
    expect(built.messages[0].content).toContain('[Runtime Reference]');
    expect(built.messages[0].content).toContain('Bun 1.2.3');
  });

  test('buildPrompt injects the [UI Vision Reference] block when provided', () => {
    const built = buildPrompt('app', 'q', [], { visionRef: '## Errors\n- TypeError: x is undefined' });
    expect(built.messages[0].content).toContain('[UI Vision Reference]');
    expect(built.messages[0].content).toContain('TypeError: x is undefined');
  });

  test('buildGeneralPrompt honors codeMode + runtimeRef + visionRef', () => {
    const sys = buildGeneralPrompt('write code', {
      codeMode: true,
      runtimeRef: '[Runtime Reference]\nx',
      visionRef: '## Errors\n- boom',
    }).messages[0].content;
    expect(sys).toContain('Code-generation rules');
    expect(sys).toContain('[Runtime Reference]');
    expect(sys).toContain('[UI Vision Reference]');
    expect(CODE_GROUNDING_RULES).toContain('promisify');
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
