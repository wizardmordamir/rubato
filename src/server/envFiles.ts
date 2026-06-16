/**
 * Discover + read + write an app's `.env*` files for the web UI's env editor.
 *
 * This is a DELIBERATE, user-initiated path that handles credential files — it is
 * separate from the AI repo tools (whose `safety.ts` denylists `.env`): the agent
 * must never surface secrets, but the human operating their own loopback machine
 * explicitly opens these to edit/compare them.
 *
 * Safety is still enforced: a request names an app (resolved to its registered
 * `absolutePath`) plus a *relative* path; the path must stay inside the app dir
 * (no `..`/absolute escape, realpath-checked against symlink escape) and its
 * basename must look like an env file. So this can only ever touch `.env*` files
 * within a registered app — nothing else.
 */

import type { Dirent } from 'node:fs';
import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface EnvFileInfo {
  /** Path relative to the app dir (forward-slashed). */
  path: string;
  /** Bare file name. */
  name: string;
  size: number;
  modifiedAt: number;
}

/** Dirs never worth walking for env files (and huge/noisy). */
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  'vendor',
  '.turbo',
  '.cache',
  'tmp',
]);
const MAX_DEPTH = 2;
const MAX_FILES = 200;
const MAX_BYTES = 1_000_000;

/** Does this basename look like a dotenv file? (.env, .env.prod, env.sample, local.env) */
export function isEnvFileName(name: string): boolean {
  return /^\.?env(\.[^/]+)?$/i.test(name) || /\.env$/i.test(name);
}

/** Recursively list an app's env files (bounded depth), newest first. */
export async function listAppEnvFiles(appRoot: string): Promise<EnvFileInfo[]> {
  const out: EnvFileInfo[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isEnvFileName(entry.name)) continue;
      try {
        const st = await stat(abs);
        out.push({
          path: relative(appRoot, abs).split(sep).join('/'),
          name: entry.name,
          size: st.size,
          modifiedAt: st.mtimeMs,
        });
      } catch {
        // vanished between readdir and stat — skip
      }
    }
  }

  await walk(appRoot, 0);
  out.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
  return out;
}

type ResolvedEnv = { ok: true; abs: string; rel: string } | { ok: false; status: number; error: string };

/**
 * Resolve a relative env-file path against an app dir, refusing escape + non-env
 * names. Realpath-checks the parent dir (the file itself may not exist yet on a
 * write) so a symlinked dir can't point writes outside the app.
 */
async function resolveEnvPath(appRoot: string, requested: string): Promise<ResolvedEnv> {
  const cleaned = requested.trim();
  if (!cleaned) return { ok: false, status: 400, error: 'no path given' };
  const abs = resolve(appRoot, cleaned);
  const rel = relative(appRoot, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, status: 403, error: 'path is outside the app and was refused' };
  }
  const name = rel.split(sep).pop() ?? rel;
  if (!isEnvFileName(name)) return { ok: false, status: 403, error: 'not an .env file' };
  try {
    const realRoot = await realpath(appRoot);
    const realParent = await realpath(dirname(abs));
    if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
      return { ok: false, status: 403, error: 'path escapes the app and was refused' };
    }
  } catch {
    return { ok: false, status: 404, error: 'no such directory' };
  }
  return { ok: true, abs, rel: rel.split(sep).join('/') };
}

export type EnvFileRead =
  | { ok: true; info: EnvFileInfo; content: string }
  | { ok: false; status: number; error: string };

/** Read one env file's text (must exist; capped). */
export async function readAppEnvFile(appRoot: string, requested: string): Promise<EnvFileRead> {
  const r = await resolveEnvPath(appRoot, requested);
  if (!r.ok) return r;
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(r.abs);
  } catch {
    return { ok: false, status: 404, error: 'no such file' };
  }
  if (!st.isFile()) return { ok: false, status: 400, error: 'not a file' };
  if (st.size > MAX_BYTES) return { ok: false, status: 413, error: `file too large (${st.size} bytes)` };
  const content = await Bun.file(r.abs).text();
  return {
    ok: true,
    content,
    info: { path: r.rel, name: r.rel.split('/').pop() ?? r.rel, size: st.size, modifiedAt: st.mtimeMs },
  };
}

export type EnvFileWrite = { ok: true; info: EnvFileInfo } | { ok: false; status: number; error: string };

/** Write one env file's text (creating it if absent; capped). */
export async function writeAppEnvFile(appRoot: string, requested: string, content: string): Promise<EnvFileWrite> {
  if (typeof content !== 'string') return { ok: false, status: 400, error: 'content must be a string' };
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    return { ok: false, status: 413, error: `content too large (max ${MAX_BYTES} bytes)` };
  }
  const r = await resolveEnvPath(appRoot, requested);
  if (!r.ok) return r;
  await mkdir(dirname(r.abs), { recursive: true });
  await writeFile(r.abs, content, 'utf8');
  const st = await stat(r.abs);
  return {
    ok: true,
    info: { path: r.rel, name: r.rel.split('/').pop() ?? r.rel, size: st.size, modifiedAt: st.mtimeMs },
  };
}
