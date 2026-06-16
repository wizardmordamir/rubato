/**
 * Per-app git TAG management for the Apps detail page: list an app's tags with
 * useful metadata (target commit + subject, date, lightweight vs annotated +
 * annotation message), create a tag on a commit, check a tag out (detached HEAD),
 * and delete a tag. All local git, no creds (never pushes — tags stay local until
 * the user pushes them).
 */

import type { AppConfig } from '../lib/apps';
import { checkout, currentBranch, git, isGitRepo, tagCommit } from '../lib/git';

export interface AppTag {
  name: string;
  /** Short SHA of the tagged commit (annotated tags are dereferenced). */
  commit: string;
  /** Subject line of the tagged commit. */
  subject?: string;
  /** Creator date, ISO-8601. */
  date?: string;
  /** Annotated (`git tag -a`) vs lightweight. */
  annotated: boolean;
  /** Annotation message subject (annotated tags only). */
  message?: string;
}

const US = '\x1f'; // field separator within a tag line
// name, objecttype, objectname, *objectname, creatordate, contents:subject, subject, *subject
const TAG_FORMAT = [
  '%(refname:short)',
  '%(objecttype)',
  '%(objectname:short)',
  '%(*objectname:short)',
  '%(creatordate:iso8601-strict)',
  '%(contents:subject)',
  '%(subject)',
  '%(*subject)',
].join(US);

/** Parse the `for-each-ref` tag output (US-separated fields, one tag per line). Pure. */
export function parseTagList(text: string): AppTag[] {
  const out: AppTag[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [name = '', type = '', obj = '', derefObj = '', date = '', annMsg = '', subj = '', derefSubj = ''] =
      line.split(US);
    if (!name) continue;
    const annotated = type === 'tag';
    out.push({
      name,
      commit: (annotated ? derefObj : obj) || obj,
      subject: (annotated ? derefSubj : subj) || undefined,
      date: date || undefined,
      annotated,
      message: annotated ? annMsg || undefined : undefined,
    });
  }
  return out;
}

/** Tag names we'll pass to git: non-empty, no whitespace/flag-like, no ref-illegal chars. */
const isValidTagName = (name: unknown): name is string =>
  typeof name === 'string' &&
  name.length > 0 &&
  !name.startsWith('-') &&
  !/[\s~^:?*[\\]/.test(name) &&
  !name.includes('..') &&
  !name.endsWith('.lock');

/** The app's tags, newest first, each with target-commit + annotation metadata. */
export async function getAppTags(app: AppConfig): Promise<{ ok: boolean; tags: AppTag[]; error?: string }> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir))) return { ok: false, tags: [], error: 'not a git repo' };
  const r = await git(dir, ['for-each-ref', '--sort=-creatordate', `--format=${TAG_FORMAT}`, 'refs/tags']);
  if (r.code !== 0) return { ok: false, tags: [], error: r.stderr.trim() || 'git for-each-ref failed' };
  return { ok: true, tags: parseTagList(r.stdout) };
}

export interface CreateTagResult {
  ok: boolean;
  error?: string;
}

/** Create a tag (annotated when `message` is given) on `ref` (default HEAD). */
export async function createAppTag(
  app: AppConfig,
  opts: { name?: unknown; ref?: unknown; message?: unknown; force?: boolean },
): Promise<CreateTagResult> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir))) return { ok: false, error: 'not a git repo' };
  if (!isValidTagName(opts.name)) return { ok: false, error: 'invalid tag name' };
  const ref = typeof opts.ref === 'string' && opts.ref.trim() ? opts.ref.trim() : undefined;
  const message = typeof opts.message === 'string' && opts.message.trim() ? opts.message.trim() : undefined;
  const r = await tagCommit(dir, opts.name, { ref, message, force: !!opts.force });
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() || 'git tag failed' };
}

export type TagAction = 'checkout' | 'delete';
const TAG_ACTIONS = new Set<TagAction>(['checkout', 'delete']);
export const isTagAction = (v: unknown): v is TagAction => typeof v === 'string' && TAG_ACTIONS.has(v as TagAction);

export interface TagActionResult {
  ok: boolean;
  action: TagAction;
  /** Branch/ref state after the action (e.g. the detached-HEAD label after checkout). */
  branch?: string;
  output?: string;
  error?: string;
}

/** Check out a tag (detached HEAD) or delete it. */
export async function runAppTagAction(app: AppConfig, action: TagAction, name: unknown): Promise<TagActionResult> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir))) return { ok: false, action, error: 'not a git repo' };
  if (!isValidTagName(name)) return { ok: false, action, error: 'invalid tag name' };

  if (action === 'delete') {
    const r = await git(dir, ['tag', '-d', name]);
    return r.code === 0
      ? { ok: true, action, output: r.stdout.trim() || undefined }
      : { ok: false, action, error: r.stderr.trim() || 'git tag -d failed' };
  }
  // checkout → detached HEAD at the tag
  const res = await checkout(dir, name);
  const branch = await currentBranch(dir).catch(() => undefined);
  return res.code === 0
    ? { ok: true, action, branch, output: (res.stdout || res.stderr).trim() || undefined }
    : { ok: false, action, branch, error: res.stderr.trim() || `git checkout exited ${res.code}` };
}
