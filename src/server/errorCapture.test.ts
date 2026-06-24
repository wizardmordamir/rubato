import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureServerErrorTask } from './errorCapture';
import { __resetTaskqDbForTests } from './taskqDb';

// Point the capture at a throwaway taskq DB (TASKQ_HOME) so it never touches the
// real ~/.taskq, and toggle ERROR_AUTO_TASK per test.

let dir: string;
const prevEnabled = process.env.ERROR_AUTO_TASK;
const prevHome = process.env.TASKQ_HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ru-err500-'));
  process.env.TASKQ_HOME = dir;
  __resetTaskqDbForTests();
});

afterEach(() => {
  __resetTaskqDbForTests();
  if (prevEnabled === undefined) delete process.env.ERROR_AUTO_TASK;
  else process.env.ERROR_AUTO_TASK = prevEnabled;
  if (prevHome === undefined) delete process.env.TASKQ_HOME;
  else process.env.TASKQ_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

const tasks = (): { title: string; body: string; status: string }[] => {
  const db = new Database(join(dir, 'taskq.sqlite'));
  try {
    const exists = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (!exists) return [];
    return db.query('SELECT title, body, status FROM tasks').all() as never;
  } finally {
    db.close();
  }
};

describe('captureServerErrorTask (rubato)', () => {
  test('no-op when ERROR_AUTO_TASK is unset (never pollutes the live queue)', () => {
    delete process.env.ERROR_AUTO_TASK;
    captureServerErrorTask({ method: 'GET', url: '/api/x', status: 500, error: new Error('boom') });
    expect(tasks()).toHaveLength(0);
  });

  test('ignores < 500', () => {
    process.env.ERROR_AUTO_TASK = 'true';
    captureServerErrorTask({ method: 'GET', url: '/api/x', status: 404, error: new Error('nope') });
    expect(tasks()).toHaveLength(0);
  });

  test('files ONE deduped ru task for the same 500 signature', () => {
    process.env.ERROR_AUTO_TASK = 'true';
    const error = new Error('kaboom');
    captureServerErrorTask({ method: 'GET', url: '/api/apps/1', status: 500, error });
    const first = tasks();
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe('ready');
    expect(first[0].title).toContain('[500] GET /api/apps/:id');

    captureServerErrorTask({ method: 'GET', url: '/api/apps/2', status: 500, error });
    const after = tasks();
    expect(after).toHaveLength(1);
    expect(after[0].body).toContain('Occurrences:** 2');
  });

  test('never throws on a bad context', () => {
    process.env.ERROR_AUTO_TASK = 'true';
    expect(() => captureServerErrorTask({ method: 'GET', url: '/api/x', status: 500, error: undefined })).not.toThrow();
  });

  test('captures redacted payload in the task body', () => {
    process.env.ERROR_AUTO_TASK = 'true';
    captureServerErrorTask({
      method: 'POST',
      url: '/api/run',
      status: 500,
      error: new Error('fail'),
      payload: { command: 'scan', password: 'hunter2', args: ['--all'] },
    });
    const t = tasks();
    expect(t).toHaveLength(1);
    expect(t[0].body).toContain('Request payload (redacted)');
    expect(t[0].body).toContain('"command"');
    expect(t[0].body).not.toContain('hunter2');
    expect(t[0].body).toContain('***redacted***');
  });

  test('omits payload section when no payload is provided (GET or non-JSON body path)', () => {
    process.env.ERROR_AUTO_TASK = 'true';
    captureServerErrorTask({ method: 'GET', url: '/api/apps', status: 500, error: new Error('boom') });
    const t = tasks();
    expect(t).toHaveLength(1);
    expect(t[0].body).not.toContain('Request payload');
  });

  test('omits payload section when payload is an empty object', () => {
    process.env.ERROR_AUTO_TASK = 'true';
    captureServerErrorTask({ method: 'POST', url: '/api/run', status: 500, error: new Error('boom'), payload: {} });
    const t = tasks();
    expect(t).toHaveLength(1);
    expect(t[0].body).not.toContain('Request payload');
  });
});
