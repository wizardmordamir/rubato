#!/usr/bin/env bun

/**
 * appstatus  (installed as a shell function)
 *
 * One consolidated git dashboard across your apps: per app, the current branch,
 * how many files are uncommitted, how many stashes are parked, and — for every
 * local branch — how far it is ahead/behind its origin upstream and whether it
 * still exists on the remote at all. Read-only.
 *
 * By default only apps with something noteworthy are shown (uncommitted work, a
 * stash, or any branch not perfectly in sync). `--all` includes fully-clean
 * apps. Ahead/behind reflect your last fetch — pass `--fetch` to refresh first.
 *
 * Usage (after rubato-setup):
 *   appstatus                 # noteworthy apps, all their local branches
 *   appstatus github          # apps in the "github" group
 *   appstatus myapp --fetch   # refresh origin first, then report just "myapp"
 *   appstatus --all           # include clean apps too
 *   appstatus --json          # machine-readable (also --csv)
 */

import { selectApps } from '../lib/appSelect';
import { loadApps } from '../lib/apps';
import { emitDataReport } from '../lib/dataReport';
import {
  type BranchTracking,
  branchTracking,
  currentBranch,
  fetchRemote,
  isGitRepo,
  remoteBranchSet,
  stashCount,
  statusEntries,
} from '../lib/git';
import { type Row, toCsv } from '../lib/output';

/** A local branch's display state, derived from tracking + whether origin has it. */
type BranchState = 'synced' | 'diverged' | 'gone' | 'untracked' | 'local';

interface BranchInfo {
  name: string;
  isCurrent: boolean;
  ahead: number;
  behind: number;
  existsRemotely: boolean;
  state: BranchState;
}

interface AppStatus {
  name: string;
  path: string;
  branch: string;
  uncommitted: number;
  stashes: number;
  branches: BranchInfo[];
  noteworthy: boolean;
}

/** Classify one local branch from its tracking record + the set of origin branches. */
export function classifyBranch(bt: BranchTracking, remote: Set<string>, current: string): BranchInfo {
  const onOrigin = bt.upstream !== '' || remote.has(bt.name);
  let state: BranchState;
  if (bt.gone) state = 'gone';
  else if (!bt.upstream) state = remote.has(bt.name) ? 'untracked' : 'local';
  else if (bt.ahead || bt.behind) state = 'diverged';
  else state = 'synced';
  return {
    name: bt.name,
    isCurrent: bt.name === current,
    ahead: bt.ahead,
    behind: bt.behind,
    existsRemotely: state === 'gone' || state === 'local' ? false : onOrigin,
    state,
  };
}

/** Human label for a branch's state. */
function stateLabel(b: BranchInfo): string {
  switch (b.state) {
    case 'synced':
      return 'in sync';
    case 'diverged': {
      const bits = [b.ahead ? `+${b.ahead}` : '', b.behind ? `-${b.behind}` : ''].filter(Boolean);
      return bits.join(' ');
    }
    case 'gone':
      return 'gone (upstream deleted on origin)';
    case 'untracked':
      return 'untracked (exists on origin)';
    case 'local':
      return 'local-only (not on origin)';
  }
}

async function inspectApp(name: string, repo: string, fetch: boolean): Promise<AppStatus | null> {
  if (!(await isGitRepo(repo))) return null;
  if (fetch) await fetchRemote(repo, { prune: true });

  const [branch, entries, stashes, tracking, remote] = await Promise.all([
    currentBranch(repo),
    statusEntries(repo),
    stashCount(repo),
    branchTracking(repo),
    remoteBranchSet(repo),
  ]);

  const branches = tracking.map((bt) => classifyBranch(bt, remote, branch));
  const noteworthy = entries.length > 0 || stashes > 0 || branches.some((b) => b.state !== 'synced');
  return { name, path: repo, branch, uncommitted: entries.length, stashes, branches, noteworthy };
}

function flatten(apps: AppStatus[]): Row[] {
  return apps.flatMap((a) =>
    a.branches.map((b) => ({
      app: a.name,
      branch: b.name,
      current: b.isCurrent ? 'yes' : '',
      ahead: b.ahead,
      behind: b.behind,
      remote: b.existsRemotely ? 'yes' : 'no',
      state: b.state,
      uncommitted: a.uncommitted,
      stashes: a.stashes,
    })),
  );
}

const CSV_COLUMNS = ['app', 'branch', 'current', 'ahead', 'behind', 'remote', 'state', 'uncommitted', 'stashes'];

async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const fetch = args.includes('--fetch');
  const asJson = args.includes('--json');
  const asCsv = args.includes('--csv');
  const filter = args.find((a) => !a.startsWith('--'));

  const apps = selectApps(await loadApps(), { filter });

  // Every repo is inspected in parallel; results render in registry order.
  const statuses = (await Promise.all(apps.map((app) => inspectApp(app.name, app.absolutePath, fetch)))).filter(
    (s): s is AppStatus => s !== null,
  );
  const shown = all ? statuses : statuses.filter((s) => s.noteworthy);

  // Always write the report (every output format), before the format branch returns.
  const rows = flatten(shown);
  await emitDataReport({
    overview: {
      command: 'appstatus',
      generatedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      args,
      summary: {
        apps: shown.length,
        branches: rows.length,
        uncommitted: shown.reduce((n, s) => n + s.uncommitted, 0),
        stashes: shown.reduce((n, s) => n + s.stashes, 0),
      },
    },
    rows,
    columns: CSV_COLUMNS,
  });

  if (asJson) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }
  if (asCsv) {
    console.log(toCsv(flatten(shown), CSV_COLUMNS));
    return;
  }

  if (shown.length === 0) {
    console.log('All clean — no uncommitted work, stashes, or out-of-sync branches.');
    return;
  }

  const width = Math.min(40, Math.max(...shown.flatMap((s) => s.branches.map((b) => b.name.length)), 0));
  for (const s of shown) {
    const bits: string[] = [];
    if (s.uncommitted) bits.push(`${s.uncommitted} uncommitted`);
    if (s.stashes) bits.push(`${s.stashes} stashed`);
    const head = `${s.name} [${s.branch}]${bits.length ? `  —  ${bits.join(', ')}` : ''}`;
    console.log(head);
    for (const b of s.branches) {
      const marker = b.isCurrent ? '*' : ' ';
      console.log(`  ${marker} ${b.name.padEnd(width)}  ${stateLabel(b)}`);
    }
    console.log(`    ${s.path}`);
  }

  console.log(`\n${shown.length} app(s)${all ? '' : ' with something to report'}.`);
}

if (import.meta.main) await main();
