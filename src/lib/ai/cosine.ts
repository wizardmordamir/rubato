/**
 * Brute-force cosine similarity over stored vectors. The corpus is one app's
 * chunks (a few thousand), so a linear scan is sub-millisecond — no native vector
 * extension needed. Embeddings are stored normalized, but full cosine is computed
 * for safety so unnormalized vectors still rank correctly.
 */

import type { RetrievedChunk, StoredChunk } from './types';

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Rank chunks that have an embedding by cosine to the query vector; top-K. */
export function vectorSearch(chunks: StoredChunk[], queryVec: Float32Array, topK = 12): RetrievedChunk[] {
  const scored: { c: StoredChunk; score: number }[] = [];
  for (const c of chunks) {
    if (!c.embedding) continue;
    scored.push({ c, score: cosineSimilarity(c.embedding, queryVec) });
  }
  return scored
    .sort((a, z) => z.score - a.score)
    .slice(0, topK)
    .map(({ c, score }) => ({
      relativePath: c.relativePath,
      startLine: c.startLine,
      endLine: c.endLine,
      text: c.text,
      score,
    }));
}
