#!/usr/bin/env bun
/**
 * scan-apps  (installed as `rubato-scan`)
 *
 * Recursively finds git repos under your codeDirs (~/code by default — set one
 * or more roots in ~/.rubato/config.json) and merges them into
 * ~/.rubato/apps.json. Derived fields (absolutePath, dirName, group,
 * repoName, packageJsonName) are refreshed on every scan; user-owned fields
 * (name, aliases, and any API metadata like gitlab/quay/rancher) are preserved.
 *
 * Linked git worktrees and submodules (where `.git` is a file, not a directory)
 * are skipped, as are `*-worktrees/` directories — transient feature checkouts
 * shouldn't pollute the registry with duplicates of a repo indexed elsewhere.
 *
 * Apps that have disappeared from disk are flagged `"missing": true` if you've
 * customized them (title/aliases/metadata), or dropped if they were purely
 * scan-derived — so your edits survive a move while stale entries clean up.
 *
 * An entry with `"pinned": true` is frozen: scan never refreshes its derived
 * fields, takes it over as managed, or flags it missing — handy for a repo you
 * want to keep hand-tuned, or any path you want immune to scans.
 *
 * Usage:
 *   bun run src/scripts/scan-apps.ts            # scan + merge
 *   bun run src/scripts/scan-apps.ts --dry-run  # report without writing
 */

import { readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  type AppConfig,
  type Conflict,
  hasUserData,
  loadApps,
  readPackageName,
  readRepoName,
  saveApps,
  validateAppsDetailed,
} from '../lib/apps';
import { APPS_FILE, loadConfig } from '../lib/config';

/**
 * Render one registry conflict as a multi-line block that names *where* each
 * clashing value comes from. Paths are printed bare so terminals linkify them —
 * cmd+click jumps to the offending package.json / repo dir / the registry file.
 */
function formatConflict(c: Conflict): string[] {
  if (c.kind === 'match-key') {
    const w = Math.max(...c.apps.map((a) => a.name.length));
    const rows = c.apps.map((a) => {
      const src = a.sources?.[0];
      const detail = src ? `${src.label}  →  ${src.path}` : a.path;
      return `      ${a.name.padEnd(w)}   ${detail}`;
    });
    return [
      `  • Match key "${c.key}" claimed by ${c.apps.length} apps:`,
      ...rows,
      '    Fix: rename one, clear the clashing field, or move it to an alias.',
    ];
  }
  if (c.kind === 'duplicate-name') {
    return [
      `  • Duplicate name "${c.key}" — ${c.apps.length} apps share it:`,
      ...c.apps.map((a) => `      ${a.path}`),
      `    Fix: rename one in ${APPS_FILE}.`,
    ];
  }
  return [
    `  • Duplicate path — ${c.apps.length} entries point at ${c.key}:`,
    ...c.apps.map((a) => `      ${a.name}`),
    `    Fix: remove the duplicate entry in ${APPS_FILE}.`,
  ];
}

/** Directories we never descend into while looking for repos. */
const PRUNE = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.cache', 'vendor', 'target']);

/** Walk `root`, returning the path of every git repo (not descending into one). */
async function findRepos(root: string, ignore: Set<string>, maxDepth = 6): Promise<string[]> {
  const repos: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }

    // A `.git` entry marks a repo. When it's a directory this is a normal repo;
    // when it's a file ("gitdir:" pointer) it's a linked worktree or submodule —
    // skip those from the registry. Either way, stop descending.
    const gitEntry = entries.find((e) => e.name === '.git');
    if (gitEntry) {
      if (gitEntry.isDirectory()) repos.push(dir);
      return;
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue; // skips symlinks too → no loops
      if (e.name.startsWith('.') || PRUNE.has(e.name) || ignore.has(e.name)) continue;
      if (e.name.endsWith('-worktrees')) continue; // worktree container convention
      await walk(resolve(dir, e.name), depth + 1);
    }
  }

  await walk(root, 0);
  return repos;
}

