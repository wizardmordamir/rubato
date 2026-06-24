/**
 * Unit tests for the stalled-state detector (`selfHealer.ts`).
 *
 * All tests use an in-memory SQLite DB — no real filesystem, no drain spawning.
 * The detection is pure: it only reads from the `leases` table joined with `tasks`.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { addTask, claim, heartbeat, listTasks, migrate, type TaskqDb } from 'cwip/taskq';
import { detectStalledStates } from './selfHealer';

function fresh(): TaskqDb {
  const d = new Database(':memory:') as unknown as TaskqDb;
  d.exec('PRAGMA foreign_keys = ON');
  migrate(d);
  return d;
}

/** Claim a task with an already-expired TTL (simulates a dead worker). */
function claimExpired(db: TaskqDb, taskId: number, workerId = 'dead-worker'): void {
  const past = Date.now() - 60_000; // 1 minute ago
  claim(db, taskId, { workerId, nowMs: past, ttlMs: 1 }); // expires_at = past + 1ms ≪ now
}

describe('detectStalledStates — empty queue', () => {
  test('returns empty arrays when no leases exist', () => {
    const db = fresh();
    const snap = detectStalledStates(db, Date.now());
    expect(snap.expiredLeases).toHaveLength(0);
    expect(snap.longRunning).toHaveLength(0);
  });

  test('a ready task (no lease) is not stalled', () => {
    const db = fresh();
    addTask(db, { title: 'waiting task' });
    const snap = detectStalledStates(db, Date.now());
    expect(snap.expiredLeases).toHaveLength(0);
  });
});

describe('detectStalledStates — expired leases', () => {
  test('detects an expired lease with correct fields', () => {
    const db = fresh();
    const id = addTask(db, { title: 'stranded task' });
    claimExpired(db, id, 'crashed-worker');

    const snap = detectStalledStates(db, Date.now());

    expect(snap.expiredLeases).toHaveLength(1);
    const lease = snap.expiredLeases[0]!;
    expect(lease.taskId).toBe(id);
    expect(lease.title).toBe('stranded task');
    expect(lease.workerId).toBe('crashed-worker');
    expect(lease.expiredMs).toBeGreaterThan(0);
    expect(lease.claimedAt).toBeGreaterThan(0);
  });

  test('a live (non-expired) lease is NOT in expiredLeases', () => {
    const db = fresh();
    const id = addTask(db, { title: 'live task' });
    claim(db, id, { workerId: 'live-worker', nowMs: Date.now(), ttlMs: 60 * 60_000 });

    const snap = detectStalledStates(db, Date.now());
    expect(snap.expiredLeases).toHaveLength(0);
  });

  test('detects multiple expired leases at once', () => {
    const db = fresh();
    const ids = [addTask(db, { title: 'a' }), addTask(db, { title: 'b' }), addTask(db, { title: 'c' })];
    for (const id of ids) claimExpired(db, id);

    const snap = detectStalledStates(db, Date.now());
    expect(snap.expiredLeases).toHaveLength(3);
    const returnedIds = snap.expiredLeases.map((l) => l.taskId);
    for (const id of ids) expect(returnedIds).toContain(id);
  });

  test('separates expired leases from live leases', () => {
    const db = fresh();
    const expiredId = addTask(db, { title: 'expired' });
    const liveId = addTask(db, { title: 'live' });

    claimExpired(db, expiredId, 'dead-w');
    claim(db, liveId, { workerId: 'live-w', nowMs: Date.now(), ttlMs: 60 * 60_000 });

    const snap = detectStalledStates(db, Date.now());
    expect(snap.expiredLeases).toHaveLength(1);
    expect(snap.expiredLeases[0]!.taskId).toBe(expiredId);
  });

  test('expiredMs reflects how long ago the lease expired', () => {
    const db = fresh();
    const id = addTask(db, { title: 'expired task' });
    const pastMs = Date.now() - 60_000;
    // Claim with a 1ms TTL so it expires 1ms after claim time
    claim(db, id, { workerId: 'w', nowMs: pastMs, ttlMs: 1 });

    const nowMs = Date.now();
    const snap = detectStalledStates(db, nowMs);
    // expiredMs ≈ nowMs - (pastMs + 1ms) ≈ 60_000ms - 1ms ≈ ~60s
    expect(snap.expiredLeases[0]!.expiredMs).toBeGreaterThan(50_000);
  });
});

