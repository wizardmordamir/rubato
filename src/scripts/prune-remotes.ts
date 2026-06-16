#!/usr/bin/env bun

/**
 * prune-remotes  (installed as a shell function)
 *
 * Delete branches on origin across your apps — for clearing out stale or
 * abandoned work in bulk. Selects by the same filters as `remote-branches`;
 * at least one filter is REQUIRED so a bare invocation can't wipe every branch.
 * The default branch and origin/HEAD are never deletable.
 *
 * Safe by default: prints what it would delete and stops. Pass --yes to
 * actually push the deletions. Skips apps with ignoreCommandTypes: ["git"].
 *
 * Usage (after rubato-setup):
 *   prune-remotes --merged                      # preview merged-in branches
 *   prune-remotes --merged --yes                # delete them on origin
 *   prune-remotes --before 2025-01-01 --yes     # delete branches older than a date
 *   prune-remotes --name spike --yes            # delete branches whose name contains "spike"
 *   prune-remotes --author jane --stale 180     # jane's branches untouched 180+ days
 *   prune-remotes github --merged --yes         # only the "github" group
 */

import { selectApps } from '../lib/appSelect';
import { loadApps } from '../lib/apps';
import { filterRefs, git, isGitRepo, type RefFilter, scoredRemoteRefs } from '../lib/git';

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

interface PruneResult {
  name: string;
  names: string[]; // matched branch names
  deleted: number; // 0 in preview mode
  errors: { name: string; msg: string }[];
}

async function pruneApp(name: string, repo: string, refFilter: RefFilter, yes: boolean): Promise<PruneResult | null> {
  if (!(await isGitRepo(repo))) return null;
  const { refs } = await scoredRemoteRefs(repo); // always fetches a fresh view of origin
  const targets = filterRefs(refs, refFilter);
  if (targets.length === 0) return null;

  const names = targets.map((t) => t.name);
  if (!yes) return { name, names, deleted: 0, errors: [] };

  let deleted = 0;
  const errors: { name: string; msg: string }[] = [];
  for (const t of targets) {
    const res = await git(repo, ['push', 'origin', '--delete', t.name]);
    if (res.code === 0) deleted++;
    else errors.push({ name: t.name, msg: res.stderr.trim().split('\n')[0] });
  }
  return { name, names, deleted, errors };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const author = getOpt(args, 'author');
  const name = getOpt(args, 'name');
  const before = getOpt(args, 'before');
  const stale = getOpt(args, 'stale');
  const mergedOnly = args.includes('--merged');
  const yes = args.includes('--yes');
  const consumed = new Set([author, name, before, stale].filter(Boolean));
  const filter = args.find((a) => !a.startsWith('--') && !consumed.has(a));

  if (!author && !name && !before && !stale && !mergedOnly) {
    console.error(
      'prune-remotes: refusing to run without a filter. Use --merged, --before <date>, --author <name>, --name <substr>, or --stale <days>.',
    );
    process.exit(1);
  }

  const beforeDate = before ? new Date(before) : undefined;
  if (before && Number.isNaN(beforeDate?.getTime())) {
    console.error(`prune-remotes: could not parse --before "${before}" as a date.`);
    process.exit(1);
  }
  const staleDays = stale != null ? Number(stale) : undefined;
  if (stale != null && Number.isNaN(staleDays)) {
    console.error(`prune-remotes: --stale expects a number of days, got "${stale}".`);
    process.exit(1);
  }

  const apps = selectApps(await loadApps(), { filter, command: 'git' });
  const now = new Date();
  const refFilter: RefFilter = { author, name, before: beforeDate, staleDays, mergedOnly, now };

  // Fetch, score, and (when --yes) delete every app in parallel against a fresh
  // view of origin. Deletes within an app are sequential for clean attribution.
  const results = (await Promise.all(apps.map((app) => pruneApp(app.name, app.absolutePath, refFilter, yes)))).filter(
    (r): r is PruneResult => r !== null,
  );

  let matched = 0;
  let deleted = 0;
  for (const r of results) {
    matched += r.names.length;
    deleted += r.deleted;
    for (const e of r.errors) console.error(`${r.name}: could not delete origin/${e.name} — ${e.msg}`);
    if (!yes) console.log(`${r.name}: would delete ${r.names.length} — ${r.names.join(', ')}`);
    else console.log(`${r.name}: deleted ${r.deleted}/${r.names.length} — ${r.names.join(', ')}`);
  }

  if (!yes) {
    console.log(
      matched ? `\n${matched} remote branch(es) match. Re-run with --yes to delete.` : 'No matching remote branches.',
    );
  } else {
    console.log(deleted ? `\nDone — ${deleted} remote branch(es) deleted.` : 'No remote branches deleted.');
  }
}

if (import.meta.main) await main();
