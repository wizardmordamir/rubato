import { describe, expect, it } from 'bun:test';
import { asText, coerceTaskText } from './normalizeTask';

describe('asText', () => {
  it('passes strings, null, and undefined through unchanged', () => {
    expect(asText('hello')).toBe('hello');
    expect(asText('')).toBe('');
    expect(asText(null)).toBeNull();
    expect(asText(undefined)).toBeUndefined();
  });

  it('stringifies primitives', () => {
    expect(asText(42)).toBe('42');
    expect(asText(true)).toBe('true');
  });

  it('reconstructs a char-code buffer spread (the #304 corruption)', () => {
    // `{...Buffer.from('Hi')}` → {0:72,1:105} of char codes.
    const corrupt = { 0: 72, 1: 105 } as unknown;
    expect(asText(corrupt)).toBe('Hi');
  });

  it('reconstructs a char buffer spread', () => {
    const corrupt = { 0: 'H', 1: 'i', 2: '!' } as unknown;
    expect(asText(corrupt)).toBe('Hi!');
  });

  it('falls back to JSON for a genuine object', () => {
    expect(asText({ a: 1 })).toBe('{"a":1}');
  });
});

describe('coerceTaskText', () => {
  it('returns the same reference when nothing needs fixing', () => {
    const t = { id: 1, title: 'ok', note: null, needs: ['2'] };
    expect(coerceTaskText(t)).toBe(t);
  });

  it('coerces a corrupt note object back to text without crashing the board', () => {
    // The real #315 row: note stored as a spread char-code buffer.
    const codes = Object.fromEntries([...'Adaptive sweep'].map((c, i) => [i, c.charCodeAt(0)]));
    const t = { id: 315, title: 'x', note: codes as unknown, body: null };
    const out = coerceTaskText(t);
    expect(out).not.toBe(t); // copied, not mutated
    expect(typeof out.note).toBe('string');
    expect(out.note).toBe('Adaptive sweep');
    expect(t.note).toBe(codes); // input untouched
  });

  it('leaves non-task values alone', () => {
    expect(coerceTaskText(null)).toBeNull();
    expect(coerceTaskText('scalar')).toBe('scalar');
  });
});
