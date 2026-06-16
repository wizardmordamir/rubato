import { describe, expect, test } from 'bun:test';
import { cleanTags } from './links';

describe('cleanTags', () => {
  test('trims, drops blanks, and keeps order', () => {
    expect(cleanTags([' ref ', '', '  ', 'docs'])).toEqual(['ref', 'docs']);
  });

  test('de-dupes case-insensitively, keeping the first form', () => {
    expect(cleanTags(['Docs', 'docs', 'DOCS', 'ref'])).toEqual(['Docs', 'ref']);
  });

  test('ignores non-string entries and non-array input', () => {
    expect(cleanTags(['ok', 5, null, { x: 1 }] as unknown)).toEqual(['ok']);
    expect(cleanTags('not-an-array')).toEqual([]);
    expect(cleanTags(undefined)).toEqual([]);
  });

  test('caps tag length at 40 chars and count at 30', () => {
    expect(cleanTags(['x'.repeat(60)])).toEqual(['x'.repeat(40)]);
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`);
    expect(cleanTags(many)).toHaveLength(30);
  });
});
