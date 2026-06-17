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
});
