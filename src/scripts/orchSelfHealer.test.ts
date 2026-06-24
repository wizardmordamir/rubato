/**
 * Unit tests for the orch-self-healer.
 * All deps injected — no real filesystem, DB, launchctl, or network.
 */

import { describe, expect, test } from 'bun:test';
import type { SelfHealerDeps } from './orchSelfHealer';
import { runSelfHealer } from './orchSelfHealer';

const HOME = '/fake/home';
const DB = `${HOME}/.taskq/taskq.sqlite`;

// Minimal happy-path deps (everything clean)
function cleanDeps(overrides: Partial<SelfHealerDeps> = {}): SelfHealerDeps {
  return {
    home: () => HOME,
    now: () => 1_700_000_000_000,
    launchctlLoaded: () => true,
    launchctlLoad: () => 0,
    launchctlKickstart: () => 0,
    mtimeMs: () => 1_700_000_000_000 - 60_000, // 1 min ago (fresh)
    isSymlink: () => true,
    // Return false for the UI kill-switch so it doesn't suppress the UI check by default.
    fileExists: (path) => !path.endsWith('.rubato-dev.disabled'),
    gitStatusPorcelain: () => [], // clean
    gitCurrentBranch: () => 'main',
    gitCommitAll: () => true,
    httpGet: async (url) => (url.includes('/api/taskq') ? '{"tasks":[]}' : '<div id="root">'),
    sqliteQuery: (_, sql) => {
      if (sql.includes('recur_interval_ms')) return [{ recur_interval_ms: 1_800_000 }];
      return [];
    },
    sqliteExec: () => {},
    sh: () => 0,
    appendLog: () => {},
    writeFile: () => {},
    gitDiff: () => '',
    buildCwip: () => 0,
    relink: () => 0,
    ...overrides,
  };
}

describe('runSelfHealer — clean system', () => {
  test('returns all ✓ lines on a healthy system', async () => {
    const result = await runSelfHealer(cleanDeps(), DB);
    expect(result.fixCount).toBe(0);
    const kinds = result.lines.map((l) => l.kind);
    expect(kinds.every((k) => k === '✓' || k === 'INFO')).toBe(true);
  });

  test('backs off interval when clean', async () => {
    const result = await runSelfHealer(cleanDeps(), DB);
    // 1_800_000 * 2 = 3_600_000 (ceiling is 10_800_000)
    expect(result.nextIntervalMs).toBe(3_600_000);
  });
});

describe('runSelfHealer — watchdogs', () => {
  test('reloads drain-guard when not loaded', async () => {
    const loaded = new Set(['com.taskq.drain']);
    const result = await runSelfHealer(
      cleanDeps({
        launchctlLoaded: (label) => loaded.has(label),
        launchctlLoad: () => 0,
      }),
      DB,
    );
    // At least 1 fix: the drain-guard reload (guard backup may also run since guard remains unloaded)
    expect(result.fixCount).toBeGreaterThanOrEqual(1);
    expect(result.lines.some((l) => l.kind === 'FIXED' && l.msg.includes('drain-guard plist reloaded'))).toBe(true);
  });

  test('kickstarts guard when log is stale', async () => {
    const NOW = 1_700_000_000_000;
    const kickstarted: string[] = [];
    const result = await runSelfHealer(
      cleanDeps({
        now: () => NOW,
        mtimeMs: () => NOW - 15 * 60_000, // 15 min ago
        launchctlKickstart: (target) => {
          kickstarted.push(target);
          return 0;
        },
      }),
      DB,
    );
    expect(result.fixCount).toBe(1);
    expect(kickstarted.some((t) => t.includes('drain-guard'))).toBe(true);
  });

  test('reloads drain when not loaded', async () => {
    const drainPlist = `${HOME}/Library/LaunchAgents/com.taskq.drain.plist`;
    const loaded = new Set(['com.taskq.drain-guard']);
    const result = await runSelfHealer(
      cleanDeps({
        launchctlLoaded: (label) => loaded.has(label),
        fileExists: (path) => path === drainPlist || path.endsWith('taskq.sqlite') || path.endsWith('.disabled'),
        launchctlLoad: () => 0,
      }),
      DB,
    );
    expect(result.fixCount).toBe(1);
    expect(result.lines.some((l) => l.msg.includes('drain plist reloaded'))).toBe(true);
  });
});

describe('runSelfHealer — UI check', () => {
  test('files heal task when /api/taskq returns no tasks key', async () => {
    const inserted: string[] = [];
    const result = await runSelfHealer(
      cleanDeps({
        httpGet: async (url) => (url.includes('/api/taskq') ? '{"other":"data"}' : '<html></html>'),
        sqliteQuery: (_, sql) => {
          if (sql.includes('recur_interval_ms')) return [{ recur_interval_ms: 1_800_000 }];
          if (sql.includes('count(*)')) return [{ c: 0 }]; // no existing heal task
          return [];
        },
        sqliteExec: (_, sql) => {
          if (sql.startsWith('INSERT')) inserted.push(sql);
        },
      }),
      DB,
    );
    expect(inserted.some((s) => s.includes('heal-taskq-ui'))).toBe(true);
    expect(result.fixCount).toBe(1);
  });

  test('skips UI check when kill-switch file exists', async () => {
    let httpCalled = false;
    const result = await runSelfHealer(
      cleanDeps({
        fileExists: (path) => path.endsWith('.rubato-dev.disabled') || path.endsWith('taskq.sqlite'),
        httpGet: async () => {
          httpCalled = true;
          return null;
        },
      }),
      DB,
    );
    expect(httpCalled).toBe(false);
    expect(result.lines.some((l) => l.msg.includes('kill-switch'))).toBe(true);
  });
});

