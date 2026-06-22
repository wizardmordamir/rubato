/**
 * False-done detection — the IMPURE evidence gatherer that wires real git/build/fs
 * clients into the pure {@link decideDone} core and hands the orchestrator a
 * {@link DoneGuard}. Kept thin + dependency-injected so the whole flow (empty-done,
 * regressing-done, tolerated-red, accept) is unit-tested with fakes — no real git
 * or builds in the suite.
 *
 * What it measures, per the integration flow (see `falseDone.ts` for the why):
 *   - snapshot (at claim): the repo's `refactor/integration` tip + the last-known
 *     integration build health (the tolerated baseline). A repo with no resolved
 *     root or no `refactor/integration` branch is NOT enforced (accept).
 *   - verify (at completion): the new-commit delta on `refactor/integration` since
 *     the snapshot, and — only when code landed and the check is enabled — a
 *     `bun run build` of the integration worktree to catch a regression. Feeds the
 *     evidence to {@link decideDone}; on a reject it fires a deduped alert.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TaskRow, taskqHome } from 'cwip/taskq';
import { agentPath } from './claudeExecutor';
import { repoRoot, type TaskqConfig } from './config';
import { type DoneEvidence, type DoneGuard, type DoneVerdict, decideDone, type FalseDoneAlert } from './falseDone';
import type { TaskResult } from './orchestrator';

/** Result of a spawned command (only the pieces the guard reads). */
export interface RunResult {
  code: number;
  out: string;
}

/** The impure seams the guard depends on (defaults wrap real git/build/fs). */
export interface DoneCheckDeps {
  /** `git <args>` in `cwd` (used for rev-parse + rev-list). */
  git(args: string[], cwd: string): RunResult;
  /** `bun run build` in `cwd` (the integration worktree). */
  build(cwd: string): RunResult;
  /** Last-known integration build health for a repo (true=green, false=red, undefined=unknown). */
  knownGreen(repo: string | null): boolean | undefined;
  /** Does this path exist (the integration worktree)? */
  exists(path: string): boolean;
  /** Persist a deduped false-done alert (one record per offending task id). */
  alert(record: FalseDoneAlert): void;
  /** Wall-clock now in ms (injectable for tests). */
  now(): number;
}

/** The integration worktree sibling for a repo's main checkout (`<root>` → `<root>-integration`). */
export function integrationWorktree(root: string): string {
  return `${root}-integration`;
}

/** Snapshot the guard captures at claim and threads to `verify` at completion. */
interface EnforcedSnapshot {
  enforced: true;
  repo: string | null;
  repoRoot: string;
  integWorktree: string;
  beforeSha: string;
  knownGreen: boolean | undefined;
}
type GuardSnapshot = { enforced: false } | EnforcedSnapshot;

const NOT_ENFORCED: GuardSnapshot = { enforced: false };

/**
 * Only a normal one-shot work task is gated. Saved/recurring/template tasks
 * legitimately land no code (a recurring "check X" poll) AND never reach `done`
 * (they reschedule or park on_hold) — so they can't trigger the `needs:` cascade
 * the gate guards against, and flagging them would just wrongly break their
 * schedule. So the gate skips them.
 */
function isOneShotWork(task: TaskRow): boolean {
  return !task.is_saved && !task.is_template && task.recur_interval_ms == null && task.recur_n == null;
}

/**
 * Build the completion gate the orchestrator threads into {@link runDrain}. Pass
 * a partial `deps` to override any seam (tests do this); production uses the real
 * git/build/fs defaults below.
 */
