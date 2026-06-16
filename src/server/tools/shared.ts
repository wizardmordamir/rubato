/**
 * Shared helpers for the read-only file tools (builtins.ts = app-scoped,
 * fsTools.ts = folder-scoped). Both resolve a model-supplied path safely and
 * return a numbered file slice, so that logic lives in one place.
 */

import { readFile, realpath } from 'node:fs/promises';
import { relative } from 'node:path';
import type { AskSource } from '../../shared/types';
import { resolveRepoPath } from './safety';
import type { ToolResult } from './types';

export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_FILE_LINES = 400;

export const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s);

export type Resolved = { ok: true; abs: string; rel: string } | { ok: false; error: string };

/**
 * Resolve a model-supplied path under `root`, refusing traversal, secret files,
 * and symlink escape. Canonicalizes both sides so a symlinked root (e.g. macOS
 * /var → /private/var) isn't mistaken for an escape.
 */
export async function resolveUnderRoot(root: string, requested: string): Promise<Resolved> {
  const resolved = resolveRepoPath(root, requested);
  if (!resolved.ok) return resolved;
  try {
    const [real, realRoot] = await Promise.all([realpath(resolved.abs), realpath(root).catch(() => root)]);
    if (relative(realRoot, real).startsWith('..')) {
      return { ok: false, error: 'that path resolves outside the allowed root and was refused' };
    }
  } catch {
    return { ok: false, error: `no such file: ${resolved.rel}` };
  }
  return { ok: true, abs: resolved.abs, rel: resolved.rel };
}

/** Read a file (optionally a line range) as a numbered slice, capped, as a ToolResult. */
export async function readNumberedSlice(
  abs: string,
  rel: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  let text: string;
  try {
    const file = Bun.file(abs);
    if (file.size > MAX_FILE_BYTES) return { ok: false, content: `file too large (${file.size} bytes) to read whole` };
    text = await readFile(abs, 'utf8');
  } catch {
    return { ok: false, content: `could not read ${rel}` };
  }
  const lines = text.split('\n');
  const start = Math.max(1, Number(params.start_line ?? 1));
  const end = Math.min(lines.length, Number(params.end_line ?? lines.length), start + MAX_FILE_LINES - 1);
  const numbered = lines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}\t${l}`)
    .join('\n');
  const note = end < lines.length || start > 1 ? ` (lines ${start}-${end} of ${lines.length})` : '';
  const sources: AskSource[] = [{ relativePath: rel, startLine: start, endLine: end, score: 1 }];
  return { ok: true, content: `// ${rel}${note}\n${numbered}`, sources };
}
