/**
 * The taskq orchestrator core — the v2 drainer loop (replaces drain-queue.sh).
 *
 * Runs N concurrent worker loops over ONE SQLite handle (safe: bun:sqlite is
 * synchronous, so each engine call completes between `await`s — no in-process
 * transaction overlap). Each worker: claimNext → run (injectable executor) →
 * complete/fail, heartbeating across the run so a crash is reaped. Pure of any
 * spawning itself — the *executor* is injected, so this is unit-tested with a
 * fake and the real `claude -p` executor lives in `claudeExecutor.ts`.
 */

import {
  type ClaimFilters,
  claimNext,
  completeTask,
  failTask,
  heartbeat,
  nextEligibleId,
  reapExpired,
  recordRun,
  setStatus,
  type TaskqDb,
  type TaskRow,
} from 'cwip/taskq';

/** What a worker did with a task. */
export interface TaskResult {
  ok: boolean;
  commit?: string;
  summary?: string;
  /** Failure reason (when !ok) — stamped on the task's `note`. */
  reason?: string;
  /** Output tokens the run consumed (recorded into the usage ledger when known). */
  outputTokens?: number;
  /**
   * True only when the failure was a genuine usage/rate-limit error. Lets the
   * drain tell "we are really out of tokens" (respect it) from "the call worked,
   * the task just failed" (proof we are NOT out → recalibrate the estimate).
   */
  rateLimited?: boolean;
}

/** Runs one assigned task to completion (spawn an agent, etc.). */
export type TaskExecutor = (task: TaskRow, ctx: WorkerContext) => Promise<TaskResult>;

/** Per-worker identity passed to the executor + claim. */
export interface WorkerContext {
  index: number;
  workerId: string;
  worktree: string;
  filters: ClaimFilters;
}

export type DrainEvent =
  | { type: 'reaped'; count: number }
  | { type: 'claimed'; worker: number; task: TaskRow }
  | { type: 'completed'; worker: number; taskId: number; durationS: number }
  | { type: 'failed'; worker: number; taskId: number; reason: string; rateLimited?: boolean }
  | { type: 'idle'; worker: number }
  | { type: 'error'; worker: number; taskId: number; error: string };

export interface DrainOptions {
  /** Initial concurrent worker count (the pool size at drain start). */
  jobs: number;
  /**
   * Live target worker count, re-read on every supervisor tick so a mid-run
   * config change (e.g. the user bumps JOBS from 1→4) takes effect WITHOUT
   * restarting the drain: the pool grows new slots toward this number and a
   * worker whose slot index is now ≥ the target retires after its current task.
   * Defaults to a constant `jobs`. Result is clamped to ≥ 1.
   */
  desiredJobs?: () => number;
  /** Runs each claimed task (inject the real `claude -p` runner or a fake). */
  executor: TaskExecutor;
  /** Per-worker identity/filters (e.g. fleet tiers). Defaults: taskq-w<i>, no filter. */
  worker?: (index: number) => Partial<WorkerContext>;
  /** Wall-clock now in ms (injectable for tests). */
  now?: () => number;
  leaseTtlMs?: number;
  /** Heartbeat cadence while a task runs (default 60s). */
  heartbeatMs?: number;
  /**
   * Supervisor cadence (ms): how often the pool re-reads {@link desiredJobs},
   * resizes, and fires {@link onTick}. Default 5s. While a single long task
   * runs this is the only thing still ticking, so it doubles as the liveness
   * clock that keeps {@link onTick} firing.
   */
  tickMs?: number;
  /**
   * Called once at start and on every supervisor tick while the drain is alive.
   * The drainer uses it to stamp a liveness heartbeat so the UI's "last fired"
   * stays fresh during a long pass instead of freezing at the launchd start.
   */
  onTick?: () => void;
  /** Cooperative stop: when it returns true, workers exit between tasks. */
  shouldStop?: () => boolean;
  onEvent?: (e: DrainEvent) => void;
}

export interface DrainSummary {
  completed: number;
  failed: number;
  reaped: number;
}

const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_TICK_MS = 5_000;

/**
 * Drain the queue: reap stranded leases, then run a worker pool until no
 * eligible task remains (or stop is requested). Resolves with a run summary.
 *
 * The pool is *adaptive*. A supervisor re-reads {@link DrainOptions.desiredJobs}
 * every `tickMs` and keeps slots `[0, desired)` filled: it (re)spawns any idle
 * slot that currently has claimable work — so a mid-run JOBS bump applies live
 * AND a slot that idled out earlier is brought back when NEW work appears while
 * a long task pins another worker (the case launchd can't help with, since it
 * won't re-fire while this drain is still alive). A worker whose slot index is
 * now ≥ the target retires after its task (shrink). The drain still terminates
 * when nothing is active and no slot has claimable work — i.e. the queue is
 * drained — so launchd's relaunch-for-new-work model is preserved.
 */
