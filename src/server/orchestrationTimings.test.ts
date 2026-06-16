/**
 * Orchestration Processing — server timing ingest + aggregation + clear.
 *
 * Isolated by testSetup (RUBATO_HOME → a throwaway dir) so the DB is per-run; we
 * additionally point RUBATO_NOTES_DIR at a temp dir and drop a `timing-*.jsonl`
 * fixture there so `ingestTimings()` reads it. Covers: ingest idempotency (twice →
 * no dupes), clear-all + clear-before, and that the GET aggregation returns correct
 * per-category stats (count/min/max/avg/median/total) over a seeded fixture.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetDbForTests, insertTimingEvents } from './db';
import { clearStoredTimings, getTimingOverview, ingestTimings } from './orchestrationTimings';

// One orchlog JSONL line. Mirrors orchlog's emit() shape; `group` is derived by the
// parser from `category`, so we leave it off here to prove parsing fills it in.
const line = (o: {
  id: string;
  session?: string;
  repo?: string;
  category: string;
  kind?: string;
  duration_ms: number;
  ts: number;
}) =>
  JSON.stringify({
    schema: 'orchlog/v1',
    event_id: o.id,
    session: o.session ?? 'W1-1000',
    worker: 'W1',
    task_id: 'demo',
    task_title: 'Demo task',
    repo: o.repo ?? 'rubato',
    category: o.category,
    kind: o.kind ?? 'run',
    ok: true,
    start: new Date(o.ts - o.duration_ms).toISOString(),
    end: new Date(o.ts).toISOString(),
    duration_ms: o.duration_ms,
    ts: o.ts,
  });

const TS = Date.UTC(2026, 5, 14, 12, 0, 0); // a fixed base epoch for deterministic tests

let notesDir = '';
const prevNotesEnv = process.env.RUBATO_NOTES_DIR;

function writeTimingFile(name: string, lines: string[]): void {
  const runs = join(notesDir, 'orchestration', 'runs');
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, name), `${lines.join('\n')}\n`, 'utf8');
}

beforeEach(() => {
  // Fresh DB + a fresh temp notes dir per test.
  __resetDbForTests();
  if (notesDir) rmSync(notesDir, { recursive: true, force: true });
  notesDir = mkdtempSync(join(tmpdir(), 'rubato-timings-'));
  process.env.RUBATO_NOTES_DIR = notesDir;
});

afterAll(() => {
  if (notesDir) rmSync(notesDir, { recursive: true, force: true });
  if (prevNotesEnv === undefined) delete process.env.RUBATO_NOTES_DIR;
  else process.env.RUBATO_NOTES_DIR = prevNotesEnv;
  __resetDbForTests();
});

describe('ingest', () => {
  test('is idempotent — ingesting the same file twice inserts no dupes', async () => {
    writeTimingFile('timing-20260614.jsonl', [
      line({ id: 'W1-1000:0001', category: 'typecheck', duration_ms: 1000, ts: TS }),
      line({ id: 'W1-1000:0002', category: 'lint', duration_ms: 2000, ts: TS + 1000 }),
    ]);

    const first = await ingestTimings();
    expect(first.filesRead).toBe(1);
    expect(first.inserted).toBe(2);
    expect(first.skipped).toBe(0);

    // Re-ingest: same event_ids → all skipped, nothing inserted.
    const second = await ingestTimings();
    expect(second.filesRead).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);

    const overview = await getTimingOverview();
    expect(overview.total).toBe(2);
  });

  test('a new event appended to the file is the only thing inserted on re-ingest', async () => {
    writeTimingFile('timing-20260614.jsonl', [line({ id: 'a', category: 'build', duration_ms: 500, ts: TS })]);
    expect((await ingestTimings()).inserted).toBe(1);

    writeTimingFile('timing-20260614.jsonl', [
      line({ id: 'a', category: 'build', duration_ms: 500, ts: TS }),
      line({ id: 'b', category: 'build', duration_ms: 700, ts: TS + 500 }),
    ]);
    const res = await ingestTimings();
    expect(res.inserted).toBe(1);
    expect(res.skipped).toBe(1);
    expect((await getTimingOverview()).total).toBe(2);
  });

  test('missing runs dir → clean zero result, not an error', async () => {
    const res = await ingestTimings();
    expect(res).toEqual({ filesRead: 0, inserted: 0, skipped: 0 });
  });
});

describe('aggregation', () => {
  test('per-category stats are correct (count/min/max/avg/median/total)', async () => {
    // typecheck: [1000, 3000, 2000] → count 3, min 1000, max 3000, avg 2000, median 2000, total 6000.
    // lint: [500] → count 1, all 500.
    writeTimingFile('timing-20260614.jsonl', [
      line({ id: 't1', category: 'typecheck', duration_ms: 1000, ts: TS }),
      line({ id: 't2', category: 'typecheck', duration_ms: 3000, ts: TS + 1 }),
      line({ id: 't3', category: 'typecheck', duration_ms: 2000, ts: TS + 2 }),
      line({ id: 'l1', category: 'lint', duration_ms: 500, ts: TS + 3 }),
    ]);
    await ingestTimings();

    const o = await getTimingOverview();
    const tc = o.stats.find((s) => s.category === 'typecheck');
    expect(tc).toBeDefined();
    expect(tc?.count).toBe(3);
    expect(tc?.minMs).toBe(1000);
    expect(tc?.maxMs).toBe(3000);
    expect(tc?.avgMs).toBe(2000);
    expect(tc?.medianMs).toBe(2000);
    expect(tc?.totalMs).toBe(6000);
    expect(tc?.group).toBe('verify'); // taxonomy: typecheck ∈ verify
    expect(tc?.label).toBe('Typecheck');

    const lint = o.stats.find((s) => s.category === 'lint');
    expect(lint?.count).toBe(1);
    expect(lint?.minMs).toBe(500);
    expect(lint?.maxMs).toBe(500);

    // Summary: 4 events, total = 6000 + 500 = 6500; one session → 1 task.
    expect(o.summary.eventCount).toBe(4);
    expect(o.summary.totalMs).toBe(6500);
    expect(o.summary.taskCount).toBe(1);

    // Trend has at least one bucket; its totals reconcile with the summary.
    const trendTotal = o.trend.reduce((s, p) => s + p.totalMs, 0);
    expect(trendTotal).toBe(6500);

    // Rows carry the per-row source file path (for the editor deep link).
    expect(o.rows.length).toBe(4);
    expect(o.rows[0].sourceFile).toContain('timing-20260614.jsonl');
  });

  test('kind:task summary rows are excluded from per-category stats and work totals', async () => {
    insertTimingEvents(
      [
        // a real run
        {
          schema: 'orchlog/v1',
          event_id: 'r1',
          session: 'S',
          worker: 'W1',
          task_id: 'demo',
          task_title: 'T',
          repo: 'rubato',
          category: 'implementation',
          group: 'cognitive',
          kind: 'run',
          ok: true,
          start: '',
          end: '',
          duration_ms: 1000,
          ts: TS,
        },
        // a task-total summary row — should be ignored by the aggregators
        {
          schema: 'orchlog/v1',
          event_id: 'task1',
          session: 'S',
          worker: 'W1',
          task_id: 'demo',
          task_title: 'T',
          repo: 'rubato',
          category: 'task-admin',
          group: 'meta',
          kind: 'task',
          ok: true,
          start: '',
          end: '',
          duration_ms: 999999,
          ts: TS + 1,
        },
      ],
      '/tmp/seed.jsonl',
    );

    const o = await getTimingOverview();
    // The huge task-row duration must NOT show up in totals.
    expect(o.summary.totalMs).toBe(1000);
    expect(o.stats.some((s) => s.category === 'task-admin')).toBe(false);
    // But it still counts toward distinct tasks.
    expect(o.summary.taskCount).toBe(1);
  });

  test('repo filter narrows the rows', async () => {
    writeTimingFile('timing-20260614.jsonl', [
      line({ id: 'r1', repo: 'rubato', category: 'lint', duration_ms: 100, ts: TS }),
      line({ id: 'c1', repo: 'cursedalchemy', category: 'lint', duration_ms: 200, ts: TS + 1 }),
    ]);
    await ingestTimings();

    expect((await getTimingOverview()).total).toBe(2);
    expect((await getTimingOverview({ repo: 'rubato' })).total).toBe(1);
    expect((await getTimingOverview({ repo: 'all' })).total).toBe(2);
    const repos = (await getTimingOverview()).repos;
    expect(repos.sort()).toEqual(['cursedalchemy', 'rubato']);
  });
});

describe('clear', () => {
  test('clear-all empties the store; clear-before removes only older rows', async () => {
    writeTimingFile('timing-20260614.jsonl', [
      line({ id: 'old', category: 'lint', duration_ms: 100, ts: TS }),
      line({ id: 'new', category: 'lint', duration_ms: 100, ts: TS + 60_000 }),
    ]);
    await ingestTimings();
    expect((await getTimingOverview()).total).toBe(2);

    // Clear everything strictly before the new row's ts → only 'old' removed.
    const before = clearStoredTimings(TS + 60_000);
    expect(before.deleted).toBe(1);
    expect((await getTimingOverview()).total).toBe(1);

    // Clear all.
    const all = clearStoredTimings();
    expect(all.deleted).toBe(1);
    expect((await getTimingOverview()).total).toBe(0);
  });
});