describe('runSelfHealer — primary hygiene', () => {
  test('commits dirty primary and reports fix', async () => {
    let committed = false;
    const result = await runSelfHealer(
      cleanDeps({
        gitStatusPorcelain: (dir) => (dir.includes('rubato') ? [' M src/changed.ts'] : []),
        gitCurrentBranch: () => 'main',
        gitCommitAll: () => {
          committed = true;
          return true;
        },
      }),
      DB,
    );
    expect(committed).toBe(true);
    expect(result.fixCount).toBeGreaterThan(0);
    expect(result.lines.some((l) => l.kind === 'FIXED' && l.msg.includes('rubato'))).toBe(true);
  });

  test('ignores untracked-only changes (??)', async () => {
    const result = await runSelfHealer(
      cleanDeps({
        gitStatusPorcelain: (dir) => (dir.includes('rubato') ? ['?? scratch.ts'] : []),
      }),
      DB,
    );
    expect(result.fixCount).toBe(0);
    expect(result.lines.some((l) => l.kind === 'FIXED' && l.msg.includes('rubato'))).toBe(false);
  });

  test('warns (not fixes) when primary is on unexpected branch', async () => {
    const result = await runSelfHealer(
      cleanDeps({
        gitStatusPorcelain: (dir) => (dir.includes('rubato') ? [' M src/changed.ts'] : []),
        gitCurrentBranch: () => 'feat/something',
      }),
      DB,
    );
    expect(result.fixCount).toBe(0);
    expect(result.lines.some((l) => l.kind === 'WARN' && l.msg.includes('feat/something'))).toBe(true);
  });
});

describe('runSelfHealer — owner-gate', () => {
  test('clears needs_owner tasks', async () => {
    let cleared = false;
    const result = await runSelfHealer(
      cleanDeps({
        sqliteQuery: (_, sql) => {
          if (sql.includes('recur_interval_ms')) return [{ recur_interval_ms: 1_800_000 }];
          if (sql.includes("hold_disposition='needs_owner'")) return [{ id: 42, slug: 'blocked-task' }];
          return [];
        },
        sqliteExec: (_, sql) => {
          if (sql.includes('hold_disposition=NULL')) cleared = true;
        },
      }),
      DB,
    );
    expect(cleared).toBe(true);
    expect(result.fixCount).toBe(1);
  });
});

describe('runSelfHealer — false-done / queue', () => {
  test('files reattempt for a suspicious no-op completion', async () => {
    const inserted: string[] = [];
    const result = await runSelfHealer(
      cleanDeps({
        sqliteQuery: (_, sql) => {
          if (sql.includes('recur_interval_ms')) return [{ recur_interval_ms: 1_800_000 }];
          if (sql.includes('nothing to do'))
            return [{ id: 7, slug: 'noop-task', title: 'Noop Thing', note: 'nothing to do here' }];
          if (sql.includes('reattempt-')) return [{ c: 0 }]; // not yet filed
          if (sql.includes('GROUP BY status')) return [{ status: 'done', c: 10 }];
          return [];
        },
        sqliteExec: (_, sql) => {
          if (sql.startsWith('INSERT')) inserted.push(sql);
        },
      }),
      DB,
    );
    expect(inserted.some((s) => s.includes('reattempt-noop-task'))).toBe(true);
    expect(result.fixCount).toBe(1);
  });
});

describe('runSelfHealer — guard backup', () => {
  test('runs backup checks when drain-guard is down', async () => {
    const builtCwip: string[] = [];
    const cwipDist = `${HOME}/code/github/cwip/dist/services/taskq/index.js`;
    const result = await runSelfHealer(
      cleanDeps({
        launchctlLoaded: () => false, // guard is down
        fileExists: (path) => path !== cwipDist && (path.endsWith('taskq.sqlite') || path.endsWith('.plist')),
        buildCwip: (dir) => {
          builtCwip.push(dir);
          return 0;
        },
      }),
      DB,
    );
    expect(builtCwip.length).toBeGreaterThan(0);
    expect(result.lines.some((l) => l.msg.includes('guard DOWN'))).toBe(true);
  });
});

describe('runSelfHealer — adaptive interval', () => {
  test('halves interval (floor 30min) when fixes were made', async () => {
    const updates: number[] = [];
    const result = await runSelfHealer(
      cleanDeps({
        sqliteQuery: (_, sql) => {
          if (sql.includes('recur_interval_ms')) return [{ recur_interval_ms: 3_600_000 }]; // 60 min
          if (sql.includes("hold_disposition='needs_owner'")) return [{ id: 1, slug: 'blocked' }];
          return [];
        },
        sqliteExec: (_, sql) => {
          const m = sql.match(/recur_interval_ms=(\d+)/);
          if (m) updates.push(Number(m[1]));
        },
      }),
      DB,
    );
    // 3_600_000 / 2 = 1_800_000 (floor is 1_800_000)
    expect(result.nextIntervalMs).toBe(1_800_000);
    expect(updates).toContain(1_800_000);
  });

  test('doubles interval (ceiling 3h) when clean', async () => {
    const updates: number[] = [];
    const result = await runSelfHealer(
      cleanDeps({
        sqliteQuery: (_, sql) => {
          if (sql.includes('recur_interval_ms')) return [{ recur_interval_ms: 1_800_000 }]; // 30 min
          return [];
        },
        sqliteExec: (_, sql) => {
          const m = sql.match(/recur_interval_ms=(\d+)/);
          if (m) updates.push(Number(m[1]));
        },
      }),
      DB,
    );
    // 1_800_000 * 2 = 3_600_000
    expect(result.nextIntervalMs).toBe(3_600_000);
    expect(updates).toContain(3_600_000);
  });
});
