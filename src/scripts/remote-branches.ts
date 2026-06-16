#!/usr/bin/env bun

/**
 * remote-branches  (installed as a shell function)
 *
 * Inspect branches on origin across your apps — what's lingering, who owns it,
 * how old it is, and how far it's diverged from the default branch. Read-only;
 * a companion to `prune-remotes`, which deletes by the same filters.
 *
 * Always fetches (pruning) first, every app in parallel, so the view is current.
 * Default branch and origin/HEAD are always excluded.
 *
 * Usage (after rubato-setup):
 *   remote-branches                       # all apps, every origin branch
 *   remote-branches github --stale 90     # github group, untouched 90+ days
 *   remote-branches --author jane         # branches whose tip author matches "jane"
 *   remote-branches --name release        # branch name contains "release"
 *   remote-branches --before 2026-01-01   # tip commit older than a date
 *   remote-branches --merged              # already merged into the default branch
 *   remote-branches --csv                 # emit CSV (also --json)
 */

import { selectApps } from '../lib/appSelect';
import { loadApps } from '../lib/apps';
import { emitDataReport } from '../lib/dataReport';
import { ageDays, filterRefs, isGitRepo, scoredRemoteRefs } from '../lib/git';
import { type Row, toCsv, toTable } from '../lib/output';

const COLUMNS = ['app', 'branch', 'author', 'updated', 'age', 'ahead', 'behind'];

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = process.argv.slice(2);
  const author = getOpt(args, 'author');
  const name = getOpt(args, 'name');
  const before = getOpt(args, 'before');
  const stale = getOpt(args, 'stale');
  const mergedOnly = args.includes('--merged');
  const asJson = args.includes('--json');
  const asCsv = args.includes('--csv');
  const consumed = new Set([author, name, before, stale].filter(Boolean));
  const filter = args.find((a) => !a.startsWith('--') && !consumed.has(a));

  const beforeDate = before ? new Date(before) : undefined;
  if (before && Number.isNaN(beforeDate?.getTime())) {
    console.error(`remote-branches: could not parse --before "${before}" as a date.`);
    process.exit(1);
  }
  const staleDays = stale != null ? Number(stale) : undefined;
  if (stale != null && Number.isNaN(staleDays)) {
    console.error(`remote-branches: --stale expects a number of days, got "${stale}".`);
    process.exit(1);
  }

  const apps = selectApps(await loadApps(), { filter });
  const now = new Date();

  // Fetch + score every app in parallel, then flatten into one ordered list.
  const perApp = await Promise.all(
    apps.map(async (app): Promise<Row[]> => {
      const repo = app.absolutePath;
      if (!(await isGitRepo(repo))) return [];
      const { refs } = await scoredRemoteRefs(repo);
      return filterRefs(refs, { author, name, before: beforeDate, staleDays, mergedOnly, now }).map((ref) => ({
        app: app.name,
        branch: ref.name,
        author: ref.author,
        updated: ref.date.slice(0, 10),
        age: `${ageDays(ref.date, now)}d`,
        ahead: ref.ahead,
        behind: ref.behind,
      }));
    }),
  );
  const rows = perApp.flat();

  await emitDataReport({
    overview: {
      command: 'remote-branches',
      generatedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      args,
      summary: {
        branches: rows.length,
        apps: new Set(rows.map((r) => r.app)).size,
        filters: {
          author: author ?? null,
          name: name ?? null,
          before: before ?? null,
          stale: stale ?? null,
          mergedOnly,
        },
      },
    },
    rows,
    columns: COLUMNS,
  });

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
  } else if (asCsv) {
    console.log(toCsv(rows, COLUMNS));
  } else if (rows.length === 0) {
    console.log('No matching remote branches.');
  } else {
    console.log(toTable(rows, COLUMNS));
    console.log(`\n${rows.length} remote branch(es).`);
  }
}

if (import.meta.main) await main();
