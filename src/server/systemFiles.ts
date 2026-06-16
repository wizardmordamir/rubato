/**
 * Read/write a small *allowlist* of editable "system files" so the rubato UI's
 * Docs hub (System Files page) can view and edit them: the user's global agent
 * instructions (`~/.claude/CLAUDE.md`), their shell rc/profile files, and
 * their git config.
 *
 * Security model: every editable path is a fixed, server-*derived* path keyed by
 * a stable `key` — the UI only ever sends a `key` (and, for writes, the new
 * content), NEVER a path. An unknown key resolves to nothing, so there is no
 * path-traversal surface and the only files this module can touch are the ones
 * listed in `SYSTEM_FILES`.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { APPS_FILE } from '../lib/config';
import type { SystemFileDoc, SystemFileInfo } from '../shared/types';

export type { SystemFileDoc, SystemFileInfo } from '../shared/types';

/** A sane cap so an accidental huge paste can't be written to disk. */
const MAX_BYTES = 1_000_000;

/**
 * The fixed path of the user's *global* agent instructions file (`CLAUDE.md`):
 * `$CLAUDE_CONFIG_DIR/CLAUDE.md`, else `~/.claude/CLAUDE.md`. Exported because the
 * config dir can be relocated (and tests isolate it via `CLAUDE_CONFIG_DIR`).
 */
export function globalClaudePath(): string {
  const base = process.env.CLAUDE_CONFIG_DIR?.trim() || resolve(homedir(), '.claude');
  return resolve(base, 'CLAUDE.md');
}

/** A path under the user's home dir. */
function home(...parts: string[]): string {
  return resolve(homedir(), ...parts);
}

/** One allowlist entry: a stable key + label + a *derived* (never caller-supplied) path. */
interface SystemFileSpec {
  key: string;
  label: string;
  /** Resolved lazily so test-time `CLAUDE_CONFIG_DIR`/home overrides are honored. */
  resolvePath: () => string;
  /** Offer a Markdown preview in the editor (true for `.md`). */
  markdown?: boolean;
}

/**
 * The editable files, in display order. The agent instructions file leads; then
 * the common shell + git dotfiles. Add an entry here to make a new file editable —
 * never accept a path from the client.
 */
const SYSTEM_FILES: SystemFileSpec[] = [
  { key: 'claude', label: 'Agent Instructions', resolvePath: globalClaudePath, markdown: true },
  { key: 'zshrc', label: '~/.zshrc', resolvePath: () => home('.zshrc') },
  { key: 'zprofile', label: '~/.zprofile', resolvePath: () => home('.zprofile') },
  { key: 'bashrc', label: '~/.bashrc', resolvePath: () => home('.bashrc') },
  { key: 'bash_profile', label: '~/.bash_profile', resolvePath: () => home('.bash_profile') },
  { key: 'profile', label: '~/.profile', resolvePath: () => home('.profile') },
  { key: 'gitconfig', label: '~/.gitconfig', resolvePath: () => home('.gitconfig') },
  { key: 'gitignore_global', label: 'Global gitignore', resolvePath: () => home('.gitignore_global') },
  // The rubato app registry — edit apps.json directly (db/tags/apis overrides) here.
  { key: 'apps', label: 'App registry (apps.json)', resolvePath: () => APPS_FILE },
];

/** Look up an allowlist entry by key (or `undefined` for an unknown key). */
function specFor(key: string): SystemFileSpec | undefined {
  return SYSTEM_FILES.find((f) => f.key === key);
}

/** Does `path` exist as a regular file right now? */
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** List the editable system files (path + existence, no content). */
export async function listSystemFiles(): Promise<SystemFileInfo[]> {
  return Promise.all(
    SYSTEM_FILES.map(async (f) => {
      const path = f.resolvePath();
      return { key: f.key, label: f.label, path, markdown: !!f.markdown, exists: await fileExists(path) };
    }),
  );
}

/** Read one system file (its current contents, "" when absent), or `null` for an unknown key. */
export async function readSystemFile(key: string): Promise<SystemFileDoc | null> {
  const spec = specFor(key);
  if (!spec) return null;
  const path = spec.resolvePath();
  try {
    return {
      key: spec.key,
      label: spec.label,
      path,
      markdown: !!spec.markdown,
      exists: true,
      content: await readFile(path, 'utf8'),
    };
  } catch {
    return { key: spec.key, label: spec.label, path, markdown: !!spec.markdown, exists: false, content: '' };
  }
}

/**
 * Write one system file (creating its parent dir if needed) and return its new
 * state. Returns `null` for an unknown key; throws on a non-string / oversized body.
 */
export async function writeSystemFile(key: string, content: string): Promise<SystemFileDoc | null> {
  const spec = specFor(key);
  if (!spec) return null;
  if (typeof content !== 'string') throw new Error('content must be a string');
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    throw new Error(`content too large (max ${MAX_BYTES} bytes)`);
  }
  const path = spec.resolvePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return { key: spec.key, label: spec.label, path, markdown: !!spec.markdown, exists: true, content };
}
