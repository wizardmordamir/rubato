/**
 * Structure-aware chunking for source files. Naive line-window slicing cuts
 * functions, routes, and classes mid-body, so a retrieved chunk often holds half
 * a handler and the embedding is muddled. This splits on top-level declaration
 * boundaries instead, keeping a declaration with its body — and crucially with
 * its leading JSDoc/decorator, which is where the human-readable description of
 * what the code does (and the words a question matches) usually lives.
 *
 * Output is the same `Chunk` shape as the line-window `chunkFile`, with exact
 * 1-based line ranges, so storage, citations, and the DB schema are unchanged.
 * Prose/markdown/json fall back to `chunkFile`.
 */

import { extname } from 'node:path';
import { type ChunkOptions, chunkFile } from './chunk';
import type { Chunk } from './types';

export interface CodeChunkOptions extends ChunkOptions {
  /** Target chars before a chunk may flush at the next boundary (default 1500). */
  maxChars?: number;
  /** Chunks smaller than this are merged into a neighbor (default 150). */
  minChars?: number;
  /** Hard line cap so one giant block can't become an enormous chunk (default 80). */
  maxLines?: number;
}

/** Extensions chunked structurally; everything else uses the line-window fallback. */
const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rb', '.rs', '.java', '.kt',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.php', '.swift', '.scala',
]);

/** A top-level declaration that should start a fresh logical chunk. */
const DECL_RE = /^(?:export\s+|default\s+|async\s+|public\s+|private\s+|protected\s+|static\s+)*(?:function|class|interface|type|enum|const|let|var|struct|impl|def|func|router\.|app\.)\b/;
/** Lines that "attach" to the declaration below them (so the block starts above the decl). */
const ATTACHABLE_RE = /^\s*(?:\/\*\*|\*\/|\*|\/\/|@[A-Za-z])/;
/** A doc-comment opener or decorator — itself the top of a logical block. */
const BLOCK_OPENER_RE = /^\s*(?:\/\*\*|@[A-Za-z])/;

/** Dispatch: structure-aware for source files, line-window for prose. */
export function chunkContent(path: string, content: string, opts: CodeChunkOptions = {}): Chunk[] {
  return CODE_EXT.has(extname(path).toLowerCase()) ? chunkCode(content, opts) : chunkFile(content, opts);
}

/** True when `line` begins a new logical unit (and isn't already part of one above it). */
function isBlockStart(lines: string[], i: number): boolean {
  const line = lines[i];
  const opensBlock = BLOCK_OPENER_RE.test(line) || DECL_RE.test(line);
  if (!opensBlock) return false;
  // Walk back over blank lines; if the nearest non-blank line attaches (comment /
  // decorator), the block already started up there — this line isn't a fresh start.
  for (let j = i - 1; j >= 0; j--) {
    if (lines[j].trim() === '') continue;
    return !ATTACHABLE_RE.test(lines[j]);
  }
  return true; // top of file
}

function chunkCode(content: string, opts: CodeChunkOptions): Chunk[] {
  const target = opts.maxChars ?? 1500;
  const minChars = opts.minChars ?? 150;
  const maxLines = opts.maxLines ?? 80;

  const lines = content.split('\n');
  const raw: Chunk[] = [];
  let current: string[] = [];
  let startLine = 1;

  const flush = (atLine: number) => {
    if (current.length === 0) return;
    const text = current.join('\n');
    if (text.trim() !== '') raw.push({ index: raw.length, text, startLine, endLine: atLine - 1 });
    startLine = atLine;
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const size = current.join('\n').length;
    // Flush BEFORE a new logical unit once the current chunk is substantial, or
    // when a hard size/line cap is hit (safety against one huge block).
    if (current.length > 0 && ((isBlockStart(lines, i) && size >= minChars) || current.length >= maxLines || size >= target * 1.5)) {
      flush(i + 1); // lines are 1-based; chunk so far is [startLine, i]
    }
    current.push(lines[i]);
  }
  flush(lines.length + 1);

  return reindex(mergeTiny(raw, minChars));
}

/** Merge orphan chunks (below min size) into a neighbor so tiny fragments don't pollute retrieval. */
function mergeTiny(chunks: Chunk[], minChars: number): Chunk[] {
  if (chunks.length <= 1) return chunks;
  const out: Chunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.text.length < minChars && i < chunks.length - 1) {
      // Fold forward into the next chunk.
      const next = chunks[i + 1];
      next.startLine = c.startLine;
      next.text = `${c.text}\n${next.text}`;
    } else if (c.text.length < minChars && out.length > 0) {
      // Final orphan: fold back into the previous finalized chunk.
      const prev = out[out.length - 1];
      prev.endLine = c.endLine;
      prev.text = `${prev.text}\n${c.text}`;
    } else {
      out.push(c);
    }
  }
  return out;
}

/** Renumber indices sequentially after merges. */
function reindex(chunks: Chunk[]): Chunk[] {
  return chunks.map((c, index) => ({ ...c, index }));
}
