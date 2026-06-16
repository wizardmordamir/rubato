/**
 * Reciprocal Rank Fusion: combine several ranked lists into one. Rank-based, so
 * the incompatible score scales of BM25 and cosine don't need normalizing — a
 * chunk's fused score is the sum of 1/(k + rank) across the lists it appears in.
 */

import type { RetrievedChunk } from './types';

const chunkKey = (c: RetrievedChunk) => `${c.relativePath}:${c.startLine}-${c.endLine}`;

export function rrfFuse(rankings: RetrievedChunk[][], k = 60, topK = 12): RetrievedChunk[] {
  const fused = new Map<string, number>();
  const byKey = new Map<string, RetrievedChunk>();

  for (const ranking of rankings) {
    ranking.forEach((c, i) => {
      const key = chunkKey(c);
      fused.set(key, (fused.get(key) ?? 0) + 1 / (k + i + 1));
      if (!byKey.has(key)) byKey.set(key, c);
    });
  }

  return [...fused.entries()]
    .sort((a, z) => z[1] - a[1])
    .slice(0, topK)
    .map(([key, score]) => {
      const c = byKey.get(key) as RetrievedChunk;
      return { ...c, score };
    });
}
