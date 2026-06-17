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

import { claimNext, completeTask, type ClaimFilters, failTask, heartbeat, reapExpired, type TaskqDb, type TaskRow } from 'cwip/taskq';

/** What a worker did with a task. */
export interface TaskResult {
  ok: boolean;
  commit?: string;
  summary?: string;
  /** Failure reason (when !ok) — stamped on the task's `note`. */
  reason?: string;
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
  | { type: 'failed'; worker: number; taskId: number; reason: string }
  | { type: 'idle'; worker: number }
  | { type: 'error'; worker: number; taskId: number; error: string };

export interface DrainOptions {
  /** Number of concurrent workers. */
  jobs: number;
  /** Runs each claimed task (inject the real `claude -p` runner or a fake). */
  executor: TaskExecutor;
  /** Per-worker identity/filters (e.g. fleet tiers). Defaults: taskq-w<i>, no filter. */
  worker?: (index: number) => Partial<WorkerContext>;
  /** Wall-clock now in ms (injectable for tests). */
  now?: () => number;
  leaseTtlMs?: number;
  /** Heartbeat cadence while a task runs (default 60s). */
  heartbeatMs?: number;
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

/**
 * Drain the queue: reap stranded leases, then run `jobs` workers until no
 * eligible task remains (or stop is requested). Resolves with a run summary.
 */
export async function runDrain(db: TaskqDb, opts: DrainOptions): Promise<DrainSummary> {
  const now = opts.now ?? (() => Date.now());
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
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

    while (!opts.shouldStop?.()) {
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
          summary.completed++;
          emit({ type: 'completed', worker: index, taskId: task.id, durationS });
        } else {
          failTask(db, task.id, res.reason ?? 'task failed', now());
          summary.failed++;
          emit({ type: 'failed', worker: index, taskId: task.id, reason: res.reason ?? 'task failed' });
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

  await Promise.all(Array.from({ length: Math.max(1, opts.jobs) }, (_, i) => worker(i)));
  return summary;
}
