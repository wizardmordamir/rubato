#!/usr/bin/env bun

/**
 * delete-branches  (installed as a shell function)
 *
 * Clean up local branches across your apps, a group, or one app. Three modes:
 *   --merged (default): branches already merged into the default branch
 *   --gone:             branches whose upstream was deleted on the remote
 *   --all:              every local branch except the default (force; clears
 *                       even unmerged work — preview with --dry-run first)
 *
 * Never deletes the default or currently-checked-out branch. Runs immediately;
 * pass --dry-run to preview. Skips apps with ignoreCommandTypes: ["git"].
 *
 * Usage (after rubato-setup):
 *   delete-branches [app|group] [--merged|--gone|--all] [--dry-run]
 */

import { selectApps } from '../lib/appSelect';
import { loadApps } from '../lib/apps';
import {
  checkedOutBranches,
  currentBranch,
  defaultBranch,
  git,
  goneBranches,
  isGitRepo,
  localBranches,
  mergedBranches,
} from '../lib/git';

type Mode = 'merged' | 'gone' | 'all';

async function candidatesFor(repo: string, mode: Mode, def: string): Promise<string[]> {
  if (mode === 'all') return localBranches(repo);
  if (mode === 'gone') return goneBranches(repo);
  return mergedBranches(repo, def);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const mode: Mode = args.includes('--all') ? 'all' : args.includes('--gone') ? 'gone' : 'merged';
  const filter = args.find((a) => !a.startsWith('--'));
  const apps = selectApps(await loadApps(), { filter, command: 'git' });

  let deleted = 0;
  for (const app of apps) {
    const repo = app.absolutePath;
    if (!(await isGitRepo(repo))) continue;

    const def = await defaultBranch(repo);
    const cur = await currentBranch(repo);
    const protectedBranches = await checkedOutBranches(repo); // checked out in any worktree
    const candidates = (await candidatesFor(repo, mode, def)).filter(
      (b) => b !== def && b !== cur && !protectedBranches.has(b),
    );
    if (candidates.length === 0) continue;

    if (dryRun) {
      console.log(`${app.name}: would delete ${candidates.length} (${candidates.join(', ')})`);
      continue;
    }
    // -d for merged (safe); -D for gone/all (may be unmerged).
    const flag = mode === 'merged' ? '-d' : '-D';
    for (const branch of candidates) {
      const res = await git(repo, ['branch', flag, branch]);
      if (res.code === 0) deleted++;
      else console.error(`${app.name}: could not delete ${branch} — ${res.stderr.trim()}`);
    }
    console.log(`${app.name}: deleted ${candidates.length} (${candidates.join(', ')})`);
  }

  if (!dryRun) {
    const none = mode === 'all' ? 'No deletable branches found.' : `No ${mode} branches to delete.`;
    console.log(deleted ? `\nDone — ${deleted} branch(es) deleted.` : none);
  }
}

if (import.meta.main) await main();