/** True when `repoPath` lives under `root`. */
function contains(root: string, repoPath: string): boolean {
  const rel = relative(root, repoPath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Group label = the repo's parent relative to the configured root that contains
 * it. With multiple (possibly nested) roots, the most specific — longest — match
 * wins so the label stays short. Returns null for a repo sitting at a root.
 */
function computeGroup(roots: string[], repoPath: string): string | null {
  const root = roots.filter((r) => contains(r, repoPath)).sort((a, b) => b.length - a.length)[0];
  if (!root) return null;
  const rel = relative(root, dirname(repoPath));
  return rel === '' ? null : rel;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const cfg = await loadConfig();
  const roots = cfg.codeDirs;
  console.log(`Scanning ${roots.join(', ')} ...`);

  // Union repos across all roots; dedupe so nested/overlapping roots don't double-count.
  const ignore = new Set(cfg.ignore);
  const repos: string[] = [];
  const seenRepo = new Set<string>();
  for (const root of roots) {
    for (const repoPath of await findRepos(root, ignore)) {
      if (!seenRepo.has(repoPath)) {
        seenRepo.add(repoPath);
        repos.push(repoPath);
      }
    }
  }
  const apps = await loadApps();
  const byPath = new Map(apps.map((a) => [a.absolutePath, a]));
  const discovered = new Set<string>();

  let updated = 0;
  let pinned = 0;
  const newApps: AppConfig[] = [];

  for (const repoPath of repos) {
    discovered.add(repoPath);
    const existing = byPath.get(repoPath);

    // A pinned entry is frozen: don't refresh its derived fields or take it over
    // as managed, even though scan found a repo here. Count it but leave it as-is.
    if (existing?.pinned) {
      pinned++;
      continue;
    }

    const dirName = basename(repoPath);
    const derived = {
      absolutePath: repoPath,
      dirName,
      group: computeGroup(roots, repoPath),
      packageJsonName: await readPackageName(repoPath),
      repoName: await readRepoName(repoPath, dirName),
      managed: true,
      missing: false,
    };

    if (existing) {
      Object.assign(existing, derived); // refresh derived, keep name/aliases/api
      updated++;
    } else {
      const app: AppConfig = { name: dirName, aliases: [], ...derived };
      apps.push(app);
      byPath.set(repoPath, app);
      newApps.push(app);
    }
  }

  // Reconcile managed entries not rediscovered this scan: preserve the ones the
  // user customized (flag missing), drop the purely-derived ones (e.g. a removed
  // worktree or deleted repo) so the registry self-cleans. Pinned entries are
  // frozen — never flagged missing or removed, even when managed.
  const missingApps: AppConfig[] = [];
  let removed = 0;
  for (let i = apps.length - 1; i >= 0; i--) {
    const app = apps[i];
    if (app.pinned || !app.managed || discovered.has(app.absolutePath)) continue;
    if (hasUserData(app)) {
      app.missing = true;
      missingApps.push(app);
    } else {
      apps.splice(i, 1);
      removed++;
    }
  }

  apps.sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));

  const conflicts = validateAppsDetailed(apps);

  console.log(
    `Found ${repos.length} repos — ${newApps.length} new, ${updated} updated` +
      (pinned ? `, ${pinned} pinned (skipped)` : '') +
      (missingApps.length ? `, ${missingApps.length} missing` : '') +
      (removed ? `, ${removed} removed` : ''),
  );

  // Name what changed so the result is actionable, not just a count.
  if (newApps.length) {
    console.log(`\n🆕 New (${newApps.length}):`);
    for (const a of newApps) console.log(`      ${a.name}   ${a.absolutePath}`);
  }
  if (missingApps.length) {
    console.log(`\n👻 Missing — kept (you've customized these), but gone from disk:`);
    for (const a of missingApps) console.log(`      ${a.name}   ${a.absolutePath}`);
  }

  if (conflicts.length) {
    console.warn(`\n⚠️  ${conflicts.length} registry conflict(s) to resolve in ${APPS_FILE}:`);
    conflicts.forEach((c, i) => {
      if (i) console.warn('');
      for (const line of formatConflict(c)) console.warn(line);
    });
  }

  if (dryRun) {
    console.log('\n🔎 Dry run — apps.json not written.');
    return;
  }

  await saveApps(apps);
  console.log(`\n✅ Wrote ${apps.length} apps to ${APPS_FILE}`);
  if (newApps.length) {
    console.log('   Add aliases to new entries, then use: goto <alias>  /  gotab <alias>');
  }
}

if (import.meta.main)
  main().catch((err) => {
    console.error('❌ Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
