/**
 * Library import hygiene: importing `rubato` (or any library subpath) must never
 * pull in the local server, web UI, DB (`bun:sqlite`), or Playwright — only the
 * dedicated `rubato/server` entry may. This statically walks each published
 * entry's transitive import graph and fails if a forbidden module is reachable,
 * so the split can't silently regress (a stray `import "../server/..."` in a lib
 * module would break embedders that only want the toolkit).
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LIB_ENTRIES, SERVER_COUPLED_ENTRIES, SERVER_ENTRY } from '../../scripts/libEntries';

const ROOT = resolve(import.meta.dir, '../..');
const FORBIDDEN_BARE = new Set(['bun:sqlite', 'ws', 'playwright', 'playwright-core']);
const IMPORT_RE = /(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g;

const resolveRelative = (spec: string, fromFile: string): string | null => {
  const base = resolve(dirname(fromFile), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(c) && (c.endsWith('.ts') || c.endsWith('.tsx'))) return c;
  }
  return null;
};

/** Walk the transitive import graph from an entry; collect reachable forbidden bits. */
function reach(entry: string): { serverFiles: string[]; uiFiles: string[]; bare: string[] } {
  const seen = new Set<string>();
  const serverFiles: string[] = [];
  const uiFiles: string[] = [];
  const bare = new Set<string>();
  const stack = [resolve(ROOT, entry)];
  while (stack.length) {
    const file = stack.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const rel = file.slice(ROOT.length + 1);
    if (rel.startsWith('src/server/')) serverFiles.push(rel);
    if (rel.startsWith('ui/')) uiFiles.push(rel);
    let src = '';
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex walk
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      if (spec.startsWith('.')) {
        const f = resolveRelative(spec, file);
        if (f) stack.push(f);
      } else if (FORBIDDEN_BARE.has(spec)) {
        bare.add(spec);
      }
    }
  }
  return { serverFiles, uiFiles, bare: [...bare] };
}

describe('library import hygiene', () => {
  const libEntries = Object.entries(LIB_ENTRIES).filter(([name]) => !SERVER_COUPLED_ENTRIES.has(name));

  test.each(libEntries)("'%s' imports no server / UI / db / playwright", (_name, entry) => {
    const { serverFiles, uiFiles, bare } = reach(entry);
    expect({ serverFiles, uiFiles, bare }).toEqual({ serverFiles: [], uiFiles: [], bare: [] });
  });

  test('the dedicated server entry DOES pull in the server (the split is real)', () => {
    const { serverFiles, bare } = reach(LIB_ENTRIES[SERVER_ENTRY]);
    expect(serverFiles.length).toBeGreaterThan(0);
    expect(bare).toContain('bun:sqlite'); // it reaches the DB, as intended
  });

  test('package.json exports stays in sync with the entry map', async () => {
    const pkg = (await Bun.file(resolve(ROOT, 'package.json')).json()) as { exports: Record<string, string> };
    const expected = new Set(Object.keys(LIB_ENTRIES).map((n) => (n === 'index' ? '.' : `./${n}`)));
    // `./ui/*` entries are built by the separate Vite UI lib build (ui/dist-lib),
    // and `*.css` entries are static shipped stylesheets (e.g. `./styles.css`) —
    // both are excluded from this JS dist-entry drift check.
    const actual = new Set(
      Object.keys(pkg.exports).filter((k) => k !== './package.json' && !k.startsWith('./ui/') && !k.endsWith('.css')),
    );
    expect(actual).toEqual(expected);
  });
});
