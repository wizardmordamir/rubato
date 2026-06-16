/**
 * Per-app git BRANCH management for the Apps detail page: list local branches with
 * upstream tracking (ahead/behind, gone), and checkout / create / delete / prune-
 * gone. All local git (delete/prune confirm in the UI); never pushes.
 */

import type { AppConfig } from '../lib/apps';
import { branchTracking, checkout, currentBranch, git, goneBranches, isGitRepo } from '../lib/git';

export interface AppBranch {
  name: string;
  current: boolean;
  /** Configured upstream short name, when set. */
  upstream?: string;
  ahead: number;
  behind: number;
  /** Upstream was configured but has since been deleted on the remote. */
  gone: boolean;
}

export async function getAppBranches(
  app: AppConfig,
): Promise<{ ok: boolean; current?: string; branches: AppBranch[]; error?: string }> {
  const dir = app.absolutePath;
  if (!(await isGitRepo(dir))) return { ok: false, branches: [], error: 'not a git repo' };
  const [tracking, current] = await Promise.all([branchTracking(dir), currentBranch(dir).catch(() => '')]);
  const branches = tracking.map((t) => ({
    name: t.name,
    current: t.name === current,
    upstream: t.upstream || undefined,
    ahead: t.ahead,
    behind: t.behind,
    gone: t.gone,
  }));
  return { ok: true, current: current || undefined, branches };
}

export type BranchAction = 'checkout' | 'create' | 'delete' | 'prune-gone';
const BRANCH_ACTIONS = new Set<BranchAction>(['checkout', 'create', 'delete', 'prune-gone']);
export const isBranchAction = (v: unknown): v is BranchAction =>
  typeof v === 'string' && BRANCH_ACTIONS.has(v as BranchAction);

/** Branch names we'll pass to git: non-empty, not flag-like, no whitespace/ref-illegal chars. */
const isValidBranchName = (name: unknown): name is string =>
  typeof name === 'string' &&
  name.length > 0 &&
  !name.startsWith('-') &&
  !/[\s~^:?*[\\]/.test(name) &&
  !name.includes('..') &&
  !name.endsWith('.lock');

export interface BranchActionResult {
  ok: boolean;
  action: BranchAction;
  /** The current branch after the action. */
  branch?: string;
  /** Branch names removed (delete / prune-gone). */
  removed?: string[];
  output?: string;
  error?: string;
}

export async function runAppBranchAction(
  app: AppConfig,
  opts: { action: BranchAction; name?: string; from?: string },
): Promise<BranchActionResult> {
  const dir = app.absolutePath;
  const { action, name, from } = opts;
  if (!(await isGitRepo(dir))) return { ok: false, action, error: 'not a git repo' };

  const finish = async (
    res: { code: number; stdout: string; stderr: string },
    removed?: string[],
  ): Promise<BranchActionResult> => {
    const branch = await currentBranch(dir).catch(() => undefined);
    return res.code === 0
      ? { ok: true, action, branch, removed, output: (res.stdout || res.stderr).trim() || undefined }
      : { ok: false, action, branch, error: res.stderr.trim() || `git exited ${res.code}` };
  };

  if (action === 'prune-gone') {
    await git(dir, ['fetch', '--prune']).catch(() => undefined);
    const current = await currentBranch(dir).catch(() => '');
    const gone = (await goneBranches(dir)).filter((b) => b !== current);
    const removed: string[] = [];
    for (const b of gone) {
      const r = await git(dir, ['branch', '-D', b]);
      if (r.code === 0) removed.push(b);
    }
    return { ok: true, action, removed, branch: current || undefined };
  }

  if (!isValidBranchName(name)) return { ok: false, action, error: 'invalid branch name' };

  if (action === 'checkout') return finish(await checkout(dir, name));
  if (action === 'create') {
    const args = ['checkout', '-b', name];
    if (from && isValidBranchName(from)) args.push(from);
    return finish(await git(dir, args));
  }
  // delete
  const current = await currentBranch(dir).catch(() => '');
  if (name === current) return { ok: false, action, error: 'cannot delete the current branch' };
  return finish(await git(dir, ['branch', '-D', name]), [name]);
}
