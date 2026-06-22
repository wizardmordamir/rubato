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
  type BackoffOpts,
  type ClaimFilters,
  claimNext,
  completeTask,
  type FailOpts,
  failTask,
  heartbeat,
  nextEligibleId,
  reapExpired,
  recordRun,
  releaseLease,
  revertCompletion,
  setStatus,
  type TaskqDb,
  type TaskRow,
} from 'cwip/taskq';
import type { DoneGuard, DoneSnapshot, DoneVerdict } from './falseDone';

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
  /**
   * True when the failure is non-retryable (the worker determined the task is
   * impossible / needs a human). Skips the auto-retry so we don't burn the whole
   * attempt budget on a known dead-end — it parks terminal `failed` at once.
   */
  permanent?: boolean;
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
  | {
      type: 'failed';
      worker: number;
      taskId: number;
      reason: string;
      rateLimited?: boolean;
      attempts: number;
      maxAttempts: number;
    }
  | {
      type: 'retrying';
      worker: number;
      taskId: number;
      reason: string;
      attempts: number;
      maxAttempts: number;
      retryAt: number;
    }
  | { type: 'rate-limited'; worker: number; taskId: number; reason: string }
  | { type: 'idle'; worker: number }
  | {
      /**
       * A reported "success" failed the completion gate (false-done): it landed no
       * code, or it regressed the integration build. The task was reverted to a hold
       * status (NOT marked done) so its downstream `needs:` deps stay blocked.
       */
      type: 'false-done';
      worker: number;
      taskId: number;
      status: 'on_hold' | 'needs_input';
      reason: string;
      note: string;
    }
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
  /**
   * Bounded auto-retry policy for failed/reaped tasks. A transient failure is
   * re-queued (status `ready`) with the {@link BackoffOpts} delay until `attempts`
   * reaches `maxAttempts`, then it parks terminal `failed`. Omit to use the
   * engine defaults (max 3, 1m→5m→20m backoff). A per-task `max_attempts`
   * overrides `maxAttempts`.
   */
  retry?: { maxAttempts?: number; backoff?: BackoffOpts };
  /**
   * Completion gate: before a reported-success task is marked `done`, verify it
   * really landed (non-empty git delta on `refactor/integration`) and didn't
   * regress the integration build. A `revert` verdict parks the task in a hold
   * status (on_hold/needs_input) with a note INSTEAD of completing it — so a
   * false-done can never silently flip downstream `needs:` deps to ready. Omit to
   * accept every success (legacy behavior; the unit tests rely on this default).
   */
  verifyDone?: DoneGuard;
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
  /** Tasks that exhausted their attempts (or failed permanently) → terminal `failed`. */
  failed: number;
  /** Transient failures that were re-queued with a backoff (not terminal). */
  retried: number;
  reaped: number;
  /**
   * Reported-success tasks the completion gate caught as false-dones (no landed
   * code, or a build regression) and reverted to a hold instead of completing.
   */
  falseDone: number;
  /**
   * True when a worker hit a genuine usage/rate limit and the pool wound down
   * early. The released task is back to `ready` (NOT burned to `failed`), so the
   * next drain pass — after the limit resets — picks it up. Lets the caller skip
   * a redundant capacity probe: we already KNOW we're out.
   */
  rateLimited: boolean;
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
  const summary: DrainSummary = { completed: 0, failed: 0, retried: 0, reaped: 0, falseDone: 0, rateLimited: false };

  // Retry policy threaded into every failure/reap so a transient hiccup is
  // re-queued (with backoff) instead of burning a task; `permanent` skips it.
  const failOpts = (permanent?: boolean): FailOpts => ({
    maxAttempts: opts.retry?.maxAttempts,
    backoff: opts.retry?.backoff,
    permanent,
  });
  // Fail a task with bounded retry, then update the summary + emit the matching
  // event ('retrying' while re-queued; 'failed' once terminal). Shared by the
  // executor-failure and executor-throw paths.
  const recordFailure = (
    index: number,
    taskId: number,
    reason: string,
    info: { permanent?: boolean; rateLimited?: boolean } = {},
  ): void => {
    const outcome = failTask(db, taskId, reason, now(), failOpts(info.permanent));
    if (outcome.terminal) {
      summary.failed++;
      emit({
        type: 'failed',
        worker: index,
        taskId,
        reason,
        rateLimited: info.rateLimited,
        attempts: outcome.attempts,
        maxAttempts: outcome.maxAttempts,
      });
    } else {
      summary.retried++;
      emit({
        type: 'retrying',
        worker: index,
        taskId,
        reason,
        attempts: outcome.attempts,
        maxAttempts: outcome.maxAttempts,
        retryAt: outcome.retryAt ?? now(),
      });
    }
  };

  // Reclaim leases stranded by a prior crashed run before we start. A reap means
  // the worker *vanished* (not that the task failed), so resume it promptly — a
  // zero backoff — but still count the attempt (same accounting) so a task that
  // repeatedly hangs eventually parks terminal instead of looping forever.
  summary.reaped = reapExpired(db, now(), { maxAttempts: opts.retry?.maxAttempts, backoff: { baseMs: 0 } });
  if (summary.reaped) emit({ type: 'reaped', count: summary.reaped });

  // Set when a worker hits a real usage limit: stop claiming/refilling and let
  // the pool drain out, so we don't thrash the queue releasing every task during
  // an outage. Treated like a cooperative stop everywhere we check `shouldStop`.
  let rateLimited = false;
  const stopping = () => rateLimited || (opts.shouldStop?.() ?? false);

  const worker = async (index: number): Promise<void> => {
    const partial = opts.worker?.(index) ?? {};
    const ctx: WorkerContext = {
      index,
      workerId: partial.workerId ?? `taskq-w${index}`,
      worktree: partial.worktree ?? `_taskq-w${index}`,
      filters: partial.filters ?? {},
    };

    // Retire when stopped, rate-limited, or when this slot is now beyond the
    // (possibly shrunk) target.
    while (!stopping() && index < desired()) {
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

      // Capture pre-run state for the completion gate (e.g. the integration tip)
      // BEFORE the executor runs, so a false-done is measured against the right
      // baseline. A snapshot hiccup is non-fatal — the gate then can't enforce.
      let doneSnapshot: DoneSnapshot;
      if (opts.verifyDone) {
        try {
          doneSnapshot = await opts.verifyDone.snapshot(task, ctx);
        } catch (e) {
          emit({
            type: 'error',
            worker: index,
            taskId: task.id,
            error: `done-gate snapshot: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }

      const startedAt = now();
      const hb = setInterval(() => heartbeat(db, task.id, now(), opts.leaseTtlMs), heartbeatMs);
      try {
        const res = await opts.executor(task, ctx);
        clearInterval(hb);
        if (res.ok) {
          // Completion gate: a reported success is no longer trusted on its own —
          // verify it landed code + didn't regress the build before marking it done.
          let verdict: DoneVerdict = { accept: true };
          if (opts.verifyDone) {
            try {
              verdict = await opts.verifyDone.verify(task, res, doneSnapshot, ctx);
            } catch (e) {
              // Fail OPEN on a gate error (git/build hiccup): the periodic promotion-
              // gate watchdog is the backstop; never strand a finished task on flakiness.
              emit({
                type: 'error',
                worker: index,
                taskId: task.id,
                error: `done-gate verify: ${e instanceof Error ? e.message : String(e)}`,
              });
            }
          }
          if (!verdict.accept) {
            // False-done: revert to a hold (NEVER done) so downstream `needs:` deps
            // stay blocked + the cascade can't start; record the alert + clear note.
            revertCompletion(db, task.id, verdict.status, verdict.note, now());
            // Tokens were really spent — keep the usage ledger honest.
            if (res.outputTokens) recordRun(db, { at: now(), model: task.model, outputTokens: res.outputTokens });
            summary.falseDone++;
            emit({
              type: 'false-done',
              worker: index,
              taskId: task.id,
              status: verdict.status,
              reason: verdict.reason,
              note: verdict.note,
            });
            continue;
          }
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
        } else if (res.rateLimited) {
          // We're genuinely out of tokens — DON'T burn the task. Return it to
          // `ready` (it never really ran) and signal the pool to wind down so the
          // next pass, after the limit resets, runs it instead of marking it
          // failed. This is the "resume after a break" path.
          releaseLease(db, task.id);
          rateLimited = true;
          summary.rateLimited = true;
          emit({ type: 'rate-limited', worker: index, taskId: task.id, reason: res.reason ?? 'usage limit' });
          return;
        } else {
          // Bounded auto-retry: re-queue with a backoff unless the worker flagged
          // the failure permanent (impossible / needs human) or the budget is spent.
          recordFailure(index, task.id, res.reason ?? 'task failed', {
            permanent: res.permanent,
            rateLimited: res.rateLimited,
          });
        }
      } catch (e) {
        clearInterval(hb);
        const msg = e instanceof Error ? e.message : String(e);
        // An executor throw is an infra hiccup (spawn failed, DB blip) → transient;
        // retry it like any other failure. Emit 'error' first for the diagnostic.
        emit({ type: 'error', worker: index, taskId: task.id, error: msg });
        recordFailure(index, task.id, `executor threw: ${msg}`);
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
    if (!stopping()) {
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
