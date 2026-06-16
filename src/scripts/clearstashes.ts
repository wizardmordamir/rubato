#!/usr/bin/env bun

/**
 * clearstashes  (installed as a shell function)
 *
 * Drop all git stashes across your apps, a group, or one app. Runs immediately;
 * pass --dry-run to preview. Skips apps with ignoreCommandTypes: ["git"].
 *
 * Usage (after rubato-setup):
 *   clearstashes [app|group] [--dry-run]
 */

import { selectApps } from '../lib/appSelect';
import { loadApps } from '../lib/apps';
import { git, isGitRepo, stashCount } from '../lib/git';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const filter = args.find((a) => !a.startsWith('--'));
  const apps = selectApps(await loadApps(), { filter, command: 'git' });

  let cleared = 0;
  for (const app of apps) {
    if (!(await isGitRepo(app.absolutePath))) continue;
    const count = await stashCount(app.absolutePath);
    if (count === 0) continue;

    if (dryRun) {
      console.log(`${app.name}: would clear ${count} stash(es)`);
      continue;
    }
    await git(app.absolutePath, ['stash', 'clear']);
    console.log(`${app.name}: cleared ${count} stash(es)`);
    cleared += count;
  }

  if (!dryRun) console.log(cleared ? `\nDone — ${cleared} stash(es) cleared.` : 'No stashes to clear.');
}

if (import.meta.main) await main();
