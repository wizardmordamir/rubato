/**
 * Per-app git LOG for the Apps detail page: recent commits with metadata, and the
 * diff a single commit introduced (reusing the GitHub-style DiffBrowser via the
 * same files/per-file/full shape as the working-tree + stash diffs). All local git.
 */

import type { AppConfig } from '../lib/apps';
import { type DiffFile, git, isGitRepo } from '../lib/git';
import { parseDiffNameStatus } from './appGit';

export interface AppCommit {
  /** Full SHA. */
  sha: string;
  /** Abbreviated SHA. */
  shortSha: string;
  subject: string;
  author: string;
  email: string;
  /** Relative age, e.g. "3 hours ago". */
  relativeDate: string;
  /** Committer date, ISO-8601. */
  date: string;
}

const US = '\x1f'; // field separator
const RS = '\x1e'; // record separator (commit terminator)
const LOG_FORMAT = `${['%H', '%h', '%s', '%an', '%ae', '%cr', '%cI'].join(US)}${RS}`;

/** Parse `git log --format=…%x1e` output into commits. Pure. */
export function parseLog(text: string): AppCommit[] {
  const out: AppCommit[] = [];
  for (const rec of text.split(RS)) {
    const line = rec.replace(/^[\r\n]+/, '');
    if (!line.trim()) continue;
    const [sha = '', shortSha = '', subject = '', author = '', email = '', relativeDate = '', date = ''] =
      line.split(US);
    if (!sha) continue;
    out.push({ sha, shortSha, subject, author, email, relativeDate, date });
  }
  return out;
}

/** A ref we'll pass to git: a branch/tag/sha, never a flag or whitespace. */
const isSafeRef = (ref: unknown): ref is string =>
  typeof ref === 'string' && ref.length > 0 && !ref.startsWith('-') && !/\s/.test(ref);
/** A commit sha (what the log hands back), validated before reaching `git show`. */
const isSha = (sha: unknown): sha is string => typeof sha === 'string' && /^[0-9a-f]{4,40}$/i.test(sha);

/** Recent commits on `ref` (default the current branch/HEAD). */
export async function getAppLog(
  app: AppConfig,
  opts: { ref?: string; limit?: number } = {},
): Promise<{ ok: boolean; commits: AppCommit[]; error?: string }> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir))) return { ok: false, commits: [], error: 'not a git repo' };
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 30;
  const args = ['log', `--max-count=${limit}`, `--format=${LOG_FORMAT}`];
  if (opts.ref && isSafeRef(opts.ref)) args.push(opts.ref);
  const r = await git(dir, args);
  if (r.code !== 0) return { ok: false, commits: [], error: r.stderr.trim() || 'git log failed' };
  return { ok: true, commits: parseLog(r.stdout) };
}

/** Files a commit changed (`git show` — handles root commits; `--format=` drops the header). */
export async function getAppCommitFiles(
  app: AppConfig,
  sha: string,
): Promise<{ ok: boolean; files: DiffFile[]; error?: string }> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir))) return { ok: false, files: [], error: 'not a git repo' };
  if (!isSha(sha)) return { ok: false, files: [], error: 'invalid commit' };
  const r = await git(dir, ['show', '--name-status', '--format=', sha]);
  if (r.code !== 0) return { ok: false, files: [], error: r.stderr.trim() || 'git show failed' };
  return { ok: true, files: parseDiffNameStatus(r.stdout) };
}

/** A unified diff of one file as a commit changed it. */
export async function getAppCommitFileDiff(
  app: AppConfig,
  sha: string,
  path: string,
): Promise<{ path: string; diff: string }> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir)) || !isSha(sha)) return { path, diff: '' };
  return { path, diff: (await git(dir, ['show', '--format=', sha, '--', path])).stdout };
}

/** A commit's whole combined diff. */
export async function getAppCommitFullDiff(app: AppConfig, sha: string): Promise<{ diff: string }> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir)) || !isSha(sha)) return { diff: '' };
  return { diff: (await git(dir, ['show', '--format=', sha])).stdout };
}
