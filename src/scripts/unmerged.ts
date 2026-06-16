#!/usr/bin/env bun

/**
 * unmerged  (installed as a shell function)
 *
 * Find local branches carrying work that isn't in the remote default branch yet
 * — across your apps, a group, or one app. For each repo, every local branch
 * with commits not in origin/<default> is listed with how far ahead/behind it
 * is. Read-only. Compares against your last fetch — run `pull` first to refresh.
 *
 * Usage (after rubato-setup):
 *   unmerged            # every app
 *   unmerged github     # apps in the "github" group
 *   unmerged myapp      # just the "myapp" app
 */

import { selectApps } from '../lib/appSelect';
import { loadApps } from '../lib/apps';
import { emitDataReport } from '../lib/dataReport';
import { aheadBehindRefs, defaultBranch, isGitRepo, localBranches, refExists } from '../lib/git';

interface UnmergedBranch {
  branch: string;
  ahead: number;
  behind: number;
}

interface UnmergedApp {
  name: string;
  base: string;
  branches: UnmergedBranch[];
}

async function inspectApp(name: string, repo: string): Promise<UnmergedApp | null> {
  if (!(await isGitRepo(repo))) return null;

  const def = await defaultBranch(repo);
  // Compare against the remote default when present, else the local one.
  const base = (await refExists(repo, `origin/${def}`)) ? `origin/${def}` : def;

  const branches = (await localBranches(repo)).filter((b) => b !== def);
  const scored = await Promise.all(
    branches.map(async (branch) => ({ branch, ...(await aheadBehindRefs(repo, base, branch)) })),
  );
  const unmerged = scored.filter((s) => s.ahead > 0); // nothing the base doesn't already have
  return unmerged.length ? { name, base, branches: unmerged } : null;
}

const COLUMNS = ['app', 'base', 'branch', 'ahead', 'behind'];

async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = process.argv.slice(2);
  const filter = args.find((a) => !a.startsWith('--'));
  const apps = selectApps(await loadApps(), { filter });

  // Every repo (and every branch within it) is inspected in parallel.
  const results = (await Promise.all(apps.map((app) => inspectApp(app.name, app.absolutePath)))).filter(
    (r): r is UnmergedApp => r !== null,
  );

  for (const r of results) {
    console.log(`${r.name}  (vs ${r.base})`);
    for (const b of r.branches) console.log(`  ${b.branch}  +${b.ahead}${b.behind ? ` -${b.behind}` : ''}`);
  }

  console.log(
    results.length
      ? `\n${results.length} app(s) with unmerged work.`
      : 'No unmerged local work — everything is in the default branch.',
  );

  const rows = results.flatMap((r) =>
    r.branches.map((b) => ({ app: r.name, base: r.base, branch: b.branch, ahead: b.ahead, behind: b.behind })),
  );
  await emitDataReport({
    overview: {
      command: 'unmerged',
      generatedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      args,
      summary: { apps: results.length, branches: rows.length },
    },
    rows,
    columns: COLUMNS,
  });
}

if (import.meta.main) await main();
