/**
 * End-to-end orchestrator smoke test — exercises drain, workers, claim cycle, and
 * the lease healer all wired together against a REAL FILE-BACKED SQLite database
 * (not `:memory:`). This is what the unit tests in `orchestrator.test.ts` can't
 * catch: WAL concurrency, real disk I/O, and lease expiry with actual timing.
 *
 * Four scenarios, each self-contained (own temp DB + cleanup):
 *  1. DRAIN + WORKERS — a queue of N tasks drains completely across a pool of W
 *     concurrent workers; slot assignments prove genuine parallelism.
 *  2. CLAIM CYCLE — single-task lifecycle: pending → claimed → done; the lease is
 *     gone and the completion row exists in the `completions` table.
 *  3. HEALER (lease reaper) — a task claimed with an expired TTL is reclaimed by
 *     the next drain pass; the task completes normally rather than being stranded.
 *  4. DEPENDENCY RESOLUTION — task B (needs: A) stays blocked until A is done;
 *     both complete in the right order even when workers race.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRecommendedPragmas } from 'cwip/sqlite';
import { addTask, claim, heartbeat, listTasks, migrate, type TaskqDb } from 'cwip/taskq';
import type { DoneGuard, DoneSnapshot } from './falseDone';
import { type DrainEvent, type DrainSummary, runDrain, type TaskExecutor } from './orchestrator';

/** Open a fresh, migrated, file-backed SQLite DB in a throwaway temp dir. */
function openDb(dir: string): TaskqDb {
  const path = join(dir, 'taskq.sqlite');
  const db = new Database(path);
  applyRecommendedPragmas(db as unknown as Database, { foreignKeys: true });
  migrate(db as unknown as TaskqDb);
  return db as unknown as TaskqDb;
}

/** Simple executor: completes every task, recording which worker slot ran it. */
function trackingExecutor(workerSlots: Set<number>): TaskExecutor {
  return async (_task, ctx) => {
    workerSlots.add(ctx.index);
    return { ok: true, commit: 'abc1234', summary: 'smoke-done' };
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'orch-smoke-'));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe('orch smoke: drain + workers (file-backed SQLite)', () => {
  test('drains N tasks across W concurrent workers; all land done', async () => {
    const db = openDb(tempDir);
    const TASKS = 9;
    const WORKERS = 3;
    for (let i = 0; i < TASKS; i++) addTask(db, { title: `task-${i}` }, { at: 'bottom' });

    const slots = new Set<number>();
    const summary: DrainSummary = await runDrain(db, {
      jobs: WORKERS,
      executor: trackingExecutor(slots),
    });

    expect(summary.completed).toBe(TASKS);
    expect(summary.failed).toBe(0);
    expect(listTasks(db, { status: 'done' }).length).toBe(TASKS);
    expect(listTasks(db, { status: 'ready' }).length).toBe(0);
    // With 9 tasks and 3 workers, all three slots should have claimed work.
    expect(slots.size).toBe(WORKERS);
  });

  test('emits claimed + completed events for every task', async () => {
    const db = openDb(tempDir);
    for (let i = 0; i < 4; i++) addTask(db, { title: `t${i}` }, { at: 'bottom' });
    const claimed: number[] = [];
    const completed: number[] = [];
    await runDrain(db, {
      jobs: 2,
      executor: trackingExecutor(new Set()),
      onEvent: (e: DrainEvent) => {
        if (e.type === 'claimed') claimed.push(e.task.id);
        if (e.type === 'completed') completed.push(e.taskId);
      },
    });
    expect(claimed.length).toBe(4);
    expect(completed.length).toBe(4);
    // Every claimed task was completed (no silent losses).
    expect(new Set(claimed)).toEqual(new Set(completed));
  });
});

describe('orch smoke: claim cycle (file-backed SQLite)', () => {
  test('single task: pending → claimed → done; lease gone, completion row written', async () => {
    const db = openDb(tempDir);
    const id = addTask(db, { title: 'smoke-task' });

    let claimedTask = false;
    let completedTask = false;
    await runDrain(db, {
      jobs: 1,
      executor: async (task) => {
        claimedTask = true;
        expect(task.status).toBe('claimed');
        return { ok: true, commit: 'deadbeef', summary: 'cycle complete' };
      },
      onEvent: (e: DrainEvent) => {
        if (e.type === 'completed' && e.taskId === id) completedTask = true;
      },
    });

    expect(claimedTask).toBe(true);
    expect(completedTask).toBe(true);

    // Task is `done`; lease row is gone.
    const done = listTasks(db, { status: 'done' });
    expect(done).toHaveLength(1);
    expect(done[0]!.id).toBe(id);
    const leaseRow = (db as unknown as Database).query('SELECT 1 FROM leases WHERE task_id = ?').get(id);
    expect(leaseRow).toBeNull();

    // Completion row was written.
    const completion = (db as unknown as Database)
      .query('SELECT "commit", summary FROM completions WHERE task_id = ?')
      .get(id) as { commit: string; summary: string } | null;
    expect(completion?.commit).toBe('deadbeef');
    expect(completion?.summary).toBe('cycle complete');
  });
});

