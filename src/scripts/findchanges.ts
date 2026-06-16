#!/usr/bin/env bun

/**
 * findchanges  (installed as a shell function)
 *
 * Report which apps have uncommitted, unpushed, or stashed work — across your
 * whole code dir, a group, or a single app. Read-only.
 *
 * Also writes a structured data report (`findchanges.report.json` + `.csv`, a row
 * per app with counts) to the output dir — see lib/dataReport + the web UI's
 * "Output Files" tab.
 *
 * Usage (after rubato-setup):
 *   findchanges            # all apps
 *   findchanges github     # apps in the "github" group
 *   findchanges myapp      # just the "myapp" app
 */

import { selectApps } from '../lib/appSelect';
import { loadApps } from '../lib/apps';
import { emitDataReport } from '../lib/dataReport';
import { aheadBehind, currentBranch, isGitRepo, stashCount, statusEntries } from '../lib/git';

interface Change {
  name: string;
  branch: string;
  uncommitted: number;
  unpushed: number;
  stashed: number;
  bits: string[];
  path: string;
}

async function inspectApp(name: string, repo: string): Promise<Change | null> {
  if (!(await isGitRepo(repo))) return null;
  const [entries, ab, stashes] = await Promise.all([statusEntries(repo), aheadBehind(repo), stashCount(repo)]);
  const unpushed = ab && ab.ahead > 0 ? ab.ahead : 0;
  if (entries.length === 0 && !unpushed && stashes === 0) return null;

  const bits: string[] = [];
  if (entries.length) bits.push(`${entries.length} uncommitted`);
  if (unpushed) bits.push(`${unpushed} unpushed`);
  if (stashes) bits.push(`${stashes} stashed`);
  return {
    name,
    branch: await currentBranch(repo),
    uncommitted: entries.length,
    unpushed,
    stashed: stashes,
    bits,
    path: repo,
  };
}

const COLUMNS = ['app', 'branch', 'uncommitted', 'unpushed', 'stashed', 'path'];

async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = process.argv.slice(2);
  const filter = args.find((a) => !a.startsWith('--'));
  const apps = selectApps(await loadApps(), { filter });

  // Every repo is inspected in parallel; results render in registry order.
  const changes = (await Promise.all(apps.map((app) => inspectApp(app.name, app.absolutePath)))).filter(
    (c): c is Change => c !== null,
  );

  for (const c of changes) {
    console.log(`${c.name} [${c.branch}] — ${c.bits.join(', ')}`);
    console.log(`  ${c.path}`);
  }

  console.log(
    changes.length
      ? `\n${changes.length} app(s) with changes.`
      : 'All clean — nothing uncommitted, unpushed, or stashed.',
  );

  await emitDataReport({
    overview: {
      command: 'findchanges',
      generatedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      args,
      summary: {
        appsWithChanges: changes.length,
        uncommitted: changes.reduce((n, c) => n + c.uncommitted, 0),
        unpushed: changes.reduce((n, c) => n + c.unpushed, 0),
        stashed: changes.reduce((n, c) => n + c.stashed, 0),
      },
    },
    rows: changes.map((c) => ({
      app: c.name,
      branch: c.branch,
      uncommitted: c.uncommitted,
      unpushed: c.unpushed,
      stashed: c.stashed,
      path: c.path,
    })),
    columns: COLUMNS,
  });
}

if (import.meta.main) await main();
