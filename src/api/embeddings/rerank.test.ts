import { describe, expect, test } from 'bun:test';
import { rerank, rerankAvailable, sortByScores } from './rerank';

describe('sortByScores', () => {
  test('orders items by score descending, stable on ties', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const sorted = sortByScores(items, [0.1, 0.9, 0.9, 0.3]);
    // b and c tie at 0.9 → keep input order (b before c).
    expect(sorted.map((i) => i.id)).toEqual(['b', 'c', 'd', 'a']);
  });

  test('truncates to topK', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(sortByScores(items, [0.1, 0.5, 0.9], 2).map((i) => i.id)).toEqual(['c', 'b']);
  });

  test('items without a score sink to the bottom', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    // Only two scores → 'c' has no score and must rank last.
    expect(sortByScores(items, [0.2, 0.8]).map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('rerank', () => {
  test('is a no-op when the model is not staged (returns input order)', async () => {
    // No rerank model is staged in the test env, so this must short-circuit.
    expect(rerankAvailable('definitely/not-staged-model')).toBe(false);
    const items = [{ text: 'x' }, { text: 'y' }];
    expect(await rerank('q', items, { model: 'definitely/not-staged-model' })).toBe(items);
  });

  test('passes through a single item untouched', async () => {
    const items = [{ text: 'only' }];
    expect(await rerank('q', items)).toBe(items);
  });
});