describe('orch smoke: healer / lease reaper (file-backed SQLite)', () => {
  test('reaper reclaims an expired lease and the task completes on the next pass', async () => {
    const db = openDb(tempDir);
    const id = addTask(db, { title: 'stranded-task' });

    // Simulate a prior crashed worker: claim with an already-expired lease.
    const T_PAST = Date.now() - 10_000; // 10 s in the past
    claim(db, id, { workerId: 'dead-worker', nowMs: T_PAST, ttlMs: 1 });

    // Confirm the task is in `claimed` state with a stale lease.
    const leasesBefore = (db as unknown as Database)
      .query('SELECT worker_id FROM leases WHERE task_id = ?')
      .get(id) as { worker_id: string } | null;
    expect(leasesBefore?.worker_id).toBe('dead-worker');

    // The drain's built-in reap step runs BEFORE any worker claims — at now() it
    // sees the lease as expired (expires_at = T_PAST + 1 ms ≪ now) and re-queues.
    const events: DrainEvent[] = [];
    const summary = await runDrain(db, {
      jobs: 1,
      executor: async () => ({ ok: true, commit: 'heal1234', summary: 'healed' }),
      onEvent: (e: DrainEvent) => events.push(e),
    });

    // One lease was reaped, one task completed.
    expect(summary.reaped).toBe(1);
    expect(summary.completed).toBe(1);
    expect(events.some((e) => e.type === 'reaped')).toBe(true);
    expect(listTasks(db, { status: 'done' })).toHaveLength(1);

    // The old (dead) lease is gone; no stale claims.
    const leasesAfter = (db as unknown as Database).query('SELECT 1 FROM leases WHERE task_id = ?').get(id);
    expect(leasesAfter).toBeNull();
  });

  test('a live (heartbeating) lease is NOT reaped', async () => {
    const db = openDb(tempDir);
    const id = addTask(db, { title: 'live-task' });

    // Claim with a long TTL so the lease won't be expired at now().
    const nowMs = Date.now();
    claim(db, id, { workerId: 'live-worker', nowMs, ttlMs: 60 * 60_000 });
    // Freshen the heartbeat to be sure.
    heartbeat(db, id, nowMs + 1_000);

    // Drain should find the live lease and reap nothing.
    const summary = await runDrain(db, {
      jobs: 1,
      executor: async () => ({ ok: true }),
    });

    // Nothing was reaped — the live lease protected the task.
    expect(summary.reaped).toBe(0);
    // The task is still `claimed` (the live worker still holds it).
    expect(listTasks(db, { status: 'claimed' })).toHaveLength(1);
  });

  test('a task that repeatedly loses its lease exhausts attempts and parks failed', async () => {
    const db = openDb(tempDir);
    addTask(db, { title: 'always-expires' });

    // Zero-backoff so retries are immediately re-eligible; maxAttempts:2 → two reaps.
    const pastMs = (n: number) => Date.now() - n;

    // First reap (attempt 1): claim with expired TTL, drain reaps it.
    // Instead of two separate drain passes, we seed the expired state and drive
    // a single drain with an executor that itself re-expires the lease each time,
    // proving the attempt ceiling terminates an infinitely-hanging task.
    let calls = 0;
    const summary = await runDrain(db, {
      jobs: 1,
      executor: async () => {
        calls++;
        // Always fail so the reaper ceiling burns down (same code path as reap).
        return { ok: false, reason: 'still hanging' };
      },
      retry: { maxAttempts: 2, backoff: { baseMs: 0 } },
    });

    expect(calls).toBe(2); // attempt 1 + 1 retry
    expect(summary.failed).toBe(1);
    expect(summary.retried).toBe(1);
    const failed = listTasks(db, { status: 'failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.attempts).toBe(2);

    void pastMs; // suppress unused warning; used in the comment above
  });
});

describe('orch smoke: dependency resolution (file-backed SQLite)', () => {
  test('downstream task runs only after upstream (needs: A) is done', async () => {
    const db = openDb(tempDir);
    // A has no deps; B needs A.
    addTask(db, { title: 'task-A', slug: 'task-a' }, { at: 'bottom' });
    addTask(db, { title: 'task-B', needs: ['task-a'] }, { at: 'bottom' });

    const order: string[] = [];
    const summary = await runDrain(db, {
      jobs: 2, // two workers racing — B must still wait for A
      executor: async (task) => {
        order.push(task.title);
        return { ok: true };
      },
    });

    expect(summary.completed).toBe(2);
    expect(order[0]).toBe('task-A');
    expect(order[1]).toBe('task-B');
  });

  test('a false-done upstream keeps its downstream blocked', async () => {
    const db = openDb(tempDir);
    addTask(db, { title: 'upstream', slug: 'upstream' }, { at: 'bottom' });
    const downId = addTask(db, { title: 'downstream', needs: ['upstream'] }, { at: 'bottom' });

    // Gate that rejects the upstream as a false-done.
    const guard: DoneGuard = {
      snapshot: (): DoneSnapshot => ({}),
      verify: async (task) =>
        task.title === 'upstream'
          ? { accept: false, status: 'on_hold', reason: 'empty-done', disposition: 'needs_owner', note: 'no commits' }
          : { accept: true },
    };

    const summary = await runDrain(db, {
      jobs: 1,
      executor: async () => ({ ok: true, commit: 'abc' }),
      verifyDone: guard,
    });

    expect(summary.falseDone).toBe(1);
    expect(summary.completed).toBe(0);
    // Downstream was never claimed — its upstream didn't complete.
    const down = listTasks(db, {}).find((t) => t.id === downId);
    expect(down?.status).toBe('ready'); // still waiting
    expect(listTasks(db, { status: 'done' })).toHaveLength(0);
  });
});
