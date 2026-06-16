import { describe, expect, test } from 'bun:test';
import { chunkFile } from './chunk';

describe('chunkFile', () => {
  test('splits into overlapping line ranges', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = chunkFile(text, { lines: 30, overlap: 5 }); // step = 25
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 30 });
    expect(chunks[1].startLine).toBe(26);
    expect(chunks.at(-1)?.endLine).toBe(100);
  });

  test('a short file is a single chunk', () => {
    const chunks = chunkFile('a\nb\nc', { lines: 60 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, startLine: 1, endLine: 3 });
  });

  test('blank input yields no chunks', () => {
    expect(chunkFile('   \n  ')).toEqual([]);
  });
});
