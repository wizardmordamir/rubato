/**
 * Stalled-state detection — read-only inspection of the taskq SQLite DB.
 *
 * Provides rich per-lease diagnostic data that the broader healer (`drainHealer.ts`)
 * doesn't return: exact task title, worker identity, how long ago each lease expired,
 * and long-running tasks (alive but past the task-timeout ceiling). Use this for:
 *
 *   - The `GET /api/taskq/stalled` read-only endpoint (show a "3 tasks stalled"
 *     banner in the UI before the user commits to running the healer).
 *   - Fine-grained diagnostic logging / alerts that need per-task detail.
 *
 * This module is intentionally DETECTION-ONLY. Fixes (reaping, drain kick, cwip
 * rebuild, relinking) live in `drainHealer.ts` / `POST /api/taskq/healer`, which
 * calls `reapExpired` from cwip/taskq. Keeping detection and repair separate
 * preserves the single-responsibility boundary and avoids duplicating fix logic.
 */

import type { TaskqDb } from 'cwip/taskq';

/** A lease that expired without being renewed — the worker died or was killed. */
export interface StalledLease {
  taskId: number;
  title: string;
  workerId: string;
  worktree: string | null;
  /** Epoch-ms when the lease was originally claimed. */
  claimedAt: number;
  /** How many ms ago the lease expired (always ≥ 0; expired = expires_at <= now). */
  expiredMs: number;
}

/**
 * A `claimed` task whose heartbeat is FRESH (worker still alive) but that has
 * been running longer than the configured task-timeout ceiling. These are NOT
 * reaped automatically — the worker may be doing legitimate slow work — but they
 * are surfaced so the operator can decide whether to intervene (e.g. force-stop
 * via `POST /api/taskq/instances/:id/release`).
 */
export interface LongRunningTask {
  taskId: number;
  title: string;
  workerId: string;
  worktree: string | null;
  /** Epoch-ms when the task was claimed. */
  claimedAt: number;
  /** Total elapsed ms since claim. */
  elapsedMs: number;
  /** Ms since the last heartbeat (small = worker alive; large = worker may be frozen). */
  msSinceHeartbeat: number;
}

/** A read-only snapshot of everything the stalled-state detector found. */
export interface StalledStateSnapshot {
  /** Leases whose `expires_at` has passed — eligible for reap via the healer. */
  expiredLeases: StalledLease[];
  /**
   * Tasks with a live heartbeat but running beyond `taskTimeoutMs`. Informational:
   * the healer does NOT reap these automatically (the worker may be doing real work).
   * Available for operator review and manual intervention.
   */
  longRunning: LongRunningTask[];
  /** The clock value used for the snapshot. */
  nowMs: number;
}

interface RawLease {
  task_id: number;
  title: string;
  worker_id: string;
  worktree: string | null;
  claimed_at: number;
  heartbeat_at: number;
  expires_at: number;
}

/**
 * Detect stalled states — read-only, never mutates the database.
 *
 * @param db            The taskq SQLite handle.
 * @param nowMs         Current epoch-ms (injectable for tests).
 * @param opts.taskTimeoutMs  Optional ceiling for "this task has been running too long"
 *   (flags it as {@link LongRunningTask}). A task running longer than this is NOT
 *   reaped — only expired leases are eligible. Pass 0 or omit to skip the
 *   long-running check. A reasonable default is the configured `taskTimeoutMs`
 *   from `loadTaskqConfig()`.
 */
export function detectStalledStates(
  db: TaskqDb,
  nowMs: number,
  opts: { taskTimeoutMs?: number } = {},
): StalledStateSnapshot {
  const rows = db
    .query(
      `SELECT l.task_id, t.title, l.worker_id, l.worktree, l.claimed_at, l.heartbeat_at, l.expires_at
         FROM leases l
         JOIN tasks t ON t.id = l.task_id
        ORDER BY l.claimed_at ASC`,
    )
    .all() as RawLease[];

  const expiredLeases: StalledLease[] = [];
  const longRunning: LongRunningTask[] = [];

  for (const r of rows) {
    if (r.expires_at <= nowMs) {
      expiredLeases.push({
        taskId: r.task_id,
        title: r.title,
        workerId: r.worker_id,
        worktree: r.worktree,
        claimedAt: r.claimed_at,
        expiredMs: nowMs - r.expires_at,
      });
    } else if (opts.taskTimeoutMs && opts.taskTimeoutMs > 0) {
      const elapsedMs = nowMs - r.claimed_at;
      if (elapsedMs > opts.taskTimeoutMs) {
        longRunning.push({
          taskId: r.task_id,
          title: r.title,
          workerId: r.worker_id,
          worktree: r.worktree,
          claimedAt: r.claimed_at,
          elapsedMs,
          msSinceHeartbeat: nowMs - r.heartbeat_at,
        });
      }
    }
  }

  return { expiredLeases, longRunning, nowMs };
}
