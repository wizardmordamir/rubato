import { describe, expect, test } from 'bun:test';
import {
  aggregateStats,
  bucketTimingTrend,
  emptyTaskBoard,
  formatDuration,
  formatTokens,
  formatUsd,
  parseDurationSeconds,
  parseHistory,
  parseRunsJsonl,
  parseTaskBoard,
  runEntryFromJson,
  summarizeRunEntries,
} from './index';

// ── Realistic fixtures (mirroring the real control files) ─────────────────────

const SAMPLE_TASKS = `# TASKS — the single live board

## Status tags
- \`[ ]\` ready — free to claim and start

## Protocol (also encoded in /next-task)
1. Claim FIRST, race-safe.

---
--- ready tasks (\`[ ]\`) below this line ---

## [ ] rubato — add a widget gallery
Build the gallery page with previews.

## [~] (worktree: feat/foo · 2026-06-14T18:02:00Z) cursedalchemy — feed should look like Moments
Wire the feed to the Moments layout.

## [x] (2026-06-14T18:02:00Z → 2026-06-14T18:11:00Z · 9m · rubato a1b2c3d) rubato — extract-text primitive
Landed and verified.

## [!] (needs live Jenkins creds) rubato — task 42 per-app selector verification
Needs the real Jenkins DOM.

---
--- not-ready (\`[-]\`) below ---

## [-] cursedalchemy — list layout editor split (LATER)
After the rubato work settles.

---
History lives in Tasks_Completed.md.
`;

const SAMPLE_HISTORY = `# Tasks Completed

This is the place for tasks that have been merged to master/main.

---

## rubato — debug capture (outbound API + DB) — Claude
- Started: 2026-06-13T19:47:28.000Z · Completed: 2026-06-13T20:34:00.000Z · Duration: 46m 32s
- Landed rubato main 0d06956 (worktree off 0a2d380; ff-only). Opt-in facility.

## cwip + rubato — sealToText/openFromText — Claude
- Started: 2026-06-13T19:35:35.000Z · Completed: 2026-06-13T19:47:28.000Z · Duration: 11m 53s
- Landed cwip master 39f3809 + rubato main 0a2d380. The secure transport.

## rubato — library importable without server/UI — Claude
- Started: 2026-06-13T18:49:10.000Z · Completed: 2026-06-13T18:58:26.000Z · Duration: ~9m
- Landed rubato main 8173e86 (merge incl. jenkins-deploy-template).
`;

const SAMPLE_RUNS = `${JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: 'Claimed and completed the widget gallery task.',
  session_id: 'sess-abc-123',
  model: 'claude-opus-4-8',
  total_cost_usd: 1.2345,
  duration_ms: 184_000,
  input_tokens: 1200,
  output_tokens: 3400,
  cache_creation_input_tokens: 500,
  cache_read_input_tokens: 8000,
})}

${JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: 'Second task done.',
  session_id: 'sess-def-456',
  model: 'claude-opus-4-8',
  total_cost_usd: 0.42,
  usage: { input_tokens: 800, output_tokens: 1600 },
})}
{ this is a partially-written final line of a live run
`;

// ── parseTaskBoard ────────────────────────────────────────────────────────────

describe('parseTaskBoard', () => {
  const board = parseTaskBoard(SAMPLE_TASKS);

  test('groups tasks by status and counts them', () => {
    expect(board.counts).toEqual({ ready: 1, claimed: 1, done: 1, blocked: 1, 'not-ready': 1 });
    expect(board.total).toBe(5);
  });

  test('ignores prose / protocol / non-task headings', () => {
    // The "## Status tags" and "## Protocol" headings must NOT become tasks.
    expect(board.tasks.every((t) => !t.title.startsWith('Status tags'))).toBe(true);
    expect(board.tasks.every((t) => !t.title.startsWith('Protocol'))).toBe(true);
  });

  test('strips the status tag + leading parenthetical from the title', () => {
    const ready = board.groups.ready[0];
    expect(ready.title).toBe('rubato — add a widget gallery');
    expect(ready.body).toBe('Build the gallery page with previews.');
  });

  test('parses claimed (worktree + start) metadata', () => {
    const claimed = board.groups.claimed[0];
    expect(claimed.title).toBe('cursedalchemy — feed should look like Moments');
    expect(claimed.meta.worktree).toBe('feat/foo');
    expect(claimed.meta.start).toBe('2026-06-14T18:02:00Z');
  });

  test('parses done (start/end/duration/repo/commit) metadata', () => {
    const done = board.groups.done[0];
    expect(done.title).toBe('rubato — extract-text primitive');
    expect(done.meta.start).toBe('2026-06-14T18:02:00Z');
    expect(done.meta.end).toBe('2026-06-14T18:11:00Z');
    expect(done.meta.duration).toBe('9m');
    expect(done.meta.repo).toBe('rubato');
    expect(done.meta.commit).toBe('a1b2c3d');
  });

  test('parses blocked reason', () => {
    const blocked = board.groups.blocked[0];
    expect(blocked.meta.reason).toBe('needs live Jenkins creds');
    expect(blocked.title).toBe('rubato — task 42 per-app selector verification');
  });

  test('records a 1-based heading line number', () => {
    const ready = board.groups.ready[0];
    expect(SAMPLE_TASKS.split('\n')[ready.line - 1]).toContain('[ ] rubato — add a widget gallery');
  });

  test('empty board for empty input', () => {
    expect(parseTaskBoard('').total).toBe(0);
    expect(emptyTaskBoard().counts.ready).toBe(0);
  });
});

