import { describe, expect, test } from 'bun:test';
import { describeShape, diffShape, shapeToString } from './shape';

describe('describeShape', () => {
  test('primitives', () => {
    expect(describeShape('x')).toEqual({ kind: 'primitive', type: 'string' });
    expect(describeShape(1)).toEqual({ kind: 'primitive', type: 'number' });
    expect(describeShape(null)).toEqual({ kind: 'primitive', type: 'null' });
    expect(describeShape(undefined)).toEqual({ kind: 'primitive', type: 'undefined' });
  });

  test('objects + arrays as a compact string', () => {
    const s = describeShape({ id: 1, tags: ['a', 'b'], nested: { ok: true } });
    expect(shapeToString(s)).toBe('object{id:number, tags:string[], nested:object{ok:boolean}}');
  });

  test('array element shapes are unioned across the sample', () => {
    const s = describeShape([{ a: 1 }, { a: 2, b: 'x' }]);
    expect(shapeToString(s)).toBe('object{a:number, b:string}[]');
  });

  test('class instances are named, not walked', () => {
    expect(describeShape(new Date())).toEqual({ kind: 'class', name: 'Date' });
  });

  test('respects maxDepth', () => {
    const s = describeShape({ a: { b: { c: 1 } } }, { maxDepth: 1 });
    expect(shapeToString(s)).toBe('object{a:…}');
  });
});

describe('diffShape', () => {
  test('no diffs for matching shapes', () => {
    expect(diffShape({ id: 1, name: 'x' }, { id: 2, name: 'y' })).toEqual([]);
  });

  test('missing key', () => {
    const diffs = diffShape({ id: 1 }, { id: 1, name: 'x' });
    expect(diffs).toEqual([{ path: 'name', kind: 'missing-key', expected: 'string' }]);
  });

  test("type mismatch (the 'JSON came back different' case)", () => {
    const diffs = diffShape({ items: 'oops' }, { items: [{ id: 1 }] });
    expect(diffs).toEqual([
      { path: 'items', kind: 'type-mismatch', expected: 'object{id:number}[]', actual: 'string' },
    ]);
  });

  test('nested + array element diffs', () => {
    const diffs = diffShape({ data: [{ id: 1 }] }, { data: [{ id: 1, sha: 'z' }] });
    expect(diffs).toEqual([{ path: 'data[].sha', kind: 'missing-key', expected: 'string' }]);
  });

  test('extra key is reported', () => {
    const diffs = diffShape({ id: 1, extra: true }, { id: 1 });
    expect(diffs).toEqual([{ path: 'extra', kind: 'extra-key', actual: 'boolean' }]);
  });
});
