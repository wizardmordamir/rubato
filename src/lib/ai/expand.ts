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
 * Pick a contiguous window of `total` sibling indices, size ≤ `max`, that covers
 * the matched range [lo, hi] and extends outward (balanced) to fill the budget —
 * so a big file expands AROUND its relevant region, not from its (irrelevant)
 * start. Returns inclusive [start, end] indices into the line-ordered siblings.
 */
function centeredWindow(lo: number, hi: number, total: number, max: number): [number, number] {
  if (total <= max) return [0, total - 1]; // small file: take all of it
  // Center a window of exactly `max` on the matched range's midpoint, clamped to
  // bounds — so even matches spread across a huge file yield at most `max` chunks.
  const mid = Math.floor((lo + hi) / 2);
  let start = Math.max(0, mid - Math.floor(max / 2));
  const end = Math.min(total - 1, start + max - 1);
  start = Math.max(0, end - max + 1); // re-clamp if we bumped the right edge
  return [start, end];
}

/**
 * Expand `ranked` (best-first) by inlining the sibling chunks of its top files.
 * Each expanded file's chunks are emitted contiguously, in line order, at the
 * rank of its best-scoring chunk, as a window CENTERED on that file's matched
 * chunks (so a large file contributes its relevant region, not its header).
 * Non-expanded chunks keep their position. Sibling chunks inherit the file's best
 * score (for source display); dedup is by `relativePath:startLine`.
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
  // Matched start lines per expandable file, so we expand around them (not the head).
  const matched = new Map<string, Set<number>>();
  for (const c of ranked) {
    if (!expandable.has(c.relativePath)) continue;
    const set = matched.get(c.relativePath) ?? new Set<number>();
    set.add(c.startLine);
    matched.set(c.relativePath, set);
  }

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
      const all = byFile.get(path) ?? [];
      const matchLines = matched.get(path) ?? new Set([c.startLine]);
      const positions = all.map((s, i) => (matchLines.has(s.startLine) ? i : -1)).filter((i) => i >= 0);
      const lo = positions.length ? Math.min(...positions) : 0;
      const hi = positions.length ? Math.max(...positions) : 0;
      const [from, to] = centeredWindow(lo, hi, all.length, maxChunksPerFile);
      const siblings = all.slice(from, to + 1);
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