describe('detectStalledStates — long-running tasks', () => {
  test('flags a live task running longer than taskTimeoutMs', () => {
    const db = fresh();
    const id = addTask(db, { title: 'slow task' });
    const farPast = Date.now() - 10 * 60_000; // claimed 10 min ago
    claim(db, id, { workerId: 'slow-worker', nowMs: farPast, ttlMs: 60 * 60_000 });
    heartbeat(db as unknown as TaskqDb, id, Date.now() - 30_000); // heartbeat 30s ago

    const snap = detectStalledStates(db, Date.now(), { taskTimeoutMs: 5 * 60_000 }); // 5 min timeout
    expect(snap.longRunning).toHaveLength(1);
    const lr = snap.longRunning[0]!;
    expect(lr.taskId).toBe(id);
    expect(lr.title).toBe('slow task');
    expect(lr.workerId).toBe('slow-worker');
    expect(lr.elapsedMs).toBeGreaterThan(9 * 60_000);
    expect(lr.msSinceHeartbeat).toBeGreaterThan(0);
  });

  test('does NOT flag a task running under the timeout', () => {
    const db = fresh();
    const id = addTask(db, { title: 'quick task' });
    claim(db, id, { workerId: 'w', nowMs: Date.now() - 60_000, ttlMs: 60 * 60_000 }); // 1 min ago

    const snap = detectStalledStates(db, Date.now(), { taskTimeoutMs: 5 * 60_000 }); // 5 min timeout
    expect(snap.longRunning).toHaveLength(0);
  });

  test('does NOT flag long-running when taskTimeoutMs is 0', () => {
    const db = fresh();
    const id = addTask(db, { title: 'infinite run' });
    claim(db, id, { workerId: 'w', nowMs: Date.now() - 24 * 60 * 60_000, ttlMs: 99 * 60 * 60_000 }); // 24h ago

    const snap = detectStalledStates(db, Date.now(), { taskTimeoutMs: 0 });
    expect(snap.longRunning).toHaveLength(0);
  });

  test('does NOT flag long-running when taskTimeoutMs is omitted', () => {
    const db = fresh();
    const id = addTask(db, { title: 'infinite run' });
    claim(db, id, { workerId: 'w', nowMs: Date.now() - 24 * 60 * 60_000, ttlMs: 99 * 60 * 60_000 });

    const snap = detectStalledStates(db, Date.now()); // no opts
    expect(snap.longRunning).toHaveLength(0);
  });

  test('an EXPIRED lease goes to expiredLeases, NOT longRunning', () => {
    const db = fresh();
    const id = addTask(db, { title: 'dead task' });
    claimExpired(db, id); // expires immediately

    const snap = detectStalledStates(db, Date.now(), { taskTimeoutMs: 1 }); // 1ms — definitely past
    // Expired → expiredLeases, even though elapsedMs >> taskTimeoutMs
    expect(snap.expiredLeases).toHaveLength(1);
    expect(snap.longRunning).toHaveLength(0);
  });
});

describe('detectStalledStates — worktree field', () => {
  test('captures worktree from the lease when set', () => {
    const db = fresh();
    const id = addTask(db, { title: 'tracked task' });
    const past = Date.now() - 60_000;
    // claim with a worktree
    const db2 = db as unknown as Database;
    db2.exec(`
      INSERT INTO leases (task_id, worker_id, worktree, claimed_at, heartbeat_at, expires_at)
      VALUES (${id}, 'w1', 'my-worktree', ${past}, ${past}, ${past + 1})
    `);

    // Mark the task as claimed
    db2.exec(`UPDATE tasks SET status = 'claimed' WHERE id = ${id}`);

    const snap = detectStalledStates(db, Date.now());
    expect(snap.expiredLeases[0]!.worktree).toBe('my-worktree');
  });
});

describe('detectStalledStates — snapshot metadata', () => {
  test('returns the nowMs it was taken at', () => {
    const db = fresh();
    const t = 1_700_000_000_000;
    const snap = detectStalledStates(db, t);
    expect(snap.nowMs).toBe(t);
  });

  test('void return: does not mutate any task status', () => {
    const db = fresh();
    const id = addTask(db, { title: 'untouched' });
    claimExpired(db, id);

    detectStalledStates(db, Date.now()); // detection only

    // Task is still `claimed` — the detector never mutates
    expect(listTasks(db, { status: 'claimed' })).toHaveLength(1);
    expect(listTasks(db, { status: 'ready' })).toHaveLength(0);
  });
});
