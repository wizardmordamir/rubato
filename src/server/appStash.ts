/**
 * Per-app git STASH management for the Apps detail page: list an app's stashes,
 * inspect each one (changed files + a unified diff, viewed either as the stash's
 * own captured changes or against the current working tree), and run drop / clear
 * / apply / pop. Apply & pop detect conflicts and hand back an `undoToken` so the
 * UI can offer a one-click revert to the pre-apply state (or send the user to
 * their editor to resolve). All local git, no creds.
 */

import type { AppConfig } from '../lib/apps';
import { type DiffFile, git, isGitRepo } from '../lib/git';
import { parseDiffNameStatus } from './appGit';

/** A single stash entry. */
export interface StashEntry {
  /** The git ref, e.g. `stash@{0}`. */
  ref: string;
  index: number;
  /** Stash subject line, e.g. "WIP on main: 1a2b3c msg" or a custom message. */
  message: string;
  /** Relative age, e.g. "3 hours ago". */
  relativeDate?: string;
  /** ISO timestamp. */
  date?: string;
}

/** What a stash diff compares against. */
export type StashDiffMode = 'stash' | 'worktree';

const US = '\x1f'; // field separator inside a stash-list entry

/** Parse `git stash list -z --format=%gd<US>%s<US>%cr<US>%ci` into entries. Pure. */
export function parseStashList(text: string): StashEntry[] {
  const out: StashEntry[] = [];
  for (const entry of text.split('\0')) {
    if (!entry.trim()) continue;
    const [ref = '', message = '', relativeDate = '', date = ''] = entry.split(US);
    const m = /^stash@\{(\d+)\}$/.exec(ref.trim());
    if (!m) continue;
    out.push({
      ref: ref.trim(),
      index: Number(m[1]),
      message: message.trim(),
      relativeDate: relativeDate.trim() || undefined,
      date: date.trim() || undefined,
    });
  }
  return out;
}

/** Only accept well-formed stash refs (these are passed as git args). */
const isStashRef = (ref: unknown): ref is string => typeof ref === 'string' && /^stash@\{\d+\}$/.test(ref);

/** The app's stash list (newest first, as git reports it). */
export async function getAppStashes(app: AppConfig): Promise<{ ok: boolean; stashes: StashEntry[]; error?: string }> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir))) return { ok: false, stashes: [], error: 'not a git repo' };
  const r = await git(dir, ['stash', 'list', '-z', `--format=%gd${US}%s${US}%cr${US}%ci`]);
  if (r.code !== 0) return { ok: false, stashes: [], error: r.stderr.trim() || 'git stash list failed' };
  return { ok: true, stashes: parseStashList(r.stdout) };
}

/** The `git diff` argument pair for a stash in the requested mode. */
const stashDiffArgs = (ref: string, mode: StashDiffMode): string[] => (mode === 'worktree' ? [ref] : [`${ref}^1`, ref]);

/** Files changed in a stash — its own captured changes, or vs the current tree. */
export async function getAppStashFiles(
  app: AppConfig,
  ref: string,
  mode: StashDiffMode,
): Promise<{ ok: boolean; files: DiffFile[]; error?: string }> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir))) return { ok: false, files: [], error: 'not a git repo' };
  if (!isStashRef(ref)) return { ok: false, files: [], error: 'invalid stash ref' };
  const r = await git(dir, ['diff', '--name-status', ...stashDiffArgs(ref, mode)]);
  if (r.code !== 0) return { ok: false, files: [], error: r.stderr.trim() || 'git diff failed' };
  return { ok: true, files: parseDiffNameStatus(r.stdout) };
}

/** A unified diff for one file in a stash, in the requested mode. */
export async function getAppStashFileDiff(
  app: AppConfig,
  ref: string,
  path: string,
  mode: StashDiffMode,
): Promise<{ path: string; diff: string }> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir)) || !isStashRef(ref)) return { path, diff: '' };
  return { path, diff: (await git(dir, ['diff', ...stashDiffArgs(ref, mode), '--', path])).stdout };
}

/** One combined unified diff of an entire stash, in the requested mode. */
export async function getAppStashFullDiff(app: AppConfig, ref: string, mode: StashDiffMode): Promise<{ diff: string }> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir)) || !isStashRef(ref)) return { diff: '' };
  return { diff: (await git(dir, ['diff', ...stashDiffArgs(ref, mode)])).stdout };
}

