#!/usr/bin/env bun
/**
 * startprs  (installed as a shell function)
 *
 * Open a GitHub PR for each app currently on a pushed feature branch (via the
 * `gh` CLI). Outward-facing: previews and asks before creating, unless --yes.
 * Skips apps on their default branch, without an upstream, or with
 * ignoreCommandTypes: ["git"].
 *
 * Usage (after rubato-setup):
 *   startprs [app|group] [--title <t>] [--base <branch>] [--dry-run] [--yes]
 */

import { $ } from 'bun';
import { selectApps } from '../lib/appSelect';
import { loadApps } from '../lib/apps';
import { currentBranch, defaultBranch, git, isGitRepo } from '../lib/git';

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

interface Candidate {
  name: string;
  repo: string;
  branch: string;
  base: string;
}

async function main(): Promise<void> {
  if (!Bun.which('gh')) {
    console.error('startprs: the GitHub CLI (gh) is not installed / not on PATH.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const title = getOpt(args, 'title');
  const baseOverride = getOpt(args, 'base');
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes');
  const filter = args.find((a) => !a.startsWith('--') && a !== title && a !== baseOverride);

  const apps = selectApps(await loadApps(), { filter, command: 'git' });

  // Find repos on a pushed feature branch.
  const candidates: Candidate[] = [];
  for (const app of apps) {
    const repo = app.absolutePath;
    if (!(await isGitRepo(repo))) continue;
    const branch = await currentBranch(repo);
    const base = baseOverride ?? (await defaultBranch(repo));
    if (branch === base) continue; // not a feature branch
    if ((await git(repo, ['rev-parse', '--abbrev-ref', '@{upstream}'])).code !== 0) {
      console.error(`  skip ${app.name}: "${branch}" has no upstream (push it first).`);
      continue;
    }
    candidates.push({ name: app.name, repo, branch, base });
  }

  if (candidates.length === 0) {
    console.log('No repos on a pushed feature branch.');
    return;
  }

  console.log(`PRs to open (${candidates.length}):`);
  for (const c of candidates) console.log(`  ${c.name}: ${c.branch} → ${c.base}`);

  if (dryRun) {
    console.log('\n🔎 Dry run — no PRs created.');
    return;
  }
  if (!yes) {
    const answer = prompt(`\nOpen ${candidates.length} PR(s)? [y/N]`);
    if (!answer || !/^y(es)?$/i.test(answer.trim())) {
      console.log('Aborted.');
      return;
    }
  }

  let opened = 0;
  for (const c of candidates) {
    const ghArgs = ['--base', c.base, '--head', c.branch, ...(title ? ['--title', title, '--body', ''] : ['--fill'])];
    const res = await $`gh pr create ${ghArgs}`.cwd(c.repo).nothrow().quiet();
    if (res.exitCode === 0) {
      console.log(`✅ ${c.name}: ${res.stdout.toString().trim()}`);
      opened++;
    } else {
      console.error(`❌ ${c.name}: ${res.stderr.toString().trim()}`);
    }
  }
  console.log(`\nDone — opened ${opened}/${candidates.length} PR(s).`);
}

if (import.meta.main) await main();
