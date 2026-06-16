/**
 * File-context expansion: chunk retrieval ranks isolated slices, which is poor
 * for "list/count all X in a file" questions — the answer needs the *whole*
 * file, not one window. After ranking, pull the sibling chunks of the top files
 * so the model sees them contiguously, bounded so a huge file can't swamp the
 * budget (packContext trims to the token budget afterward).
 */

import type { RetrievedChunk, StoredChunk } from './types';

export interface ExpandOptions {
  /** How many of the top-ranked files to expand. Default 3. */
  maxFiles?: number;
  /** Cap on chunks pulled per expanded file. Default 12. */
  maxChunksPerFile?: number;
}

const toRetrieved = (c: StoredChunk, score: number): RetrievedChunk => ({
  relativePath: c.relativePath,
  startLine: c.startLine,
  endLine: c.endLine,
  text: c.text,
  score,
});

/**
 * Expand `ranked` (best-first) by inlining the sibling chunks of its top files.
 * Each expanded file's chunks are emitted contiguously, in line order, at the
 * rank of its best-scoring chunk; non-expanded chunks keep their position.
 * Sibling chunks inherit the file's best score (for source display); dedup is by
 * `relativePath:startLine`.
 */
export function expandFileContext(
  ranked: RetrievedChunk[],
  allChunks: StoredChunk[],
  opts: ExpandOptions = {},
): RetrievedChunk[] {
  const maxFiles = opts.maxFiles ?? 3;
  const maxChunksPerFile = opts.maxChunksPerFile ?? 12;
  if (maxFiles <= 0 || ranked.length === 0) return ranked;

  // Best score per file, in first-seen (i.e. best-rank) order.
  const bestScore = new Map<string, number>();
  for (const c of ranked) {
    if (!bestScore.has(c.relativePath)) bestScore.set(c.relativePath, c.score);
  }
  const expandable = new Set([...bestScore.keys()].slice(0, maxFiles));

  // All stored chunks grouped by file, line-ordered, for sibling lookup.
  const byFile = new Map<string, StoredChunk[]>();
  for (const c of allChunks) {
    const list = byFile.get(c.relativePath);
    if (list) list.push(c);
    else byFile.set(c.relativePath, [c]);
  }
  for (const list of byFile.values()) list.sort((a, b) => a.startLine - b.startLine);

  const out: RetrievedChunk[] = [];
  const seen = new Set<string>();
  const emitted = new Set<string>();
  const key = (path: string, startLine: number) => `${path}:${startLine}`;

  for (const c of ranked) {
    const path = c.relativePath;
    if (expandable.has(path)) {
      if (emitted.has(path)) continue; // file already inlined at its best chunk
      emitted.add(path);
      const siblings = (byFile.get(path) ?? []).slice(0, maxChunksPerFile);
      const score = bestScore.get(path) ?? c.score;
      for (const s of siblings) {
        const k = key(path, s.startLine);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(toRetrieved(s, score));
      }
    } else {
      const k = key(path, c.startLine);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}