export async function runDrain(db: TaskqDb, opts: DrainOptions): Promise<DrainSummary> {
  const now = opts.now ?? (() => Date.now());
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const desired = () => Math.max(1, Math.floor(opts.desiredJobs?.() ?? opts.jobs));
  const emit = (e: DrainEvent) => opts.onEvent?.(e);
  const summary: DrainSummary = { completed: 0, failed: 0, reaped: 0 };

  // Reclaim leases stranded by a prior crashed run before we start.
  summary.reaped = reapExpired(db, now());
  if (summary.reaped) emit({ type: 'reaped', count: summary.reaped });

  const worker = async (index: number): Promise<void> => {
    const partial = opts.worker?.(index) ?? {};
    const ctx: WorkerContext = {
      index,
      workerId: partial.workerId ?? `taskq-w${index}`,
      worktree: partial.worktree ?? `_taskq-w${index}`,
      filters: partial.filters ?? {},
    };

    // Retire when stopped or when this slot is now beyond the (possibly shrunk) target.
    while (!opts.shouldStop?.() && index < desired()) {
      const task = claimNext(db, {
        workerId: ctx.workerId,
        worktree: ctx.worktree,
        ttlMs: opts.leaseTtlMs,
        nowMs: now(),
        filters: ctx.filters,
      });
      if (!task) {
        emit({ type: 'idle', worker: index });
        return; // no eligible work for this worker → exit
      }
      emit({ type: 'claimed', worker: index, task });

      const startedAt = now();
      const hb = setInterval(() => heartbeat(db, task.id, now(), opts.leaseTtlMs), heartbeatMs);
      try {
        const res = await opts.executor(task, ctx);
        clearInterval(hb);
        if (res.ok) {
          const durationS = Math.round((now() - startedAt) / 1000);
          completeTask(db, task.id, { commit: res.commit, summary: res.summary, startedAt, durationS }, now());
          if (res.outputTokens) recordRun(db, { at: now(), model: task.model, outputTokens: res.outputTokens });
          // Saved tasks (no interval) auto-return to on_hold after completion.
          // Clear any stale failure note from a previous run so the UI doesn't
          // show an old "executor threw: …" reason for a task that just succeeded.
          if (task.is_saved && !task.recur_interval_ms) {
            setStatus(db, task.id, 'on_hold', null);
          }
          summary.completed++;
          emit({ type: 'completed', worker: index, taskId: task.id, durationS });
        } else {
          failTask(db, task.id, res.reason ?? 'task failed', now());
          summary.failed++;
          emit({
            type: 'failed',
            worker: index,
            taskId: task.id,
            reason: res.reason ?? 'task failed',
            rateLimited: res.rateLimited,
          });
        }
      } catch (e) {
        clearInterval(hb);
        const msg = e instanceof Error ? e.message : String(e);
        failTask(db, task.id, `executor threw: ${msg}`, now());
        summary.failed++;
        emit({ type: 'error', worker: index, taskId: task.id, error: msg });
      }
    }
  };

  // Adaptive pool: `active` maps a live slot index → its (never-rejecting)
  // worker promise. A worker that throws fatally (e.g. a DB error) records
  // `fatal`, which is rethrown after the loop.
  const active = new Map<number, Promise<void>>();
  let fatal: unknown;
  const filtersForSlot = (i: number): ClaimFilters => opts.worker?.(i)?.filters ?? {};
  // Is there a claimable task RIGHT NOW for this slot's tier filter? Drives both
  // refill (only spawn a slot that has work) and termination (no work + nothing
  // active ⇒ drained). Cheap, indexed, read-only — safe to poll each tick.
  const slotHasWork = (i: number): boolean => {
    try {
      return nextEligibleId(db, now(), filtersForSlot(i)) != null;
    } catch {
      return false;
    }
  };
  const spawn = (i: number) => {
    const p = worker(i)
      .catch((e) => {
        fatal ??= e;
      })
      .finally(() => active.delete(i));
    active.set(i, p);
  };
  // Fill every idle slot in [0, desired) that has claimable work. Returns true
  // if any worker is active afterward. Over-spawning is harmless — a slot that
  // loses the claim race just idles out and is re-evaluated next tick.
  const refill = (): boolean => {
    if (!opts.shouldStop?.()) {
      const target = desired();
      for (let i = 0; i < target; i++) if (!active.has(i) && slotHasWork(i)) spawn(i);
    }
    return active.size > 0;
  };

  opts.onTick?.(); // initial liveness stamp
  refill();

  // Supervise: each tick stamp liveness + refill idle slots that have work. Wake
  // on either the tick OR all current workers settling, whichever comes first, so
  // newly-ready work is picked up within a tick, an empty queue exits promptly,
  // and a long single task still heartbeats. The tick timer is cleared after
  // every wake so a finished drain exits at once — a dangling setTimeout would
  // otherwise pin the event loop for up to tickMs.
  while (active.size > 0 && fatal === undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, tickMs);
    });
    await Promise.race([tick, Promise.all([...active.values()])]);
    if (timer) clearTimeout(timer);
    opts.onTick?.();
    if (fatal === undefined) refill();
  }
  if (fatal !== undefined) throw fatal;
  return summary;
}
