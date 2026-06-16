#!/usr/bin/env bun

/**
 * tag  (installed as a shell function)
 *
 * Create a git tag on each app, a group, or one app — handy for stamping a
 * release/CRQ across many repos. Tags the current HEAD by default; --default
 * instead tags each repo's default branch (main/master) regardless of what's
 * checked out. Local by default; --push also pushes the tag to origin. Runs
 * immediately; pass --dry-run to preview. Skips apps with ignoreCommandTypes: ["git"].
 *
 * Usage (after rubato-setup):
 *   tag <tagText> [app|group] [--default] [--push] [--dry-run]
 */

import { selectApps } from '../lib/appSelect';
import { loadApps } from '../lib/apps';
import { currentBranch, defaultBranch, git, isGitRepo } from '../lib/git';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const push = args.includes('--push');
  const useDefault = args.includes('--default');
  const positional = args.filter((a) => !a.startsWith('--'));
  const [tagText, filter] = positional;

  if (!tagText) {
    console.error('usage: tag <tagText> [app|group] [--default] [--push] [--dry-run]');
    process.exit(1);
  }

  const apps = selectApps(await loadApps(), { filter, command: 'git' });

  let tagged = 0;
  for (const app of apps) {
    const repo = app.absolutePath;
    if (!(await isGitRepo(repo))) continue;
    const branch = useDefault ? await defaultBranch(repo) : await currentBranch(repo);

    if (dryRun) {
      console.log(`${app.name} [${branch}]: would tag "${tagText}"${push ? ' and push' : ''}`);
      continue;
    }

    // With --default, anchor the tag to the default branch's commit, not HEAD.
    const res = await git(repo, useDefault ? ['tag', tagText, branch] : ['tag', tagText]);
    if (res.code !== 0) {
      console.error(`${app.name}: could not tag — ${res.stderr.trim()}`);
      continue;
    }
    tagged++;
    let note = '';
    if (push) {
      const p = await git(repo, ['push', 'origin', tagText]);
      note = p.code === 0 ? ' (pushed)' : ` (push failed: ${p.stderr.trim()})`;
    }
    console.log(`${app.name} [${branch}]: tagged "${tagText}"${note}`);
  }

  if (!dryRun) console.log(tagged ? `\nDone — tagged ${tagged} repo(s).` : 'No repos tagged.');
}

if (import.meta.main) await main();
