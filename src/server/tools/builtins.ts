/**
 * Built-in read-only repo tools: search_repo (semantic/lexical retrieval),
 * read_file (a file or line range), and list_files (the indexed file list). All
 * outputs are truncated so one call can't blow the context budget.
 */

import type { AskSource } from '../../shared/types';
import { fileSignatures } from '../aiDb';
import { retrieve } from '../aiRetrieve';
import { generatePlaceholderArtwork } from './artTool';
import { globToRegExp } from './safety';
import { readNumberedSlice, resolveUnderRoot, truncate } from './shared';
import type { RepoTool, ToolResult } from './types';

const MAX_SEARCH_CHUNKS = 6;
const MAX_CHUNK_CHARS = 1200;
const MAX_LIST = 200;

const searchRepo: RepoTool = {
  spec: {
    name: 'search_repo',
    description: "Search the app's indexed files for relevant code; returns the best-matching chunks with their paths.",
    params: [{ name: 'query', type: 'string', description: 'what to look for (keywords or a phrase)', required: true }],
  },
  async run({ app }, params): Promise<ToolResult> {
    if (!app) return { ok: false, content: 'search_repo needs an app context' };
    const chunks = (await retrieve(app, String(params.query))).slice(0, MAX_SEARCH_CHUNKS);
    if (!chunks.length) return { ok: true, content: 'no matches' };
    const sources: AskSource[] = chunks.map((c) => ({
      relativePath: c.relativePath,
      startLine: c.startLine,
      endLine: c.endLine,
      score: c.score,
    }));
    const content = chunks
      .map((c) => `// ${c.relativePath}:${c.startLine}-${c.endLine}\n${truncate(c.text, MAX_CHUNK_CHARS)}`)
      .join('\n\n');
    return { ok: true, content, sources };
  },
};

const readFileTool: RepoTool = {
  spec: {
    name: 'read_file',
    description: 'Read a file from the app (optionally a line range), returned with line numbers.',
    params: [
      { name: 'path', type: 'string', description: 'file path relative to the app root', required: true },
      { name: 'start_line', type: 'number', description: 'first line (1-based, optional)', required: false },
      { name: 'end_line', type: 'number', description: 'last line (inclusive, optional)', required: false },
    ],
  },
  async run({ app }, params): Promise<ToolResult> {
    if (!app) return { ok: false, content: 'read_file needs an app context' };
    const r = await resolveUnderRoot(app.absolutePath, String(params.path));
    if (!r.ok) return { ok: false, content: r.error };
    return readNumberedSlice(r.abs, r.rel, params);
  },
};

const listFiles: RepoTool = {
  spec: {
    name: 'list_files',
    description: "List the app's indexed files, optionally filtered by a glob (e.g. **/*.tsx).",
    params: [{ name: 'glob', type: 'string', description: 'optional glob filter', required: false }],
  },
  async run({ app }, params): Promise<ToolResult> {
    if (!app) return { ok: false, content: 'list_files needs an app context' };
    let files = [...fileSignatures(app.name).keys()].sort();
    const glob = params.glob ? String(params.glob) : '';
    if (glob) {
      const re = globToRegExp(glob);
      files = files.filter((f) => re.test(f));
    }
    if (!files.length) return { ok: true, content: glob ? `no indexed files match ${glob}` : 'no indexed files' };
    const shown = files.slice(0, MAX_LIST);
    const more = files.length > shown.length ? `\n…and ${files.length - shown.length} more` : '';
    return { ok: true, content: `${files.length} file(s):\n${shown.join('\n')}${more}` };
  },
};

export const BUILTIN_TOOLS: RepoTool[] = [searchRepo, readFileTool, listFiles, generatePlaceholderArtwork];
