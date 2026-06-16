/**
 * Per-app git quick-actions — the "updating dozens of apps at a time" workflow:
 * commit uncommitted work, checkout the default branch, and refresh from origin.
 * All local git (no creds), best-effort, and they report the resulting branch so
 * the UI/dashboard can reflect the change. A scoped slice of the larger repo-clone
 * / git-config task.
 */

import type { AppConfig } from '../lib/apps';
import {
  checkout,
  commitAll,
  currentBranch,
  type DiffFile,
  defaultBranch,
  diffNameStatus,
  discardAll,
  discardPaths,
  fetchRemote,
  ffPull,
  fileDiff,
  git,
  isGitRepo,
  stashPush,
} from '../lib/git';

export type AppGitAction = 'pull' | 'fetch' | 'checkoutDefault' | 'commitAll' | 'push';

export interface AppGitResult {
  ok: boolean;
  action: AppGitAction;
  /** The branch checked out after the action (best-effort). */
  branch?: string;
  /** Trimmed git stdout/stderr, for surfacing what happened. */
  output?: string;
  error?: string;
}

const ACTIONS = new Set<AppGitAction>(['pull', 'fetch', 'checkoutDefault', 'commitAll', 'push']);
export const isAppGitAction = (v: unknown): v is AppGitAction =>
  typeof v === 'string' && ACTIONS.has(v as AppGitAction);

export async function runAppGitAction(app: AppConfig, action: AppGitAction, message?: string): Promise<AppGitResult> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir))) {
    return { ok: false, action, error: 'not a git repo' };
  }

  let res: { code: number; stdout: string; stderr: string };
  switch (action) {
    case 'pull':
      res = await ffPull(dir);
      break;
    case 'fetch':
      res = await fetchRemote(dir, { prune: true });
      break;
    case 'checkoutDefault': {
      const def = await defaultBranch(dir);
      res = await checkout(dir, def);
      break;
    }
    case 'commitAll':
      res = await commitAll(dir, message?.trim() || 'WIP (committed via rubato)');
      break;
    case 'push': {
      // Push the current branch; set the upstream on first push (no upstream yet).
      const hasUpstream = (await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).code === 0;
      const branch = await currentBranch(dir);
      res = await git(dir, hasUpstream ? ['push'] : ['push', '--set-upstream', 'origin', branch]);
      break;
    }
    default:
      return { ok: false, action, error: `unknown action: ${action}` };
  }

  const output = (res.stdout || res.stderr).trim() || undefined;
  const branch = await currentBranch(dir).catch(() => undefined);
  return res.code === 0
    ? { ok: true, action, branch, output }
    : { ok: false, action, branch, output, error: res.stderr.trim() || `git exited ${res.code}` };
}

// ── Diff viewer (multi-base) ─────────────────────────────────────────────────

/**
 * What to diff the working tree against:
 *  - `head`        → the prior commit on this branch (uncommitted changes; `git diff HEAD`)
 *  - `main`        → the local default branch tip (everything that differs from main/master)
 *  - `origin-main` → the remote default branch tip (`origin/<default>`), if present
 */
export type DiffBase = 'head' | 'main' | 'origin-main';
const DIFF_BASES = new Set<DiffBase>(['head', 'main', 'origin-main']);
export const asDiffBase = (v: unknown): DiffBase => (DIFF_BASES.has(v as DiffBase) ? (v as DiffBase) : 'head');

export interface AppDiffSummary {
  ok: boolean;
  files: DiffFile[];
  /** Echo of the requested base + the ref it resolved to, for the UI label.
   *  Present on a list query (getAppDiff); omitted by post-action results. */
  base?: DiffBase;
  baseRef?: string;
  /** The repo's default branch name (for the "vs main/master" label + option). */
  defaultBranch?: string;
  /** Whether `origin/<default>` exists locally (so the UI can offer that base). */
  hasOriginDefault?: boolean;
  error?: string;
}

/** Map the requested base to a concrete git ref (and surface default-branch info). */
async function resolveBase(dir: string, base: DiffBase): Promise<{ ref: string; def: string; hasOrigin: boolean }> {
  const def = (await defaultBranch(dir).catch(() => 'main')) || 'main';
  const originRef = `origin/${def}`;
  const hasOrigin = (await git(dir, ['rev-parse', '--verify', '--quiet', originRef])).code === 0;
  let ref = 'HEAD';
  if (base === 'main') ref = def;
  else if (base === 'origin-main') ref = hasOrigin ? originRef : def;
  return { ref, def, hasOrigin };
}

const RENAME_ARROW = ' -> ';

/**
 * Parse `git diff --name-status <ref>` (working tree vs a ref) into a file list.
 * Lines are `M\tpath`, `A\tpath`, `D\tpath`, or `R<score>\told\tnew` (keep the new
 * path). Untracked files aren't in this output — callers add them separately. Pure.
 */
