/**
 * Live filesystem tools for general (no-app) chat. When the user points the AI
 * at a folder, these let it explore that folder directly — no indexing required:
 * list_files (walk), read_file (a file/line range), and search_files (a live
 * text grep). Each set is bound to one root directory and reuses the repo-tool
 * safety guards (path-traversal refusal + secret denylist), so the model can
 * never read outside the folder or open a credential file. Read-only.
 */

import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { AskSource } from '../../shared/types';
import { globToRegExp, isSecretPath } from './safety';
import { readNumberedSlice, resolveUnderRoot, truncate } from './shared';
import type { RepoTool, ToolResult } from './types';

const MAX_LIST = 300;
const MAX_WALK = 4000; // files visited per walk (bounds huge trees)
const MAX_SEARCH_FILES = 800;
const MAX_SEARCH_MATCHES = 40;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;

/** Directories we never descend into (build output, vcs, deps) — noise + cost. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  '.cache',
  'vendor',
  '__pycache__',
  '.venv',
  'target',
]);

/** Walk `root`, returning repo-relative file paths, skipping heavy/secret dirs, capped. */
async function walk(root: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop() as string;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip
    }
    for (const e of entries) {
      const abs = resolve(dir, e.name);
      const rel = relative(root, abs);
      if (isSecretPath(rel)) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(abs);
      } else if (e.isFile()) {
        out.push(rel);
        if (out.length >= limit) break;
      }
    }
  }
  return out.sort();
}

/** Build the read-only filesystem tool set bound to `root`. */
export function getFsTools(root: string): RepoTool[] {
  const listFiles: RepoTool = {
    spec: {
      name: 'list_files',
      description: 'List files in the folder, optionally filtered by a glob (e.g. **/*.ts).',
      params: [{ name: 'glob', type: 'string', description: 'optional glob filter', required: false }],
    },
    async run(_ctx, params): Promise<ToolResult> {
      let files = await walk(root, MAX_WALK);
      const glob = params.glob ? String(params.glob) : '';
      if (glob) {
        const re = globToRegExp(glob);
        files = files.filter((f) => re.test(f));
      }
      if (!files.length) return { ok: true, content: glob ? `no files match ${glob}` : 'no files found' };
      const shown = files.slice(0, MAX_LIST);
      const more = files.length > shown.length ? `\n…and ${files.length - shown.length} more` : '';
      return { ok: true, content: `${files.length} file(s):\n${shown.join('\n')}${more}` };
    },
  };

  const readFileTool: RepoTool = {
    spec: {
      name: 'read_file',
      description: 'Read a file from the folder (optionally a line range), returned with line numbers.',
      params: [
        { name: 'path', type: 'string', description: 'file path relative to the folder', required: true },
        { name: 'start_line', type: 'number', description: 'first line (1-based, optional)', required: false },
        { name: 'end_line', type: 'number', description: 'last line (inclusive, optional)', required: false },
      ],
    },
    async run(_ctx, params): Promise<ToolResult> {
      const r = await resolveUnderRoot(root, String(params.path));
      if (!r.ok) return { ok: false, content: r.error };
      return readNumberedSlice(r.abs, r.rel, params);
    },
  };

  const searchFiles: RepoTool = {
    spec: {
      name: 'search_files',
      description: "Search the folder's files for a literal text/substring; returns matching lines with paths.",
      params: [{ name: 'query', type: 'string', description: 'text to look for (case-insensitive)', required: true }],
    },
    async run(_ctx, params): Promise<ToolResult> {
      const needle = String(params.query ?? '').toLowerCase();
      if (!needle.trim()) return { ok: false, content: 'empty query' };
      const files = (await walk(root, MAX_SEARCH_FILES)).slice(0, MAX_SEARCH_FILES);
      const hits: string[] = [];
      const sources: AskSource[] = [];
      for (const rel of files) {
        if (hits.length >= MAX_SEARCH_MATCHES) break;
        const abs = resolve(root, rel);
        try {
          if (Bun.file(abs).size > MAX_SEARCH_FILE_BYTES) continue;
          const text = await readFile(abs, 'utf8');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_MATCHES; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              hits.push(`${rel}:${i + 1}: ${truncate(lines[i].trim(), 200)}`);
              sources.push({ relativePath: rel, startLine: i + 1, endLine: i + 1, score: 1 });
            }
          }
        } catch {
          // binary/unreadable file — skip
        }
      }
      if (!hits.length) return { ok: true, content: `no matches for "${params.query}"` };
      const more = hits.length >= MAX_SEARCH_MATCHES ? '\n…(more matches truncated)' : '';
      return { ok: true, content: `${hits.length} match(es):\n${hits.join('\n')}${more}`, sources };
    },
  };

  return [listFiles, readFileTool, searchFiles];
}
