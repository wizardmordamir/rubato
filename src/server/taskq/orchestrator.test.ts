import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { addTask, claim, getTask, listTasks, migrate, type TaskqDb } from 'cwip/taskq';
import type { DoneGuard } from './falseDone';
import { type DrainEvent, runDrain, type TaskExecutor } from './orchestrator';

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

  test('a failing task lands terminal failed + note once attempts are exhausted', async () => {
    const db = fresh();
    addTask(db, { title: 'ok1' }, { at: 'bottom' });
    addTask(db, { title: 'boom' }, { at: 'bottom' });
    // maxAttempts:1 → the first failure is already terminal (no retry).
    const summary = await runDrain(db, { jobs: 1, executor: okExecutor, retry: { maxAttempts: 1 } });
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.retried).toBe(0);
    const failed = listTasks(db, { status: 'failed' });
    expect(failed[0]?.note).toBe('kaboom');
  });

  test('a transient failure is RETRIED with a backoff (not burned); independents still drain', async () => {
    const db = fresh();
    addTask(db, { title: 'ok1' }, { at: 'bottom' });
    addTask(db, { title: 'boom' }, { at: 'bottom' });
    // A real (future) backoff holds the retried task out of THIS pass — proving it
    // was re-queued, not terminal — while the independent task still completes.
    const summary = await runDrain(db, {
      jobs: 1,
      executor: okExecutor,
      retry: { maxAttempts: 3, backoff: { baseMs: 60_000, jitter: 0 } },
    });
    expect(summary.completed).toBe(1); // ok1
    expect(summary.retried).toBe(1); // boom re-queued
    expect(summary.failed).toBe(0);
    expect(listTasks(db, { status: 'failed' }).length).toBe(0);
    const boom = listTasks(db, { status: 'ready' }).find((t) => t.title === 'boom');
    expect(boom?.attempts).toBe(1);
    expect(boom?.note).toBe('kaboom');
    expect(boom?.recur_next_at).toBeGreaterThan(Date.now()); // waiting out the backoff
  });

  test('a permanent failure skips retries — terminal on the first failure', async () => {
    const db = fresh();
    addTask(db, { title: 'dead-end' });
    const summary = await runDrain(db, {
      jobs: 1,
      executor: async () => ({ ok: false, reason: 'impossible', permanent: true }),
      retry: { maxAttempts: 5 }, // ample budget, but permanent skips it
    });
    expect(summary.failed).toBe(1);
    expect(summary.retried).toBe(0);
    expect(listTasks(db, { status: 'failed' })[0]?.note).toBe('impossible');
  });

  test('retries up to the ceiling within a pass, then parks terminal failed', async () => {
    const db = fresh();
    addTask(db, { title: 'always-fails' });
    let calls = 0;
    // Zero backoff → each retry is immediately eligible, so the budget burns in one pass.
    const summary = await runDrain(db, {
      jobs: 1,
      executor: async () => {
        calls++;
        return { ok: false, reason: 'still broken' };
      },
      retry: { maxAttempts: 3, backoff: { baseMs: 0 } },
    });
    expect(calls).toBe(3); // attempt 1 + 2 retries
    expect(summary.retried).toBe(2);
    expect(summary.failed).toBe(1);
    const failed = listTasks(db, { status: 'failed' });
    expect(failed.length).toBe(1);
    expect(failed[0]?.attempts).toBe(3);
  });

  test('a rate-limited result releases the task back to ready and winds the pool down', async () => {
    const db = fresh();
    for (let i = 0; i < 4; i++) addTask(db, { title: `t${i}` }, { at: 'bottom' });
    let calls = 0;
    const types: string[] = [];
    const summary = await runDrain(db, {
      jobs: 1,
      executor: async () => {
        calls++;
        return { ok: false, reason: 'Claude usage limit reached', rateLimited: true };
      },
      onEvent: (e) => types.push(e.type),
    });
    // The claimed task is back to ready (NOT failed/done), nothing was burned.
    expect(summary.rateLimited).toBe(true);
    expect(summary.failed).toBe(0);
    expect(summary.completed).toBe(0);
    expect(listTasks(db, { status: 'ready' }).length).toBe(4);
    expect(listTasks(db, { status: 'failed' }).length).toBe(0);
    expect(listTasks(db, { status: 'claimed' }).length).toBe(0);
    // Wound down after the FIRST limit hit — didn't thrash through the whole queue.
    expect(calls).toBe(1);
    expect(types).toContain('rate-limited');
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

  test('executor throwing fails the task, not the drain (terminal once attempts exhausted)', async () => {
    const db = fresh();
    addTask(db, { title: 'throws' });
    // A throw is treated as transient and retried; pin maxAttempts:1 so it parks at once.
    const summary = await runDrain(db, {
      jobs: 1,
      executor: async () => {
        throw new Error('boom');
      },
      retry: { maxAttempts: 1 },
    });
    expect(summary.failed).toBe(1);
    expect(listTasks(db, { status: 'failed' })[0]?.note).toContain('executor threw');
  });

  test('an executor throw is retried by default (transient), not immediately terminal', async () => {
    const db = fresh();
    addTask(db, { title: 'flaky-throw' });
    const summary = await runDrain(db, {
      jobs: 1,
      executor: async () => {
        throw new Error('spawn EAGAIN');
      },
      retry: { maxAttempts: 3, backoff: { baseMs: 60_000, jitter: 0 } },
    });
    expect(summary.retried).toBe(1);
    expect(summary.failed).toBe(0);
    const t = listTasks(db, { status: 'ready' })[0];
    expect(t?.attempts).toBe(1);
    expect(t?.note).toContain('executor threw');
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

/**
 * The completion gate ({@link DoneGuard}) — a reported "success" only becomes `done`
 * if the gate accepts it; a `revert` verdict parks it in a hold instead. Modeled
 * here with a fake guard so the orchestrator wiring is tested without git/builds.
 */
describe('runDrain false-done gate', () => {
  // Reject anything titled 'fake' as an empty-done; accept the rest.
  const guard = (verdict: (title: string) => ReturnType<DoneGuard['verify']>): DoneGuard => ({
    snapshot: () => ({ captured: true }),
    verify: (task) => verdict(task.title),
  });
  const emptyDone = guard((title) =>
    title === 'fake'
      ? { accept: false, status: 'needs_input', reason: 'empty-done', note: 'landed ZERO commits' }
      : { accept: true },
  );

  test('a rejected success is reverted to the hold status (not done) + counted + alert-evented', async () => {
    const db = fresh();
    const id = addTask(db, { title: 'fake' });
    const events: DrainEvent[] = [];
    const summary = await runDrain(db, {
      jobs: 1,
      executor: okExecutor,
      verifyDone: emptyDone,
      onEvent: (e) => events.push(e),
    });
    expect(summary.completed).toBe(0);
    expect(summary.falseDone).toBe(1);
    const t = getTask(db, id);
    expect(t?.status).toBe('needs_input'); // reverted, NOT done
    expect(t?.note).toBe('landed ZERO commits');
    expect(listTasks(db, { status: 'done' }).length).toBe(0);
    expect(listTasks(db, { status: 'claimed' }).length).toBe(0); // lease dropped
    const fd = events.find((e) => e.type === 'false-done');
    expect(fd).toBeTruthy();
    if (fd?.type === 'false-done') expect(fd.reason).toBe('empty-done');
  });

  test('a false-done never cascades: a downstream needs: dep stays blocked', async () => {
    const db = fresh();
    addTask(db, { title: 'fake', slug: 'upstream' }, { at: 'bottom' });
    const downId = addTask(db, { title: 'downstream', needs: ['upstream'] }, { at: 'bottom' });
    const summary = await runDrain(db, { jobs: 1, executor: okExecutor, verifyDone: emptyDone });
    // upstream was caught as a false-done; downstream's needs: is therefore NOT
    // satisfied (upstream isn't `done`), so it was never claimed/run.
    expect(summary.falseDone).toBe(1);
    expect(summary.completed).toBe(0);
    expect(getTask(db, downId)?.status).toBe('ready'); // still waiting, not done
    expect(listTasks(db, { status: 'done' }).length).toBe(0);
  });

  test('an accepted success still completes to done as normal', async () => {
    const db = fresh();
    const id = addTask(db, { title: 'real-work' });
    const summary = await runDrain(db, { jobs: 1, executor: okExecutor, verifyDone: emptyDone });
    expect(summary.completed).toBe(1);
    expect(summary.falseDone).toBe(0);
    expect(getTask(db, id)?.status).toBe('done');
  });

  test('fails OPEN: a guard that throws does not strand a finished task (it completes)', async () => {
    const db = fresh();
    const id = addTask(db, { title: 'work' });
    const events: DrainEvent[] = [];
    const throwingGuard: DoneGuard = {
      snapshot: () => ({}),
      verify: () => {
        throw new Error('git exploded');
      },
    };
    const summary = await runDrain(db, {
      jobs: 1,
      executor: okExecutor,
      verifyDone: throwingGuard,
      onEvent: (e) => events.push(e),
    });
    expect(summary.completed).toBe(1);
    expect(summary.falseDone).toBe(0);
    expect(getTask(db, id)?.status).toBe('done');
    expect(events.some((e) => e.type === 'error' && e.error.includes('done-gate verify'))).toBe(true);
  });

  test('without a guard, behavior is unchanged (every success completes)', async () => {
    const db = fresh();
    addTask(db, { title: 'fake' }); // would be rejected IF a guard were attached
    const summary = await runDrain(db, { jobs: 1, executor: okExecutor });
    expect(summary.completed).toBe(1);
    expect(summary.falseDone).toBe(0);
  });
});
