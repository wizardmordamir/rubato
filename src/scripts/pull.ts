#!/usr/bin/env bun

/**
 * pull  (installed as a shell function)
 *
 * Get the latest code across your apps, a group, or one app. Fast-forward only:
 * each repo's current branch is pulled with --ff-only --prune, so it can never
 * create a merge commit or clobber local work. Repos with uncommitted changes
 * are skipped untouched. Skips apps with ignoreCommandTypes: ["git"].
 *
 * --default updates each repo's default branch (main/master) instead. When it's
 * not the checked-out branch, its ref is fast-forwarded in place (the working
 * tree and your current branch are untouched), so you can refresh main on every
 * app without leaving your feature branches.
 *
 * Usage (after rubato-setup):
 *   pull              # every app, current branch
 *   pull github       # apps in the "github" group
 *   pull --default    # update every app's default branch (main/master)
 */

import { selectApps } from '../lib/appSelect';
import { loadApps } from '../lib/apps';
import { emitDataReport } from '../lib/dataReport';
import { currentBranch, defaultBranch, ffPull, ffUpdateBranch, git, isGitRepo, statusEntries } from '../lib/git';

interface PullResult {
  name: string;
  branch: string;
  state: 'skipped' | 'uptodate' | 'updated' | 'failed';
  msg?: string;
}

async function pullApp(name: string, repo: string, useDefault: boolean): Promise<PullResult | null> {
  if (!(await isGitRepo(repo))) return null;
  const cur = await currentBranch(repo);
  const target = useDefault ? await defaultBranch(repo) : cur;

  // Refreshing a branch we're not on: fast-forward its ref without a checkout,
  // so uncommitted work on the current branch is irrelevant and stays put.
  if (target !== cur) {
    const before = (await git(repo, ['rev-parse', '--verify', '--quiet', target])).stdout.trim();
    const res = await ffUpdateBranch(repo, target);
    if (res.code !== 0) return { name, branch: target, state: 'failed', msg: res.stderr.trim().split('\n')[0] };
    const after = (await git(repo, ['rev-parse', '--verify', '--quiet', target])).stdout.trim();
    return { name, branch: target, state: before === after ? 'uptodate' : 'updated' };
  }

  // On the target branch: a normal ff-only pull, skipping if the tree is dirty.
  if ((await statusEntries(repo)).length > 0) return { name, branch: target, state: 'skipped' };
  const res = await ffPull(repo);
  if (res.code !== 0) return { name, branch: target, state: 'failed', msg: res.stderr.trim().split('\n')[0] };
  return { name, branch: target, state: /already up to date/i.test(res.stdout) ? 'uptodate' : 'updated' };
}

const COLUMNS = ['app', 'branch', 'state', 'msg'];

async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = process.argv.slice(2);
  const useDefault = args.includes('--default');
  const filter = args.find((a) => !a.startsWith('--'));
  const apps = selectApps(await loadApps(), { filter, command: 'git' });

  // Every repo pulls in parallel; results render in registry order below.
  const results = (await Promise.all(apps.map((app) => pullApp(app.name, app.absolutePath, useDefault)))).filter(
    (r): r is PullResult => r !== null,
  );

  let updated = 0;
  let failed = 0;
  for (const r of results) {
    if (r.state === 'skipped') console.log(`${r.name} [${r.branch}]: skipped — uncommitted changes`);
    else if (r.state === 'failed') {
      failed++;
      console.error(`${r.name} [${r.branch}]: failed — ${r.msg}`);
    } else if (r.state === 'uptodate') console.log(`${r.name} [${r.branch}]: up to date`);
    else {
      updated++;
      console.log(`${r.name} [${r.branch}]: updated`);
    }
  }

  const parts = [`${updated} updated`];
  if (failed) parts.push(`${failed} failed`);
  console.log(`\nDone — ${parts.join(', ')}.`);

  await emitDataReport({
    overview: {
      command: 'pull',
      generatedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      args,
      summary: {
        apps: results.length,
        updated,
        failed,
        skipped: results.filter((r) => r.state === 'skipped').length,
        uptodate: results.filter((r) => r.state === 'uptodate').length,
      },
    },
    rows: results.map((r) => ({ app: r.name, branch: r.branch, state: r.state, msg: r.msg ?? '' })),
    columns: COLUMNS,
  });
}

if (import.meta.main) await main();
