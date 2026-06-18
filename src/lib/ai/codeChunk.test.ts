import { describe, expect, test } from 'bun:test';
import { chunkContent } from './codeChunk';

describe('chunkContent', () => {
  test('keeps a function intact rather than slicing it mid-body', () => {
    const code = [
      'export function alpha() {',
      ...Array.from({ length: 30 }, (_, i) => `  const a${i} = ${i};`),
      '}',
      '',
      'export function beta() {',
      ...Array.from({ length: 30 }, (_, i) => `  const b${i} = ${i};`),
      '}',
    ].join('\n');
    const chunks = chunkContent('src/mod.ts', code);
    // alpha and beta land in different chunks, each whole.
    const alpha = chunks.find((c) => c.text.includes('function alpha'));
    const beta = chunks.find((c) => c.text.includes('function beta'));
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect(alpha?.text).toContain('const a29 = 29;');
    expect(alpha?.text).not.toContain('function beta');
  });

  test('bundles a JSDoc block with the function it documents', () => {
    const code = [
      'export function first() {',
      ...Array.from({ length: 40 }, (_, i) => `  x${i}();`),
      '}',
      '',
      '/**',
      ' * Does the important second thing.',
      ' */',
      'export function second() {',
      '  return 2;',
      '}',
    ].join('\n');
    const chunks = chunkContent('src/mod.ts', code);
    const withDoc = chunks.find((c) => c.text.includes('important second thing'));
    expect(withDoc).toBeDefined();
    // The JSDoc must sit with `second`, not get stranded on `first`'s chunk.
    expect(withDoc?.text).toContain('function second');
  });

  test('line ranges are contiguous and 1-based', () => {
    const code = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = chunkContent('src/mod.ts', code);
    expect(chunks[0].startLine).toBe(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1);
    }
  });

  test('non-code falls back to the line-window chunker', () => {
    const md = Array.from({ length: 200 }, (_, i) => `prose line ${i + 1}`).join('\n');
    const chunks = chunkContent('README.md', md, { lines: 40, overlap: 8 });
    // Overlap is a tell-tale of the line-window fallback (code-aware never overlaps).
    expect(chunks[1].startLine).toBeLessThan(chunks[0].endLine);
  });
});
