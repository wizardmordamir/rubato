import { describe, expect, test } from 'bun:test';
import { expandFileContext } from './expand';
import type { RetrievedChunk, StoredChunk } from './types';

const stored = (path: string, idx: number, startLine: number, text = 'x'): StoredChunk => ({
  relativePath: path,
  chunkIndex: idx,
  startLine,
  endLine: startLine + 9,
  text,
});
const retrieved = (path: string, startLine: number, score: number): RetrievedChunk => ({
  relativePath: path,
  startLine,
  endLine: startLine + 9,
  text: 'x',
  score,
});

describe('expandFileContext', () => {
  // routes.tsx split into 4 chunks; only the 3rd ranked in.
  const routes = [
    stored('routes.tsx', 0, 1),
    stored('routes.tsx', 1, 11),
    stored('routes.tsx', 2, 21),
    stored('routes.tsx', 3, 31),
  ];

  test('pulls in the sibling chunks of a ranked file, line-ordered', () => {
    const ranked = [retrieved('routes.tsx', 21, 0.9)];
    const out = expandFileContext(ranked, routes);
    expect(out.map((c) => c.startLine)).toEqual([1, 11, 21, 31]); // whole file, in order
    expect(out.every((c) => c.relativePath === 'routes.tsx')).toBe(true);
  });

  test("siblings inherit the file's best score", () => {
    const out = expandFileContext([retrieved('routes.tsx', 21, 0.9)], routes);
    expect(out.every((c) => c.score === 0.9)).toBe(true);
  });

  test("expanded file is emitted once, at its best chunk's rank", () => {
    const other = [stored('other.ts', 0, 1)];
    const ranked = [retrieved('other.ts', 1, 0.95), retrieved('routes.tsx', 21, 0.9), retrieved('routes.tsx', 1, 0.5)];
    const out = expandFileContext(ranked, [...other, ...routes]);
    // other.ts first (best rank), then the full routes.tsx block once.
    expect(out.map((c) => `${c.relativePath}:${c.startLine}`)).toEqual([
      'other.ts:1',
      'routes.tsx:1',
      'routes.tsx:11',
      'routes.tsx:21',
      'routes.tsx:31',
    ]);
  });

  test('respects maxFiles (only the top file expands)', () => {
    const a = [stored('a.ts', 0, 1), stored('a.ts', 1, 11)];
    const b = [stored('b.ts', 0, 1), stored('b.ts', 1, 11)];
    const out = expandFileContext([retrieved('a.ts', 1, 0.9), retrieved('b.ts', 1, 0.8)], [...a, ...b], {
      maxFiles: 1,
    });
    expect(out.filter((c) => c.relativePath === 'a.ts').length).toBe(2); // expanded
    expect(out.filter((c) => c.relativePath === 'b.ts').length).toBe(1); // left as-is
  });

  test('caps chunks per expanded file', () => {
    const big = Array.from({ length: 20 }, (_, i) => stored('big.ts', i, i * 10 + 1));
    const out = expandFileContext([retrieved('big.ts', 51, 0.9)], big, { maxChunksPerFile: 5 });
    expect(out.length).toBe(5);
  });

  test('centers the window on the matched chunk, not the file head', () => {
    // 30-chunk file; the match is deep inside it (chunk 20, startLine 201).
    const big = Array.from({ length: 30 }, (_, i) => stored('big.ts', i, i * 10 + 1));
    const out = expandFileContext([retrieved('big.ts', 201, 0.9)], big, { maxChunksPerFile: 6 });
    expect(out.length).toBe(6);
    const lines = out.map((c) => c.startLine);
    expect(lines).toContain(201); // the matched region is included…
    expect(Math.min(...lines)).toBeGreaterThan(150); // …and the window is NOT the file head (1..51)
  });

  test('maxFiles <= 0 disables expansion', () => {
    const out = expandFileContext([retrieved('routes.tsx', 21, 0.9)], routes, { maxFiles: 0 });
    expect(out.map((c) => c.startLine)).toEqual([21]);
  });
});
