/**
 * Core scanning logic shared between the `rubato-scan` CLI and the
 * `POST /api/apps/run-scan` server endpoint.
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
} from './apps';

/** Directory names never descended into while looking for repos. */
export const SCAN_PRUNE = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '.cache',
  'vendor',
  'target',
]);

/** Walk `root`, returning the path of every git repo (not descending into one). */
export async function findRepos(root: string, ignore: Set<string>, maxDepth = 6): Promise<string[]> {
  const repos: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // A `.git` directory = real repo. A `.git` file = linked worktree/submodule — skip.
    const gitEntry = entries.find((e) => e.name === '.git');
    if (gitEntry) {
      if (gitEntry.isDirectory()) repos.push(dir);
      return;
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || SCAN_PRUNE.has(e.name) || ignore.has(e.name)) continue;
      if (e.name.endsWith('-worktrees')) continue;
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
 * Group label relative to the most-specific containing root.
 * Returns null for a repo sitting directly at a root.
 */
export function computeGroup(roots: string[], repoPath: string): string | null {
  const root = roots.filter((r) => contains(r, repoPath)).sort((a, b) => b.length - a.length)[0];
  if (!root) return null;
  const rel = relative(root, dirname(repoPath));
  return rel === '' ? null : rel;
}

export interface ScanResult {
  reposFound: number;
  newApps: AppConfig[];
  updatedCount: number;
  pinnedCount: number;
  missingApps: AppConfig[];
  removedCount: number;
  conflicts: Conflict[];
  dryRun: boolean;
}

/** Run the full rubato-scan merge against the given roots + ignore list. */
export async function runScan(opts: { roots: string[]; ignore: string[]; dryRun?: boolean }): Promise<ScanResult> {
  const { roots, ignore, dryRun = false } = opts;
  const ignoreSet = new Set(ignore);

  // Union repos across all roots, deduped.
  const repos: string[] = [];
  const seenRepo = new Set<string>();
  for (const root of roots) {
    for (const repoPath of await findRepos(root, ignoreSet)) {
      if (!seenRepo.has(repoPath)) {
        seenRepo.add(repoPath);
        repos.push(repoPath);
      }
    }
  }

  const apps = await loadApps();
  const byPath = new Map(apps.map((a) => [a.absolutePath, a]));
  const discovered = new Set<string>();

  let updatedCount = 0;
  let pinnedCount = 0;
  const newApps: AppConfig[] = [];

  for (const repoPath of repos) {
    discovered.add(repoPath);
    const existing = byPath.get(repoPath);

    if (existing?.pinned) {
      pinnedCount++;
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
      Object.assign(existing, derived);
      updatedCount++;
    } else {
      const app: AppConfig = { name: dirName, aliases: [], ...derived };
      apps.push(app);
      byPath.set(repoPath, app);
      newApps.push(app);
    }
  }

  // Reconcile managed entries not rediscovered: preserve customized (flag missing),
  // drop purely-derived ones.
  const missingApps: AppConfig[] = [];
  let removedCount = 0;
  for (let i = apps.length - 1; i >= 0; i--) {
    const app = apps[i];
    if (app.pinned || !app.managed || discovered.has(app.absolutePath)) continue;
    if (hasUserData(app)) {
      app.missing = true;
      missingApps.push(app);
    } else {
      apps.splice(i, 1);
      removedCount++;
    }
  }

  apps.sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));

  const conflicts = validateAppsDetailed(apps);

  if (!dryRun) {
    await saveApps(apps);
  }

  return { reposFound: repos.length, newApps, updatedCount, pinnedCount, missingApps, removedCount, conflicts, dryRun };
}
