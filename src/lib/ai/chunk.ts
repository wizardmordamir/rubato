/**
 * Line-based chunking with overlap. Deterministic, tokenizer-free, and records a
 * 1-based inclusive line range per chunk so answers can cite `path:start-end`.
 */

import type { Chunk } from './types';

export interface ChunkOptions {
  /** Lines per chunk (default 60). */
  lines?: number;
  /** Overlapping lines between consecutive chunks (default 10). */
  overlap?: number;
}

export function chunkFile(text: string, opts: ChunkOptions = {}): Chunk[] {
  const lines = Math.max(1, opts.lines ?? 60);
  const overlap = Math.max(0, Math.min(opts.overlap ?? 10, lines - 1));
  const step = lines - overlap;
  const all = text.split('\n');
  const chunks: Chunk[] = [];
  let index = 0;
  let start = 0;
  while (start < all.length) {
    const end = Math.min(start + lines, all.length);
    const slice = all.slice(start, end).join('\n');
    if (slice.trim() !== '') {
      chunks.push({ index: index++, text: slice, startLine: start + 1, endLine: end });
    }
    if (end >= all.length) break;
    start += step;
  }
  return chunks;
}