export function makeDoneGuard(config: TaskqConfig, deps: Partial<DoneCheckDeps> = {}): DoneGuard {
  const d: DoneCheckDeps = { ...defaultDeps(), ...deps };

  function snapshot(task: TaskRow): GuardSnapshot {
    if (!isOneShotWork(task)) return NOT_ENFORCED; // saved/recurring → never cascades, may land nothing
    const root = repoRoot(config, task.repo);
    if (!root) return NOT_ENFORCED; // no resolved checkout → can't measure a landing
    const before = d.git(['rev-parse', 'refactor/integration'], root);
    // No `refactor/integration` branch ⇒ this repo isn't on the integration flow.
    if (before.code !== 0 || !before.out.trim()) return NOT_ENFORCED;
    return {
      enforced: true,
      repo: task.repo,
      repoRoot: root,
      integWorktree: integrationWorktree(root),
      beforeSha: before.out.trim(),
      knownGreen: d.knownGreen(task.repo),
    };
  }

  function verify(task: TaskRow, _result: TaskResult, snap: GuardSnapshot): DoneVerdict {
    if (!snap.enforced) return { accept: true };

    // 1. Landed-code delta: new commits on refactor/integration in the run window.
    const after = d.git(['rev-parse', 'refactor/integration'], snap.repoRoot);
    const afterSha = after.code === 0 ? after.out.trim() : '';
    const landedCommits =
      afterSha && afterSha !== snap.beforeSha ? countNewCommits(d, snap.repoRoot, snap.beforeSha, afterSha) : 0;

    // 2. Regression check (only meaningful once code landed): build the integration
    //    worktree. Skipped when disabled, nothing landed, or the worktree is absent.
    let buildChecked = false;
    let buildGreen: boolean | undefined;
    if (config.falseDoneBuildCheck && landedCommits > 0 && d.exists(snap.integWorktree)) {
      buildChecked = true;
      buildGreen = d.build(snap.integWorktree).code === 0;
    }

    const evidence: DoneEvidence = {
      enforced: true,
      landedCommits,
      buildChecked,
      buildGreen,
      // Only a build that was KNOWN-green and is now red is this task's regression;
      // an already-red/unknown integration is tolerated (a heal task owns it).
      toleratedRed: snap.knownGreen !== true,
    };
    const verdict = decideDone(evidence);
    if (!verdict.accept) {
      d.alert({
        taskId: task.id,
        slug: task.slug,
        repo: task.repo,
        title: task.title,
        reason: verdict.reason,
        status: verdict.status,
        note: verdict.note,
        detectedAt: d.now(),
      });
    }
    return verdict;
  }

  return { snapshot, verify };
}

/** `git rev-list --count before..after` → the number of new commits (0 on any error). */
function countNewCommits(d: DoneCheckDeps, cwd: string, before: string, after: string): number {
  const r = d.git(['rev-list', '--count', `${before}..${after}`], cwd);
  if (r.code !== 0) return 0;
  const n = Number.parseInt(r.out.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── Real default seams ─────────────────────────────────────────────────────────

/** PATH-enriched env so git/bun resolve under launchd's minimal environment. */
function enrichedEnv(): Record<string, string> {
  return { ...process.env, PATH: agentPath() } as Record<string, string>;
}

function defaultDeps(): DoneCheckDeps {
  return {
    git: (args, cwd) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: enrichedEnv(), maxBuffer: 16 * 1024 * 1024 });
      return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
    },
    build: (cwd) => {
      const r = spawnSync('bun', ['run', 'build'], {
        cwd,
        encoding: 'utf8',
        env: enrichedEnv(),
        maxBuffer: 64 * 1024 * 1024,
      });
      return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
    },
    knownGreen: (repo) => readKnownGreen(repo),
    exists: (p) => existsSync(p),
    alert: (record) => persistAlert(record),
    now: () => Date.now(),
  };
}

/**
 * Last integration build verdict for a repo, from the watchdog's
 * `integration-health.json` (`.repos.<repo>.integrationGreen`). Returns undefined
 * when the file is absent or the repo isn't recorded — i.e. "unknown", which the
 * decision core treats as tolerated (a red build is only a regression when we have
 * positive evidence it was green before).
 */
function readKnownGreen(repo: string | null): boolean | undefined {
  if (!repo) return undefined;
  try {
    const raw = JSON.parse(readFileSync(join(taskqHome(), 'integration-health.json'), 'utf8')) as {
      repos?: Record<string, { integrationGreen?: boolean }>;
    };
    const g = raw.repos?.[repo]?.integrationGreen;
    return typeof g === 'boolean' ? g : undefined;
  } catch {
    return undefined;
  }
}

/** Deduped alert sink: one record per offending task id in `~/.taskq/false-done.json`. */
function persistAlert(record: FalseDoneAlert): void {
  const path = join(taskqHome(), 'false-done.json');
  let store: Record<string, FalseDoneAlert & { count: number }> = {};
  try {
    store = JSON.parse(readFileSync(path, 'utf8')) as typeof store;
  } catch {
    // no file yet — start fresh
  }
  const prev = store[record.taskId];
  store[record.taskId] = { ...record, count: (prev?.count ?? 0) + 1 };
  mkdirSync(taskqHome(), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
}
