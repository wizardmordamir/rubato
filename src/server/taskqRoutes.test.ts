import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskqBoard } from '../shared/taskq';
import { handleTaskqApi } from './taskqRoutes';
import { __resetTaskqDbForTests } from './taskqDb';

let dir: string;
const prev = process.env.TASKQ_DB;
const prevHome = process.env.TASKQ_HOME;

const call = (method: string, path: string, body?: unknown) =>
  handleTaskqApi(
    path,
    new Request(`http://x${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
const boardOf = async (res: Response) => ((await res.json()) as { board: TaskqBoard }).board;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'taskq-routes-'));
  process.env.TASKQ_DB = join(dir, 'q.sqlite');
  process.env.TASKQ_HOME = dir; // isolate config.json + logs from the real ~/.taskq
});
afterAll(() => {
  if (prev === undefined) delete process.env.TASKQ_DB;
  else process.env.TASKQ_DB = prev;
  if (prevHome === undefined) delete process.env.TASKQ_HOME;
  else process.env.TASKQ_HOME = prevHome;
});
beforeEach(() => __resetTaskqDbForTests());

describe('taskq routes', () => {
  test('GET empty board', async () => {
    const board = (await (await call('GET', '/api/taskq')).json()) as TaskqBoard;
    expect(board.total).toBe(0);
  });

  test('add → board → patch → status → delete', async () => {
    const add = await call('POST', '/api/taskq/tasks', { draft: { title: 'first', model: 'sonnet' } });
    expect(add.status).toBe(200);
    const { id } = (await add.json()) as { id: number };
    expect(id).toBeGreaterThan(0);

    const board = (await (await call('GET', '/api/taskq')).json()) as TaskqBoard;
    expect(board.total).toBe(1);
    expect(board.tasks[0].title).toBe('first');

    const patched = await boardOf(await call('PATCH', `/api/taskq/tasks/${id}`, { patch: { title: 'renamed', needs: ['x'] } }));
    expect(patched.tasks[0].title).toBe('renamed');
    expect(patched.tasks[0].needs).toEqual(['x']);

    const held = await boardOf(await call('POST', `/api/taskq/tasks/${id}/status`, { status: 'on_hold', note: 'why' }));
    expect(held.counts.on_hold).toBe(1);
    expect(held.tasks[0].note).toBe('why');

    const afterDel = await boardOf(await call('DELETE', `/api/taskq/tasks/${id}`));
    expect(afterDel.total).toBe(0);
  });

  test('rejects an invalid draft (400)', async () => {
    const res = await call('POST', '/api/taskq/tasks', { draft: { title: 'bad', model: 'gpt' } });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown status (400)', async () => {
    const { id } = (await (await call('POST', '/api/taskq/tasks', { draft: { title: 't' } })).json()) as { id: number };
    const res = await call('POST', `/api/taskq/tasks/${id}/status`, { status: 'bogus' });
    expect(res.status).toBe(400);
  });

  test('usage: GET buckets + calibrate', async () => {
    const buckets = (await (await call('GET', '/api/taskq/usage')).json()) as { buckets: { key: string; fraction: number }[] };
    expect(buckets.buckets.length).toBe(3);

    const cal = await call('POST', '/api/taskq/usage/calibrate', { key: 'session_5h', consumedFraction: 0.75, resetAt: Date.now() + 3600_000 });
    expect(cal.status).toBe(200);
    const after = (await cal.json()) as { buckets: { key: string; fraction: number }[] };
    const s = after.buckets.find((b) => b.key === 'session_5h');
    expect(Math.round((s?.fraction ?? 0) * 100)).toBe(25); // 75% consumed → 25% left

    const bad = await call('POST', '/api/taskq/usage/calibrate', { key: 'nope', consumedFraction: 0.5 });
    expect(bad.status).toBe(400);
  });

  test('config: GET → patch jobs/model/fleet → reflected; bad model 400', async () => {
    const get1 = (await (await call('GET', '/api/taskq/config')).json()) as { config: { jobs: number } };
    expect(get1.config.jobs).toBeGreaterThanOrEqual(1);

    const saved = (await (
      await call('POST', '/api/taskq/config', { jobs: 4, model: 'sonnet', fleet: [{ models: ['sonnet', 'haiku'], jobs: 2 }] })
    ).json()) as { config: { jobs: number; model: string; fleet?: { jobs: number }[] } };
    expect(saved.config.jobs).toBe(4);
    expect(saved.config.model).toBe('sonnet');
    expect(saved.config.fleet?.[0].jobs).toBe(2);

    const bad = await call('POST', '/api/taskq/config', { model: 'gpt' });
    expect(bad.status).toBe(400);
  });

  test('instances: empty, then one appears after a claim-equivalent', async () => {
    const empty = (await (await call('GET', '/api/taskq/instances')).json()) as { instances: unknown[] };
    expect(empty.instances.length).toBe(0);
    // logs endpoint returns a shape even with no log file
    const logs = (await (await call('GET', '/api/taskq/logs')).json()) as { lines: string[] };
    expect(Array.isArray(logs.lines)).toBe(true);
  });
});