// A re-claimed resume task (or a recurring one) carries MORE than one leading
// metadata group — `(resume: …) (worktree: …)` / `(recur:N) (worktree: …)`. The
// old single-group strip left the `(worktree: …)` marker stuck in the title and
// dropped the start time, which surfaced on the dashboard as an in-progress task
// with a garbled title and "no start/duration". These pin the multi-group fix.
describe('parseTaskBoard — multiple leading metadata groups', () => {
  const board = parseTaskBoard(`# TASKS
---
## [~] (resume: ca-iphone-taps) (worktree: ca-iphone-taps · 2026-06-15T02:26:18Z) ca bug with iphone taps
the task body
## [~] (recur:10) (worktree: cwip-check · 2026-06-15T02:19:14Z) cwip check
`);

  test('strips EVERY leading group from the title', () => {
    expect(board.groups.claimed[0].title).toBe('ca bug with iphone taps');
    expect(board.groups.claimed[1].title).toBe('cwip check');
  });

  test('extracts worktree + start across the groups (not just the first)', () => {
    const t = board.groups.claimed[0];
    expect(t.meta.worktree).toBe('ca-iphone-taps');
    expect(t.meta.start).toBe('2026-06-15T02:26:18Z');
    expect(t.meta.resume).toBe('ca-iphone-taps');
  });

  test('also handles a (recur:N) marker preceding the worktree group', () => {
    const t = board.groups.claimed[1];
    expect(t.meta.worktree).toBe('cwip-check');
    expect(t.meta.start).toBe('2026-06-15T02:19:14Z');
  });
});

// ── parseTaskBoard — per-task model/thinking markers ─────────────────────────

describe('parseTaskBoard — (model:) and (think:) heading markers', () => {
  test('extracts (model:) from a ready task heading', () => {
    const board = parseTaskBoard(`## [ ] (model:sonnet) my task`);
    expect(board.groups.ready[0].meta.model).toBe('sonnet');
    expect(board.groups.ready[0].title).toBe('my task');
  });

  test('extracts (think:) from a ready task heading', () => {
    const board = parseTaskBoard(`## [ ] (think:med) my task`);
    expect(board.groups.ready[0].meta.thinkingLevel).toBe('med');
  });

  test('extracts both (model:) and (think:) from a ready task heading', () => {
    const board = parseTaskBoard(`## [ ] (model:sonnet) (think:high) my task`);
    const t = board.groups.ready[0];
    expect(t.meta.model).toBe('sonnet');
    expect(t.meta.thinkingLevel).toBe('high');
    expect(t.title).toBe('my task');
  });

  test('extracts model/think from a claimed task (drainer preserves them after worktree stamp)', () => {
    const board = parseTaskBoard(
      `## [~] (worktree: _drain-w1 · 2026-06-15T23:00:00Z) (model:haiku) (think:low) my task`,
    );
    const t = board.groups.claimed[0];
    expect(t.meta.model).toBe('haiku');
    expect(t.meta.thinkingLevel).toBe('low');
    expect(t.meta.worktree).toBe('_drain-w1');
    expect(t.title).toBe('my task');
  });

  test('no model/think markers → fields are undefined', () => {
    const board = parseTaskBoard(`## [ ] plain task`);
    expect(board.groups.ready[0].meta.model).toBeUndefined();
    expect(board.groups.ready[0].meta.thinkingLevel).toBeUndefined();
  });
});

// ── parseHistory ──────────────────────────────────────────────────────────────

