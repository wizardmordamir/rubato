import { describe, expect, test } from 'bun:test';
import { rrfFuse } from './hybrid';
import type { RetrievedChunk } from './types';

const c = (relativePath: string): RetrievedChunk => ({
  relativePath,
  startLine: 1,
  endLine: 1,
  text: relativePath,
  score: 0,
});

describe('rrfFuse', () => {
  test('chunks ranked highly in both lists rise to the top', () => {
    const lexical = [c('a'), c('b'), c('c')];
    const semantic = [c('b'), c('a'), c('d')];
    const fused = rrfFuse([lexical, semantic], 60, 4);
    const order = fused.map((f) => f.relativePath);
    expect(['a', 'b']).toContain(order[0]);
    // d appears in only one list, low — it ranks below a.
    expect(order.indexOf('d')).toBeGreaterThan(order.indexOf('a'));
  });

  test('dedupes the same chunk across lists', () => {
    const fused = rrfFuse([[c('a')], [c('a')]], 60, 5);
    expect(fused).toHaveLength(1);
    expect(fused[0].relativePath).toBe('a');
  });
});
