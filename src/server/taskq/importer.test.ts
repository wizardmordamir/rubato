import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { listTasks, migrate, type TaskqDb } from 'cwip/taskq';
import { importTasksMd } from './importer';

const SAMPLE = `<!-- legend -->

## [ ] (model:sonnet) (think:med) (id:one) ca first ready task
body one.

<!-- ===== SECTION BANNER that parseTaskBoard would otherwise swallow ===== -->

## [b] (model:opus) held task
why held.

## [-] (needs:one) not ready yet

## [~] (worktree: w · 2026-01-01T00:00:00Z) claimed one

## [x] (2026-01-01T00:00:00Z → 2026-01-01T00:09:00Z · 9m · rubato abc1234) done one

## [!] (needs live creds) ai blocked task
`;

function fresh(): TaskqDb {
  const d = new Database(':memory:') as unknown as TaskqDb;
  d.exec('PRAGMA foreign_keys = ON');
  migrate(d);
  return d;
}

describe('importTasksMd', () => {
  test('maps statuses + markers; skips runtime/history', () => {
    const db = fresh();
    const r = importTasksMd(db, SAMPLE);
    expect(r.imported).toBe(4); // ready + on_hold + not_ready + failed
    expect(r.skipped.length).toBe(2); // claimed + done

    const tasks = listTasks(db);
    const first = tasks.find((t) => t.slug === 'one');
    expect(first?.status).toBe('ready');
    expect(first?.model).toBe('sonnet');
    expect(first?.think).toBe('medium'); // 'med' normalized
    expect(first?.repo).toBe('ca'); // inferred from leading token
    expect(first?.body).toBe('body one.'); // trailing <!-- banner --> trimmed

    expect(tasks.find((t) => t.title === 'held task')?.status).toBe('on_hold');
    expect(tasks.find((t) => t.title === 'ai blocked task')?.status).toBe('failed');
    const notReady = tasks.find((t) => t.title === 'not ready yet');
    expect(notReady?.status).toBe('not_ready');
  });

  test('re-run is idempotent (slug + title dedupe)', () => {
    const db = fresh();
    importTasksMd(db, SAMPLE);
    const second = importTasksMd(db, SAMPLE);
    expect(second.imported).toBe(0);
    expect(listTasks(db).length).toBe(4);
  });
});