export function parseDiffNameStatus(text: string): DiffFile[] {
  const out: DiffFile[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const code = line[0];
    let path = line.slice(tab + 1);
    const arrow = path.indexOf(RENAME_ARROW);
    if (arrow >= 0) path = path.slice(arrow + RENAME_ARROW.length);
    if (path.includes('\t')) path = path.slice(path.lastIndexOf('\t') + 1); // R old\tnew form
    const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : 'modified';
    out.push({ path, status, untracked: false });
  }
  return out;
}

/** Untracked (and not git-ignored) files in the working tree. */
async function listUntracked(dir: string): Promise<DiffFile[]> {
  const r = await git(dir, ['ls-files', '--others', '--exclude-standard']);
  return r.stdout
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((path) => ({ path, status: 'untracked' as const, untracked: true }));
}

/**
 * The app's changed-file list for a given base. `head` is the uncommitted set
 * (staged + unstaged + untracked); `main`/`origin-main` is everything the working
 * tree differs from that branch by (tracked diffs vs the ref, plus untracked files).
 */
export async function getAppDiff(app: AppConfig, base: DiffBase = 'head'): Promise<AppDiffSummary> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir))) return { ok: false, files: [], base, baseRef: 'HEAD', error: 'not a git repo' };
  const { ref, def, hasOrigin } = await resolveBase(dir, base);
  const meta = { base, baseRef: ref, defaultBranch: def, hasOriginDefault: hasOrigin };
  if (base === 'head') return { ok: true, files: await diffNameStatus(dir), ...meta };
  const tracked = parseDiffNameStatus((await git(dir, ['diff', '--name-status', ref])).stdout);
  const untracked = await listUntracked(dir);
  return { ok: true, files: [...tracked, ...untracked], ...meta };
}

/** A unified diff for one path against `base` (untracked files diff as all-additions). */
export async function getAppFileDiff(
  app: AppConfig,
  path: string,
  untracked: boolean,
  base: DiffBase = 'head',
): Promise<{ path: string; diff: string }> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir))) return { path, diff: '' };
  if (untracked) return { path, diff: await fileDiff(dir, path, { untracked: true }) };
  const { ref } = await resolveBase(dir, base);
  return { path, diff: (await git(dir, ['diff', ref, '--', path])).stdout };
}

/** One combined unified diff of every change vs `base` (tracked + untracked appended). */
export async function getAppFullDiff(app: AppConfig, base: DiffBase = 'head'): Promise<{ diff: string }> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir))) return { diff: '' };
  const { ref } = await resolveBase(dir, base);
  const tracked = (await git(dir, ['diff', ref])).stdout;
  const untrackedFiles = await listUntracked(dir);
  const parts = [tracked.trimEnd()];
  for (const f of untrackedFiles) {
    const d = (await fileDiff(dir, f.path, { untracked: true })).trimEnd();
    if (d) parts.push(d);
  }
  return { diff: parts.filter(Boolean).join('\n') };
}

export type AppDiffAction = 'stash' | 'discardAll' | 'discard' | 'commit';
const DIFF_ACTIONS = new Set<AppDiffAction>(['stash', 'discardAll', 'discard', 'commit']);
export const isAppDiffAction = (v: unknown): v is AppDiffAction =>
  typeof v === 'string' && DIFF_ACTIONS.has(v as AppDiffAction);

/**
 * Stash all / discard all / discard or commit specific paths. `commit` stages and
 * commits ONLY the selected paths with `message`. Returns the post-action file list.
 */
export async function runAppDiffAction(
  app: AppConfig,
  action: AppDiffAction,
  paths?: string[],
  message?: string,
): Promise<AppDiffSummary> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir))) return { ok: false, files: [], error: 'not a git repo' };

  let res: { code: number; stdout: string; stderr: string };
  switch (action) {
    case 'stash':
      res = await stashPush(dir, { message: 'stashed via rubato' });
      break;
    case 'discardAll':
      res = await discardAll(dir);
      break;
    case 'discard':
      res = await discardPaths(dir, Array.isArray(paths) ? paths : []);
      break;
    case 'commit': {
      const ps = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [];
      if (ps.length === 0) return { ok: false, files: await diffNameStatus(dir), error: 'no files selected' };
      if (!message?.trim()) return { ok: false, files: await diffNameStatus(dir), error: 'commit message required' };
      const add = await git(dir, ['add', '--', ...ps]);
      if (add.code !== 0) {
        return { ok: false, files: await diffNameStatus(dir), error: add.stderr.trim() || 'git add failed' };
      }
      res = await git(dir, ['commit', '-m', message.trim(), '--', ...ps]);
      break;
    }
    default:
      return { ok: false, files: [], error: `unknown action: ${action}` };
  }
  const files = await diffNameStatus(dir);
  return res.code === 0
    ? { ok: true, files }
    : { ok: false, files, error: res.stderr.trim() || `git exited ${res.code}` };
}
