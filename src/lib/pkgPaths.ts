/**
 * Layout-agnostic path resolution for rubato.
 *
 * rubato runs in two layouts: the **dev** source checkout (`src/…`, raw `.ts`)
 * and a **published** package (a flat, minified `dist/` — no `src/`). Anything
 * that resolves a sibling file relative to `import.meta.dir` breaks when the code
 * is bundled, because bundling moves files. These helpers resolve from the
 * package root (the dir holding `package.json`) instead, so the same code works
 * in both layouts.
 */

import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/**
 * Nearest ancestor directory containing a `package.json`, starting at `from`.
 * In dev this is the repo root; in a published package it's the install dir.
 * Falls back to `from` if none is found (shouldn't happen for an installed pkg).
 */
export function findPackageRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from; // reached the filesystem root
    dir = parent;
  }
}

/**
 * Resolve a registered command/helper script to a runnable file. In dev the raw
 * `.ts` under `src/` exists and is run directly; in a published package only the
 * bundled `dist/scripts/<name>.js` ships, so fall back to that.
 *
 * @param root  package root (from {@link findPackageRoot})
 * @param relScript  repo-relative source path, e.g. `src/scripts/goto.ts`
 */
export function resolveScript(root: string, relScript: string): string {
  const dev = resolve(root, relScript);
  if (existsSync(dev)) return dev;
  const name = basename(relScript).replace(/\.(ts|mjs|js)$/, '');
  return resolve(root, 'dist', 'scripts', `${name}.js`);
}
