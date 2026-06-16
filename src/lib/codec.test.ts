import { describe, expect, test } from 'bun:test';
import {
  buildHeader,
  decodeString,
  decodeToBytes,
  deriveKey,
  encodeBytes,
  encodeString,
  newSalt,
  parseHeader,
} from './codec';

describe('codec (compression only)', () => {
  test('round-trips strings and bytes', () => {
    const text = 'hello rubato — 日本語 — '.repeat(50);
    expect(decodeString(encodeString(text))).toBe(text);
    const bytes = Buffer.from([0, 1, 2, 255, 254, 7]);
    expect(decodeToBytes(encodeBytes(bytes)).equals(bytes)).toBe(true);
  });

  test('compresses repetitive input below its original size', () => {
    const text = 'abcd'.repeat(1000); // 4000 chars
    expect(encodeString(text).length).toBeLessThan(text.length);
  });
});

describe('codec (encrypted with a seed)', () => {
  const salt = newSalt();
  const key = deriveKey('correct horse', salt);

  test('round-trips with the right key', () => {
    const text = 'secret config values';
    expect(decodeString(encodeString(text, { key }), { key })).toBe(text);
  });

  test('the wrong seed fails loudly', () => {
    const token = encodeString('top secret', { key });
    const wrong = deriveKey('wrong seed', salt);
    expect(() => decodeString(token, { key: wrong })).toThrow();
  });

  test('ciphertext is non-deterministic (random iv) but both decode', () => {
    const a = encodeString('x', { key });
    const b = encodeString('x', { key });
    expect(a).not.toBe(b);
    expect(decodeString(a, { key })).toBe('x');
    expect(decodeString(b, { key })).toBe('x');
  });
});

describe('header', () => {
  test('build/parse round-trips, including the salt when encrypted', () => {
    const salt = newSalt().toString('base64');
    const parsed = parseHeader(buildHeader({ version: 1, encrypted: true, salt }));
    expect(parsed).toEqual({ version: 1, encrypted: true, salt });

    const plain = parseHeader(buildHeader({ version: 1, encrypted: false }));
    expect(plain?.encrypted).toBe(false);
  });

  test('returns null for a non-header line', () => {
    expect(parseHeader('abc def')).toBeNull();
  });
});
