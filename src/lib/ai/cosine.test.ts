import { describe, expect, test } from 'bun:test';
import { cosineSimilarity, vectorSearch } from './cosine';
import type { StoredChunk } from './types';

describe('cosineSimilarity', () => {
  test('parallel → 1, orthogonal → 0', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test('a zero vector scores 0', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('vectorSearch', () => {
  const mk = (relativePath: string, vec: number[]): StoredChunk => ({
    relativePath,
    chunkIndex: 0,
    startLine: 1,
    endLine: 1,
    text: relativePath,
    embedding: Float32Array.from(vec),
  });

  test('ranks by cosine and skips chunks without embeddings', () => {
    const noVec: StoredChunk = { relativePath: 'c', chunkIndex: 0, startLine: 1, endLine: 1, text: 'c' };
    const res = vectorSearch([mk('a', [1, 0]), mk('b', [0, 1]), noVec], Float32Array.from([1, 0]), 5);
    expect(res[0].relativePath).toBe('a');
    expect(res.find((r) => r.relativePath === 'c')).toBeUndefined();
  });
});
