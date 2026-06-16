/**
 * Live, read-only extras about a single app for the web UI's Apps detail view:
 * its README (rendered as markdown by the UI) and current git working-tree state.
 *
 * Everything here is best-effort — a missing path, a non-repo, or no README all
 * degrade gracefully to an absent field rather than an error, so the detail view
 * always renders whatever is available.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../lib/apps';
import { aheadBehind, currentBranch, isGitRepo, statusEntries } from '../lib/git';
import type { AppDetails, AppGitStatus, AppReadme } from '../shared/types';
import { getAppSources } from './appOverview';

/** README filenames we look for, in preference order (first match wins). */
const README_CANDIDATES = ['README.md', 'README.markdown', 'Readme.md', 'readme.md', 'README.txt', 'README'];

/** Cap so a giant README can't bloat the response. */
const MAX_README_CHARS = 100_000;

async function findReadme(dir: string): Promise<AppReadme | undefined> {
  for (const name of README_CANDIDATES) {
    try {
      const content = await readFile(join(dir, name), 'utf8');
      return { name, content: content.slice(0, MAX_README_CHARS) };
    } catch {
      // not this candidate — try the next
    }
  }
  return undefined;
}

async function gitStatus(dir: string): Promise<AppGitStatus> {
  if (!(await isGitRepo(dir))) return { isRepo: false, entries: [] };
  const [branch, entries, ab] = await Promise.all([currentBranch(dir), statusEntries(dir), aheadBehind(dir)]);
  return { isRepo: true, branch, entries, ahead: ab?.ahead, behind: ab?.behind };
}

/** Gather README + git status + applicable-systems for one app. All best-effort. */
export async function appDetails(app: AppConfig): Promise<AppDetails> {
  const dir = app.absolutePath;
  const [readme, git, sources] = await Promise.all([findReadme(dir), gitStatus(dir), getAppSources(app)]);
  return { app: app.name, readme, git, sources };
}
