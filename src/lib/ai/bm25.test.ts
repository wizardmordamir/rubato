import { describe, expect, test } from 'bun:test';
import { bm25Search, tokenize } from './bm25';
import type { StoredChunk } from './types';

const mk = (relativePath: string, text: string): StoredChunk => ({
  relativePath,
  chunkIndex: 0,
  startLine: 1,
  endLine: 1,
  text,
});

describe('tokenize', () => {
  test('splits camelCase and acronyms', () => {
    expect(tokenize('getUserById')).toEqual(['get', 'user', 'by', 'id']);
    expect(tokenize('HTTPServer')).toEqual(['http', 'server']);
  });

  test('splits snake/kebab and lowercases', () => {
    expect(tokenize('MAX_OUTPUT-size')).toEqual(['max', 'output', 'size']);
  });
});

describe('bm25Search', () => {
  test('ranks the chunk with the query terms first', () => {
    const chunks = [
      mk('a.ts', 'the quick brown fox jumps'),
      mk('b.ts', 'user authentication and login verifyCredentials'),
      mk('c.ts', 'completely unrelated content here'),
    ];
    const res = bm25Search(chunks, 'login credentials', { topK: 2 });
    expect(res[0].relativePath).toBe('b.ts');
    expect(res.length).toBeLessThanOrEqual(2);
  });

  test('empty query or corpus yields nothing', () => {
    expect(bm25Search([], 'x')).toEqual([]);
    expect(bm25Search([mk('a.ts', 'hello')], '   ')).toEqual([]);
  });
});
