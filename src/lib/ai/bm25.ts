/**
 * Pure-TypeScript BM25 lexical search over stored chunks. No model, no deps —
 * always available, and strong for exact identifier/keyword lookups in code.
 *
 * The tokenizer is code-aware: it lowercases, splits on non-alphanumerics, and
 * also splits camelCase / PascalCase so `getUserById` matches a query for
 * `user` or `id`.
 */

import type { RetrievedChunk, StoredChunk } from './types';

export function tokenize(text: string): string[] {
  const withBreaks = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase → camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2'); // HTTPServer → HTTP Server
  return withBreaks
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && t.length < 64);
}

export interface Bm25Options {
  topK?: number;
  /** Term-frequency saturation (default 1.5). */
  k1?: number;
  /** Length-normalization strength (default 0.75). */
  b?: number;
}

/** Rank chunks by BM25 against the query; returns the top-K with positive scores. */
export function bm25Search(chunks: StoredChunk[], query: string, opts: Bm25Options = {}): RetrievedChunk[] {
  const topK = opts.topK ?? 12;
  const k1 = opts.k1 ?? 1.5;
  const b = opts.b ?? 0.75;
  const queryTerms = [...new Set(tokenize(query))];
  if (chunks.length === 0 || queryTerms.length === 0) return [];

  const docTokens = chunks.map((c) => tokenize(c.text));
  const docLen = docTokens.map((t) => t.length);
  const avgLen = docLen.reduce((a, n) => a + n, 0) / (docLen.length || 1) || 1;

  const df = new Map<string, number>();
  const tfPerDoc = docTokens.map((tokens) => {
    const tf = new Map<string, number>();
    for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);
    for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
    return tf;
  });

  const N = chunks.length;
  const idf = (term: string): number => {
    const n = df.get(term) ?? 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };

  const scored = chunks.map((c, i) => {
    let score = 0;
    for (const term of queryTerms) {
      const tf = tfPerDoc[i].get(term);
      if (!tf) continue;
      const denom = tf + k1 * (1 - b + (b * docLen[i]) / avgLen);
      score += idf(term) * ((tf * (k1 + 1)) / denom);
    }
    return { c, score };
  });

  return scored
    .filter((s) => s.score > 0)
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
