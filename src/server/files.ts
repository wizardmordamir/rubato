/**
 * Browse and read the script-output files the server writes under the configured
 * output dir (default ~/.rubato/outputs): per-command `<command>.txt` captures and
 * any report files a script drops there (e.g. `shalist --out`). This is the data
 * behind the web UI's "Files" tab and the clickable output paths on the Runs page.
 *
 * Read-only and scoped to the output dir. The same guards the AI repo tools use
 * (`resolveRepoPath` — refuses `..`/escape + secret patterns) gate every path, plus
 * a realpath check so a symlink can't point outside the dir. Absolute paths are
 * accepted as long as they resolve back inside the output dir, so a `RunRecord`'s
 * absolute `outputPath` can be opened directly.
 */

import type { Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { resolveOutputDir } from '../lib/runStore';
import type { OutputFile } from '../shared/types';
import { resolveRepoPath } from './tools/safety';

/** Don't walk forever or list a runaway dir — bound the tree we surface. */
const MAX_FILES = 2000;
const MAX_DEPTH = 6;
/** Cap a single file we'll return inline (the UI viewer, not a download). */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Recursively list files (not dirs) under the output dir, newest first. */
export async function listOutputFiles(): Promise<OutputFile[]> {
  const root = await resolveOutputDir();
  const out: OutputFile[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir (or the output dir doesn't exist yet) → nothing
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.name.startsWith('.')) continue; // skip dotfiles (and would-be secrets)
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, abs);
      if (resolveRepoPath(root, rel).ok === false) continue; // secret-pattern files
      try {
        const st = await stat(abs);
        out.push({ path: rel, name: entry.name, size: st.size, modifiedAt: st.mtimeMs });
      } catch {
        // vanished between readdir and stat — skip
      }
    }
  }

  await walk(root, 0);
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

export type FileContent =
  | { ok: true; file: OutputFile; content: string }
  | { ok: false; status: number; error: string };

export type ResolvedFile =
  | { ok: true; realAbs: string; file: OutputFile }
  | { ok: false; status: number; error: string };

/**
 * Resolve + guard one output-file path (relative to the output dir, or an
 * absolute path that resolves inside it) to its real absolute path. Refuses
 * traversal, secret-pattern files, and symlink escape, and confirms it's a file.
 * The shared gate behind both reading (inline view) and downloading.
 */
export async function resolveOutputFile(requested: string): Promise<ResolvedFile> {
  const root = await resolveOutputDir();
  const resolved = resolveRepoPath(root, requested);
  if (!resolved.ok) return { ok: false, status: 403, error: resolved.error };

  // Symlink escape: the real path must still sit inside the (real) output dir.
  let realRoot: string;
  let realAbs: string;
  try {
    realRoot = await realpath(root);
    realAbs = await realpath(resolved.abs);
  } catch {
    return { ok: false, status: 404, error: 'no such file' };
  }
  const within = realAbs === realRoot || realAbs.startsWith(realRoot + sep);
  if (!within) return { ok: false, status: 403, error: 'path is outside the output dir and was refused' };

  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(realAbs);
  } catch {
    return { ok: false, status: 404, error: 'no such file' };
  }
  if (!st.isFile()) return { ok: false, status: 400, error: 'not a file' };

  return {
    ok: true,
    realAbs,
    file: {
      path: resolved.rel,
      name: resolved.rel.split('/').pop() ?? resolved.rel,
      size: st.size,
      modifiedAt: st.mtimeMs,
    },
  };
}

/**
 * Read one output file by path. Refuses traversal, secrets, symlink escape, and
 * files over the inline-view cap (use the download route for big files).
 */
export async function readOutputFile(requested: string): Promise<FileContent> {
  const resolved = await resolveOutputFile(requested);
  if (!resolved.ok) return resolved;
  if (resolved.file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `file too large to view (${resolved.file.size} bytes, max ${MAX_FILE_BYTES})`,
    };
  }
  const content = await Bun.file(resolved.realAbs).text();
  return { ok: true, file: resolved.file, content };
}