describe('parseHistory', () => {
  const entries = parseHistory(SAMPLE_HISTORY);

  test('parses each completed-task section', () => {
    expect(entries).toHaveLength(3);
  });

  test('strips the trailing author suffix from the title', () => {
    expect(entries[0].title).toBe('rubato — debug capture (outbound API + DB)');
  });

  test('parses start/end/duration', () => {
    expect(entries[0].start).toBe('2026-06-13T19:47:28.000Z');
    expect(entries[0].end).toBe('2026-06-13T20:34:00.000Z');
    expect(entries[0].durationText).toBe('46m 32s');
    expect(entries[0].durationSeconds).toBe(46 * 60 + 32);
  });

  test('parses repo + commit from the Landed line', () => {
    expect(entries[0].repo).toBe('rubato');
    expect(entries[0].commit).toBe('0d06956');
    // multi-repo Landed line picks the first repo/commit
    expect(entries[1].repo).toBe('cwip');
    expect(entries[1].commit).toBe('39f3809');
  });

  test('handles an approximate (~) duration', () => {
    expect(entries[2].durationText).toBe('~9m');
    expect(entries[2].durationSeconds).toBe(9 * 60);
  });
});

describe('parseDurationSeconds', () => {
  test.each([
    ['46m 32s', 46 * 60 + 32],
    ['9m', 540],
    ['~9m', 540],
    ['1h 5m', 3900],
    ['90s', 90],
    ['8m 14s', 494],
  ])('%s → %d', (text, expected) => {
    expect(parseDurationSeconds(text)).toBe(expected);
  });

  test('undefined for unparseable input', () => {
    expect(parseDurationSeconds('soon')).toBeUndefined();
    expect(parseDurationSeconds(undefined)).toBeUndefined();
  });
});

// ── parseRunsJsonl ────────────────────────────────────────────────────────────

describe('parseRunsJsonl', () => {
  const runs = parseRunsJsonl('run-20260614-150000.jsonl', SAMPLE_RUNS, '2026-06-14T15:05:00.000Z');

  test('skips blank + malformed lines, keeps valid runs', () => {
    expect(runs).toHaveLength(2);
  });

  test('reads tokens/cost/duration/session/model from the top-level shape', () => {
    const r = runs[0];
    expect(r.sessionId).toBe('sess-abc-123');
    expect(r.model).toBe('claude-opus-4-8');
    expect(r.costUsd).toBe(1.2345);
    expect(r.durationMs).toBe(184_000);
    expect(r.inputTokens).toBe(1200);
    expect(r.outputTokens).toBe(3400);
    expect(r.cacheCreationTokens).toBe(500);
    expect(r.cacheReadTokens).toBe(8000);
    expect(r.totalTokens).toBe(1200 + 3400 + 500 + 8000);
    expect(r.file).toBe('run-20260614-150000.jsonl');
    expect(r.at).toBe('2026-06-14T15:05:00.000Z');
    expect(r.isError).toBe(false);
  });

  test('reads tokens from a nested usage object', () => {
    expect(runs[1].inputTokens).toBe(800);
    expect(runs[1].outputTokens).toBe(1600);
    expect(runs[1].totalTokens).toBe(2400);
  });

  test('flags an error run', () => {
    const err = runEntryFromJson('f.jsonl', { is_error: true, subtype: 'error_during_execution' });
    expect(err?.isError).toBe(true);
  });

  test('rejects non-objects', () => {
    expect(runEntryFromJson('f.jsonl', null)).toBeNull();
    expect(runEntryFromJson('f.jsonl', 'string')).toBeNull();
  });
});

// ── summarizeRunEntries ───────────────────────────────────────────────────────

describe('summarizeRunEntries', () => {
  const runs = parseRunsJsonl('run.jsonl', SAMPLE_RUNS);

  test('rolls up count, average duration, errors, and cost', () => {
    const s = summarizeRunEntries(runs);
    expect(s.count).toBe(2);
    // Only the first entry reports a duration, so the average is just its value.
    expect(s.avgDurationMs).toBe(184_000);
    // The LAST entry has no duration → lastDurationMs is omitted.
    expect(s.lastDurationMs).toBeUndefined();
    expect(s.lastTaskErrored).toBe(false);
    expect(s.errorCount).toBe(0);
    expect(s.totalCostUsd).toBeCloseTo(1.2345 + 0.42, 6);
  });

  test('takes last/error state from the final entry and counts every error', () => {
    const entries = [
      runEntryFromJson('f.jsonl', { duration_ms: 100, total_cost_usd: 0.1 }),
      runEntryFromJson('f.jsonl', { is_error: true, subtype: 'error', duration_ms: 300 }),
    ].filter((e): e is NonNullable<typeof e> => e !== null);
    const s = summarizeRunEntries(entries);
    expect(s.count).toBe(2);
    expect(s.lastDurationMs).toBe(300); // last entry's duration
    expect(s.avgDurationMs).toBe(200); // (100 + 300) / 2
    expect(s.lastTaskErrored).toBe(true);
    expect(s.errorCount).toBe(1);
    expect(s.totalCostUsd).toBeCloseTo(0.1, 6);
  });

  test('empty input yields a zeroed, field-omitting summary', () => {
    const s = summarizeRunEntries([]);
    expect(s.count).toBe(0);
    expect(s.avgDurationMs).toBeUndefined();
    expect(s.lastDurationMs).toBeUndefined();
    expect(s.totalCostUsd).toBeUndefined();
    expect(s.lastTaskErrored).toBe(false);
    expect(s.errorCount).toBe(0);
  });
});

