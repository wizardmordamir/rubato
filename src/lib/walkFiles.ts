/**
 * Recursively list files under a directory, following symlinks and skipping the
 * usual noise (node_modules, .git, build output, OS junk). Generic walker — kept
 * separate so other commands can reuse it.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { type IgnoreLayer, isIgnored, parseGitignore } from './gitignore';

/** Directory names never descended into. */
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.idea',
  '.vscode',
  'tmp',
  'temp',
]);

/** Filename patterns never included (exact names or `*`-globs). */
const IGNORE_FILES = ['.DS_Store', '*.log', '*.tmp', '*.lock'];

function matchesGlob(name: string, pattern: string): boolean {
  if (!pattern.includes('*')) return name === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

export interface WalkedFile {
  /** Absolute path on disk. */
  fullPath: string;
  /** Path relative to the walk root. */
  relativePath: string;
}

export interface WalkOptions {
  /** Honor `.gitignore` files (nested, deepest wins) encountered during the walk. */
  respectGitignore?: boolean;
  /**
   * Extra ignore patterns (gitignore syntax) applied root-wide at lowest
   * precedence — e.g. {@link RUBATO_CONVENTION_IGNORES}. A repo `.gitignore` can
   * still re-include them with a `!` rule.
   */
  extraIgnores?: string[];
}

/** All (non-ignored) files under `root`, sorted by relative path. */
export async function walkFiles(root: string, options: WalkOptions = {}): Promise<WalkedFile[]> {
  const out: string[] = [];

  // Lowest-precedence layer: the extra/convention patterns, applied everywhere.
  const baseLayers: IgnoreLayer[] = [];
  if (options.extraIgnores?.length) {
    baseLayers.push({ base: '', rules: parseGitignore(options.extraIgnores.join('\n')) });
  }
  const filtering = options.respectGitignore || baseLayers.length > 0;

  async function recurse(dir: string, layers: IgnoreLayer[]): Promise<void> {
    let active = layers;
    if (options.respectGitignore) {
      try {
        const text = await readFile(join(dir, '.gitignore'), 'utf8');
        active = [...layers, { base: relative(root, dir), rules: parseGitignore(text) }];
      } catch {
        // no .gitignore here — keep the inherited layers
      }
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        try {
          const real = await stat(fullPath); // follow the link
          isDir = real.isDirectory();
          isFile = real.isFile();
        } catch {
          continue; // broken symlink
        }
      }

      if (isDir) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (filtering && isIgnored(active, relative(root, fullPath), true)) continue;
        await recurse(fullPath, active);
      } else if (isFile) {
        if (IGNORE_FILES.some((p) => matchesGlob(entry.name, p))) continue;
        if (filtering && isIgnored(active, relative(root, fullPath), false)) continue;
        out.push(fullPath);
      }
    }
  }

  await recurse(root, baseLayers);
  out.sort();
  return out.map((fullPath) => ({ fullPath, relativePath: relative(root, fullPath) }));
}