export type StashAction = 'drop' | 'clear' | 'apply' | 'pop' | 'undo';
const STASH_ACTIONS = new Set<StashAction>(['drop', 'clear', 'apply', 'pop', 'undo']);
export const isStashAction = (v: unknown): v is StashAction =>
  typeof v === 'string' && STASH_ACTIONS.has(v as StashAction);

export interface StashActionResult {
  ok: boolean;
  action: StashAction;
  /** Apply/pop left the working tree with merge conflicts. */
  conflicted?: boolean;
  /** Unmerged paths, when `conflicted`. */
  conflictedFiles?: string[];
  /** True when a `pop` actually dropped the stash (only on a clean apply). */
  popped?: boolean;
  /** Pre-apply snapshot ref. Present when `conflicted` so the UI can offer Undo. */
  undoToken?: string | null;
  output?: string;
  error?: string;
}

const lines = (s: string): string[] =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Apply a stash (optionally pop). Snapshots the pre-apply working tree first so a
 * conflicted apply is reversible. On conflict the stash is preserved (git keeps it)
 * and we return the unmerged files + an `undoToken`; a clean apply optionally drops
 * the stash (pop).
 */
async function applyStash(dir: string, ref: string, pop: boolean): Promise<StashActionResult> {
  const action: StashAction = pop ? 'pop' : 'apply';
  // `git stash create` captures the current (tracked) state as a dangling commit
  // WITHOUT touching the stash list — our restore point if the apply conflicts.
  const undoToken = (await git(dir, ['stash', 'create'])).stdout.trim() || null;
  const ap = await git(dir, ['stash', 'apply', ref]);
  const unmerged = lines((await git(dir, ['diff', '--name-only', '--diff-filter=U'])).stdout);

  if (unmerged.length > 0) {
    return {
      ok: true,
      action,
      conflicted: true,
      conflictedFiles: unmerged,
      undoToken,
      popped: false,
      output: (ap.stderr || ap.stdout).trim() || undefined,
    };
  }
  if (ap.code !== 0) {
    // Refused cleanly (e.g. would overwrite local changes) — nothing applied.
    return { ok: false, action, error: ap.stderr.trim() || 'git stash apply failed' };
  }
  if (pop) {
    const drop = await git(dir, ['stash', 'drop', ref]);
    if (drop.code !== 0) return { ok: false, action, error: drop.stderr.trim() || 'git stash drop failed' };
  }
  return { ok: true, action, conflicted: false, popped: pop };
}

/**
 * Undo a conflicted apply/pop: hard-reset to HEAD (clears the conflicted apply and
 * the unmerged index), then re-apply the pre-apply snapshot so any work-in-progress
 * the user had before is restored. The original stash is untouched (apply/pop don't
 * drop on conflict), so nothing is lost — the user can deal with it later.
 */
async function undoApply(dir: string, undoToken: string | null | undefined): Promise<StashActionResult> {
  const reset = await git(dir, ['reset', '--hard', 'HEAD']);
  if (reset.code !== 0) return { ok: false, action: 'undo', error: reset.stderr.trim() || 'git reset failed' };
  if (undoToken) {
    const restore = await git(dir, ['stash', 'apply', undoToken]);
    if (restore.code !== 0) {
      return { ok: false, action: 'undo', error: restore.stderr.trim() || 'could not restore pre-apply state' };
    }
  }
  return { ok: true, action: 'undo' };
}

/** Run a stash management action. `drop`/`apply`/`pop` need `ref`; `undo` needs `undoToken`. */
export async function runAppStashAction(
  app: AppConfig,
  opts: { action: StashAction; ref?: string; undoToken?: string | null },
): Promise<StashActionResult> {
  const dir = app.absolutePath;
  const { action, ref, undoToken } = opts;
  if (!(await isGitRepo(dir))) return { ok: false, action, error: 'not a git repo' };

  if (action === 'clear') {
    const r = await git(dir, ['stash', 'clear']);
    return r.code === 0
      ? { ok: true, action }
      : { ok: false, action, error: r.stderr.trim() || 'git stash clear failed' };
  }
  if (action === 'undo') return undoApply(dir, undoToken);

  if (!isStashRef(ref)) return { ok: false, action, error: 'invalid stash ref' };
  if (action === 'drop') {
    const r = await git(dir, ['stash', 'drop', ref]);
    return r.code === 0
      ? { ok: true, action }
      : { ok: false, action, error: r.stderr.trim() || 'git stash drop failed' };
  }
  return applyStash(dir, ref, action === 'pop');
}