// ── aggregateStats ────────────────────────────────────────────────────────────

describe('aggregateStats', () => {
  const history = parseHistory(SAMPLE_HISTORY);
  const runs = parseRunsJsonl('run.jsonl', SAMPLE_RUNS);
  const stats = aggregateStats(history, runs);

  test('totals tasks, duration, and average', () => {
    expect(stats.totalTasks).toBe(3);
    const expectedTotal = 46 * 60 + 32 + (11 * 60 + 53) + 9 * 60;
    expect(stats.totalDurationSeconds).toBe(expectedTotal);
    expect(stats.avgDurationSeconds).toBe(Math.round(expectedTotal / 3));
  });

  test('totals tokens + cost across runs', () => {
    expect(stats.totalRuns).toBe(2);
    expect(stats.totalTokens).toBe(1200 + 3400 + 500 + 8000 + 800 + 1600);
    expect(stats.totalCostUsd).toBeCloseTo(1.2345 + 0.42, 6);
  });

  test('per-repo breakdown, sorted by task count', () => {
    const repos = stats.byRepo.map((r) => r.repo);
    expect(repos).toContain('rubato');
    expect(repos).toContain('cwip');
    // rubato has 2 history entries, cwip 1 → rubato first.
    expect(stats.byRepo[0].repo).toBe('rubato');
    expect(stats.byRepo[0].tasks).toBe(2);
  });

  test('average ignores entries without a duration', () => {
    const partial = aggregateStats(
      [
        { title: 'a', durationSeconds: 60, line: 1 },
        { title: 'b', line: 2 }, // no duration
      ],
      [],
    );
    expect(partial.totalTasks).toBe(2);
    expect(partial.avgDurationSeconds).toBe(60); // only the one with a duration
  });
});

// ── formatters ────────────────────────────────────────────────────────────────

describe('formatters', () => {
  test('formatDuration', () => {
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(3661)).toBe('1h 1m');
    expect(formatDuration(45)).toBe('45s');
  });

  test('formatTokens', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1200)).toBe('1.2k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });

  test('formatUsd', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(12.3)).toBe('$12.30');
  });
});

describe('bucketTimingTrend', () => {
  test('empty input → no buckets', () => {
    expect(bucketTimingTrend([])).toEqual([]);
  });

  test('a single timestamp → one bucket summing its duration', () => {
    const out = bucketTimingTrend([
      { ts: 1000, durationMs: 100 },
      { ts: 1000, durationMs: 50 },
    ]);
    expect(out).toEqual([{ ts: 1000, totalMs: 150, count: 2 }]);
  });

  test('events spread over a span are bucketed chronologically and conserve totals', () => {
    const base = 1_000_000;
    const items = [
      { ts: base, durationMs: 100 },
      { ts: base + 10_000, durationMs: 200 },
      { ts: base + 20_000, durationMs: 300 },
      { ts: base + 30_000, durationMs: 400 },
    ];
    const out = bucketTimingTrend(items, 2); // few buckets → group them up
    // Chronological.
    for (let i = 1; i < out.length; i++) expect(out[i].ts).toBeGreaterThan(out[i - 1].ts);
    // No duration lost or invented.
    expect(out.reduce((s, p) => s + p.totalMs, 0)).toBe(1000);
    expect(out.reduce((s, p) => s + p.count, 0)).toBe(4);
  });

  test('non-finite / non-positive timestamps are dropped', () => {
    const out = bucketTimingTrend([
      { ts: 0, durationMs: 10 },
      { ts: Number.NaN, durationMs: 10 },
      { ts: 5000, durationMs: 20 },
    ]);
    expect(out).toEqual([{ ts: 5000, totalMs: 20, count: 1 }]);
  });
});
