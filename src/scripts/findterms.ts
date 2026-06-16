#!/usr/bin/env bun
/**
 * findterms  (installed as a shell function)
 *
 * Search a directory tree for terms and report which "expected" terms appear
 * (and where) and which are missing, plus flag any "unexpected" terms that show
 * up. A lean Bun port of the old repo's build-output validator — handy for
 * asserting a build/bundle contains what it should and nothing it shouldn't.
 *
 * Each term is a JS regex (falls back to a literal substring if it isn't valid
 * regex), matched against file contents.
 *
 * Usage (after rubato-setup):
 *   findterms [dir] --expect foo,bar [--not baz,qux] [--ext .ts,.js]
 *             [--ignore-dir dist,coverage] [--throw]
 *
 *   dir            directory to search (default: current dir)
 *   --expect       terms that SHOULD be present (comma-separated, repeatable)
 *   --not          terms that should NOT be present (comma-separated, repeatable)
 *   --ext          only search files with these extensions
 *   --ignore-dir   extra directory names to skip (node_modules/.git always skipped)
 *   --throw        exit non-zero if any expected term is missing or any
 *                  unexpected term is found (use as a CI/build gate)
 */

import { resolve } from 'node:path';
import { Glob } from 'bun';

/** Directory names always pruned, zero-config. Extra ones come from --ignore-dir. */
const DEFAULT_IGNORE_DIRS = ['node_modules', '.git'];

export interface TermHit {
  term: string;
  files: string[];
}

export interface TermAnalysis {
  /** Expected terms that were found, with the files they appear in. */
  found: TermHit[];
  /** Expected terms with zero matches. */
  missing: string[];
  /** Unexpected terms that appeared (with files); should be empty. */
  unexpectedFound: TermHit[];
}

/** Compile a term into a matcher: regex if valid, else literal substring. */
function makeMatcher(term: string): (content: string) => boolean {
  try {
    const re = new RegExp(term);
    return (content) => re.test(content);
  } catch {
    return (content) => content.includes(term);
  }
}

/**
 * Pure core: given files (path + content) and the term lists, work out what's
 * found, missing, and unexpectedly present. Kept IO-free so it's unit-testable.
 */
export function analyzeTerms(
  files: { path: string; content: string }[],
  expected: string[],
  unexpected: string[],
): TermAnalysis {
  const scan = (terms: string[]): TermHit[] => {
    const hits: TermHit[] = [];
    for (const term of terms) {
      const match = makeMatcher(term);
      const matched = files.filter((f) => match(f.content)).map((f) => f.path);
      if (matched.length) hits.push({ term, files: matched });
    }
    return hits;
  };

  const found = scan(expected);
  const foundTerms = new Set(found.map((h) => h.term));
  const missing = expected.filter((t) => !foundTerms.has(t));
  const unexpectedFound = scan(unexpected);

  return { found, missing, unexpectedFound };
}

/** Walk `dir`, honoring extension and ignored-directory filters. */
async function collectFiles(
  dir: string,
  opts: { exts: string[]; ignoreDirs: string[] },
): Promise<{ path: string; content: string }[]> {
  const root = resolve(dir);
  const ignore = new Set([...DEFAULT_IGNORE_DIRS, ...opts.ignoreDirs]);
  const glob = new Glob('**/*');
  const out: { path: string; content: string }[] = [];

  for await (const rel of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
    if (rel.split('/').some((seg) => ignore.has(seg))) continue;
    if (opts.exts.length && !opts.exts.some((ext) => rel.endsWith(ext))) continue;
    const file = Bun.file(resolve(root, rel));
    try {
      out.push({ path: rel, content: await file.text() });
    } catch {
      // unreadable/binary file — skip it
    }
  }
  return out;
}

/** Collect a repeatable, comma-separated flag (--expect a,b --expect c → [a,b,c]). */
function listFlag(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1] !== undefined) {
      values.push(
        ...args[i + 1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      i++;
    }
  }
  return values;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--')) ?? '.';
  const expected = listFlag(args, '--expect');
  const unexpected = listFlag(args, '--not');
  const exts = listFlag(args, '--ext');
  const ignoreDirs = listFlag(args, '--ignore-dir');
  const shouldThrow = args.includes('--throw');

  if (expected.length === 0 && unexpected.length === 0) {
    console.error('findterms: nothing to search for — pass --expect and/or --not');
    console.error('usage: findterms [dir] --expect foo,bar [--not baz] [--ext .ts] [--ignore-dir dist] [--throw]');
    process.exit(1);
  }

  const files = await collectFiles(dir, { exts, ignoreDirs });
  const { found, missing, unexpectedFound } = analyzeTerms(files, expected, unexpected);

  console.log(`Searched ${files.length} file(s) under ${resolve(dir)}\n`);

  for (const hit of found) {
    console.log(`  ✓ ${hit.term}  —  ${hit.files.length} file(s)`);
    for (const f of hit.files) console.log(`      ${f}`);
  }
  for (const term of missing) console.log(`  ✗ ${term}  —  not found`);
  for (const hit of unexpectedFound) {
    console.log(`  ⚠ ${hit.term}  —  unexpected, in ${hit.files.length} file(s)`);
    for (const f of hit.files) console.log(`      ${f}`);
  }

  const failed = missing.length > 0 || unexpectedFound.length > 0;
  if (shouldThrow && failed) {
    console.error(`\nfindterms: ${missing.length} missing, ${unexpectedFound.length} unexpected`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
