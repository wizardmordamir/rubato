import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { addTask, claim, listTasks, migrate, type TaskqDb } from 'cwip/taskq';
import { runDrain, type TaskExecutor } from './orchestrator';

function fresh(): TaskqDb {
  const d = new Database(':memory:') as unknown as TaskqDb;
  d.exec('PRAGMA foreign_keys = ON');
  migrate(d);
  return d;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Fake executor: succeeds unless the title is "boom". */
const okExecutor: TaskExecutor = async (task) =>
  task.title === 'boom' ? { ok: false, reason: 'kaboom' } : { ok: true, commit: 'abc1234', summary: 'did it' };

describe('runDrain', () => {
  test('drains all one-shots to done across workers', async () => {
    const db = fresh();
    for (let i = 0; i < 6; i++) addTask(db, { title: `t${i}` }, { at: 'bottom' });
    const summary = await runDrain(db, { jobs: 3, executor: okExecutor });
    expect(summary.completed).toBe(6);
    expect(listTasks(db, { status: 'done' }).length).toBe(6);
    expect(listTasks(db, { status: 'ready' }).length).toBe(0);
  });

  test('a failing task lands as failed + note', async () => {
    const db = fresh();
    addTask(db, { title: 'ok1' }, { at: 'bottom' });
    addTask(db, { title: 'boom' }, { at: 'bottom' });
    const summary = await runDrain(db, { jobs: 1, executor: okExecutor });
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(1);
    const failed = listTasks(db, { status: 'failed' });
    expect(failed[0]?.note).toBe('kaboom');
  });

  test('shouldStop halts further claims', async () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) addTask(db, { title: `t${i}` }, { at: 'bottom' });
    let done = 0;
    const summary = await runDrain(db, {
      jobs: 1,
      executor: async () => {
        done++;
        return { ok: true };
      },
      shouldStop: () => done >= 2, // stop after 2 complete
    });
    expect(summary.completed).toBe(2);
    expect(listTasks(db, { status: 'ready' }).length).toBe(3);
  });

  test('reaps a stranded lease before draining', async () => {
    const db = fresh();
    const id = addTask(db, { title: 'stranded' });
    // Claim with an already-expired lease (prior crashed run).
    claim(db, id, { workerId: 'dead', nowMs: 1000, ttlMs: 1 });
    const summary = await runDrain(db, { jobs: 1, executor: okExecutor, now: () => 10_000 });
    expect(summary.reaped).toBe(1);
    expect(summary.completed).toBe(1);
    expect(listTasks(db, { status: 'done' }).length).toBe(1);
  });

  test('executor throwing fails the task, not the drain', async () => {
    const db = fresh();
    addTask(db, { title: 'throws' });
    const summary = await runDrain(db, {
      jobs: 1,
      executor: async () => {
        throw new Error('boom');
      },
    });
    expect(summary.failed).toBe(1);
    expect(listTasks(db, { status: 'failed' })[0]?.note).toContain('executor threw');
  });

  test('grows the pool to a raised desiredJobs mid-run (no restart)', async () => {
    const db = fresh();
    for (let i = 0; i < 12; i++) addTask(db, { title: `t${i}` }, { at: 'bottom' });
    // Start at 1 worker; bump the live target to 3 as soon as the first task runs.
    let target = 1;
    const slotsThatWorked = new Set<number>();
    const summary = await runDrain(db, {
      jobs: 1,
      desiredJobs: () => target,
      tickMs: 5, // resize quickly so the test is fast
      executor: async (_task, ctx) => {
        slotsThatWorked.add(ctx.index);
        target = 3; // a config bump lands while the drain is already running
        await sleep(10); // stay busy long enough for a supervisor tick to grow the pool
        return { ok: true };
      },
    });
    expect(summary.completed).toBe(12);
    // The extra slots actually claimed work — not just slot 0 doing everything.
    expect(slotsThatWorked.size).toBeGreaterThan(1);
    expect(listTasks(db, { status: 'ready' }).length).toBe(0);
  });

  test('refills an idle worker when NEW work appears while a long task pins another', async () => {
    const db = fresh();
    // Only the long task is ready at start; it pins slot 0 for a while.
    addTask(db, { title: 'long' }, { at: 'bottom' });
    let lateId = -1;
    const completedBy: Record<number, number> = {};
    const summary = await runDrain(db, {
      jobs: 2,
      tickMs: 5,
      executor: async (task) => {
        if (task.title === 'long') {
          // Slot 1 has already idled out (nothing else was ready). Add new work
          // mid-run, then stay busy far longer than the late task takes — so if
          // refill is broken the late task can only be picked up AFTER this one.
          if (lateId === -1) lateId = addTask(db, { title: 'late' }, { at: 'bottom' });
          await sleep(60);
        }
        return { ok: true };
      },
      onEvent: (e) => {
        if (e.type === 'completed') completedBy[e.taskId] = e.worker;
      },
    });
    expect(summary.completed).toBe(2);
    // The late task ran on a REFILLED slot (worker 1) while slot 0 was still on
    // the long task — not picked up by slot 0 after the long task finished.
    expect(completedBy[lateId]).toBe(1);
  });

  test('shrinks: a worker retires when its slot index passes desiredJobs', async () => {
    const db = fresh();
    for (let i = 0; i < 8; i++) addTask(db, { title: `t${i}` }, { at: 'bottom' });
    let target = 3;
    const summary = await runDrain(db, {
      jobs: 3,
      desiredJobs: () => target,
      tickMs: 5,
      executor: async () => {
        target = 1; // drop to a single worker; slots 1 & 2 should retire after their task
        await sleep(5);
        return { ok: true };
      },
    });
    // Still drains everything — shrinking never strands tasks.
    expect(summary.completed).toBe(8);
    expect(listTasks(db, { status: 'ready' }).length).toBe(0);
  });

  test('onTick fires as a liveness heartbeat across a long pass', async () => {
    const db = fresh();
    addTask(db, { title: 'slow' });
    let ticks = 0;
    await runDrain(db, {
      jobs: 1,
      tickMs: 5,
      onTick: () => {
        ticks++;
      },
      executor: async () => {
        await sleep(40); // ~8 ticks worth of work
        return { ok: true };
      },
    });
    // Initial stamp + several heartbeats while the single task ran.
    expect(ticks).toBeGreaterThan(2);
  });
});
