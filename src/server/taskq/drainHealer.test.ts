/**
 * Unit tests for the drain self-healer (`drainHealer.ts`).
 *
 * All deps are injected — no real filesystem, DB, or process spawning. Each test
 * drives a specific stall scenario and verifies the healer detects + fixes it.
 */

import { describe, expect, mock, test } from 'bun:test';
import type { HealerDeps } from './drainHealer';
import { runHealer } from './drainHealer';

const NOW_MS = 1_000_000_000_000; // a fixed "now" for deterministic tests

function makeDeps(overrides: Partial<HealerDeps> = {}): HealerDeps {
  return {
    now: () => NOW_MS,
    isSymlink: () => true,
    fileExists: () => true,
    mtimeMs: () => NOW_MS - 1_000, // 1s ago → fresh
    reapLeases: () => ({ reaped: 0 }),
    buildCwip: () => ({ code: 0, out: 'build ok' }),
    relink: () => ({ code: 0, out: 'relink ok' }),
    kickDrain: () => ({ code: 0, out: 'kicked' }),
    freshHeartbeatCount: () => 0,
    leaseCount: () => 0,
    clearNeedsOwner: () => ({ cleared: 0 }),
    checkPrimaryHygiene: () => [],
    checkBudget: () => [],
    ...overrides,
  };
}

describe('healthy environment', () => {
  test('returns no issues when everything is fine', () => {
    const result = runHealer(makeDeps());
    expect(result.issuesFound).toBe(0);
    expect(result.issuesFixed).toBe(0);
    expect(result.issues).toHaveLength(0);
    expect(result.inconclusive).toBe(false);
    expect(result.ranAt).toBeTruthy();
  });
});

describe('cwip dist missing', () => {
  test('detects missing cwip dist and rebuilds', () => {
    const buildCwip = mock(() => ({ code: 0, out: 'build ok' }));
    const result = runHealer(makeDeps({ fileExists: () => false, buildCwip }));

    const issue = result.issues.find((i) => i.code === 'cwip-dist-missing');
    expect(issue).toBeDefined();
    expect(issue!.fixed).toBe(true);
    expect(buildCwip).toHaveBeenCalledTimes(1);
    expect(result.issuesFixed).toBe(1);
  });

  test('records build failure as unfixed', () => {
    const result = runHealer(
      makeDeps({
        fileExists: () => false,
        buildCwip: () => ({ code: 1, out: 'error: build failed' }),
      }),
    );

    const issue = result.issues.find((i) => i.code === 'cwip-dist-missing');
    expect(issue).toBeDefined();
    expect(issue!.fixed).toBe(false);
    expect(issue!.detail).toContain('error: build failed');
    expect(result.issuesFixed).toBe(0);
  });
});

describe('symlink broken', () => {
  test('detects non-symlink cwip and relinks', () => {
    const relink = mock(() => ({ code: 0, out: 'relink ok' }));
    const result = runHealer(makeDeps({ isSymlink: () => false, relink }));

    const issue = result.issues.find((i) => i.code === 'symlink-broken');
    expect(issue).toBeDefined();
    expect(issue!.fixed).toBe(true);
    expect(relink).toHaveBeenCalledTimes(1);
  });

  test('records relink failure', () => {
    const result = runHealer(
      makeDeps({
        isSymlink: () => false,
        relink: () => ({ code: 1, out: 'relink failed' }),
      }),
    );

    const issue = result.issues.find((i) => i.code === 'symlink-broken');
    expect(issue!.fixed).toBe(false);
    expect(issue!.detail).toContain('relink failed');
  });
});

describe('drain stall', () => {
  // 6 min stale, no leases → should restart
  test('restarts stalled drain when output is stale and no fresh heartbeats', () => {
    const kickDrain = mock(() => ({ code: 0, out: 'kicked' }));
    const result = runHealer(
      makeDeps({
        mtimeMs: () => NOW_MS - 6 * 60_000, // 6 min stale
        freshHeartbeatCount: () => 0,
        leaseCount: () => 1, // has leases but none fresh
        kickDrain,
      }),
    );

    const issue = result.issues.find((i) => i.code === 'drain-stalled');
    expect(issue).toBeDefined();
    expect(issue!.fixed).toBe(true);
    expect(kickDrain).toHaveBeenCalledTimes(1);
  });

  test('does NOT restart when workers have fresh heartbeats', () => {
    const kickDrain = mock(() => ({ code: 0, out: 'kicked' }));
    const result = runHealer(
      makeDeps({
        mtimeMs: () => NOW_MS - 10 * 60_000, // stale
        freshHeartbeatCount: () => 2, // workers alive
        kickDrain,
      }),
    );

    expect(result.issues.find((i) => i.code === 'drain-stalled')).toBeUndefined();
    expect(kickDrain).not.toHaveBeenCalled();
  });

  test('does NOT restart when output is fresh', () => {
    const kickDrain = mock(() => ({ code: 0, out: 'kicked' }));
    const result = runHealer(
      makeDeps({
        mtimeMs: () => NOW_MS - 30_000, // 30s ago → fresh
        kickDrain,
      }),
    );

    expect(result.issues.find((i) => i.code === 'drain-stalled')).toBeUndefined();
    expect(kickDrain).not.toHaveBeenCalled();
  });

  test('does NOT restart when no watchdog.out exists (drain never ran)', () => {
    const kickDrain = mock(() => ({ code: 0, out: 'kicked' }));
    const result = runHealer(
      makeDeps({
        mtimeMs: () => undefined, // file absent
        kickDrain,
      }),
    );

    expect(result.issues.find((i) => i.code === 'drain-stalled')).toBeUndefined();
    expect(kickDrain).not.toHaveBeenCalled();
  });

  test('restarts after 16 min even with no leases (very stale)', () => {
    const kickDrain = mock(() => ({ code: 0, out: 'kicked' }));
    const result = runHealer(
      makeDeps({
        mtimeMs: () => NOW_MS - 16 * 60_000,
        freshHeartbeatCount: () => 0,
        leaseCount: () => 0, // no leases
        kickDrain,
      }),
    );

    expect(result.issues.find((i) => i.code === 'drain-stalled')).toBeDefined();
    expect(kickDrain).toHaveBeenCalledTimes(1);
  });

  test('records kick failure', () => {
    const result = runHealer(
      makeDeps({
        mtimeMs: () => NOW_MS - 6 * 60_000,
        freshHeartbeatCount: () => 0,
        leaseCount: () => 1,
        kickDrain: () => ({ code: 1, out: 'no such job' }),
      }),
    );

    const issue = result.issues.find((i) => i.code === 'drain-stalled');
    expect(issue!.fixed).toBe(false);
    expect(issue!.detail).toContain('no such job');
  });
});

describe('expired leases', () => {
  test('reaps expired leases and reports them as fixed', () => {
    const result = runHealer(makeDeps({ reapLeases: () => ({ reaped: 3 }) }));

    const issue = result.issues.find((i) => i.code === 'leases-expired');
    expect(issue).toBeDefined();
    expect(issue!.fixed).toBe(true);
    expect(issue!.description).toContain('3 lease');
  });

  test('does not report an issue when no leases are expired', () => {
    const result = runHealer(makeDeps({ reapLeases: () => ({ reaped: 0 }) }));
    expect(result.issues.find((i) => i.code === 'leases-expired')).toBeUndefined();
  });

  test('marks inconclusive when DB is unavailable', () => {
    const result = runHealer(makeDeps({ reapLeases: () => 'unavailable' }));
    // DB unavailable → no lease issue (not an issue, just skipped)
    expect(result.issues.find((i) => i.code === 'leases-expired')).toBeUndefined();
    expect(result.inconclusive).toBe(false); // 'unavailable' is expected, not an error
  });
});

describe('owner-gate sweep', () => {
  test('reports cleared needs_owner tasks as fixed', () => {
    const clearNeedsOwner = mock(() => ({ cleared: 2 }));
    const result = runHealer(makeDeps({ clearNeedsOwner }));

    const issue = result.issues.find((i) => i.code === 'needs-owner-cleared');
    expect(issue).toBeDefined();
    expect(issue!.fixed).toBe(true);
    expect(issue!.description).toContain('2 task');
    expect(clearNeedsOwner).toHaveBeenCalledTimes(1);
    expect(result.issuesFixed).toBe(1);
  });

  test('does not report an issue when no tasks have needs_owner hold', () => {
    const result = runHealer(makeDeps({ clearNeedsOwner: () => ({ cleared: 0 }) }));
    expect(result.issues.find((i) => i.code === 'needs-owner-cleared')).toBeUndefined();
    expect(result.issuesFound).toBe(0);
  });

  test('silently skips when DB is unavailable (same pattern as reapLeases)', () => {
    const result = runHealer(makeDeps({ clearNeedsOwner: () => 'unavailable' }));
    // 'unavailable' is an expected skip, not an error — no inconclusive flag, no issue
    expect(result.issues.find((i) => i.code === 'needs-owner-cleared')).toBeUndefined();
    expect(result.inconclusive).toBe(false);
  });
});

describe('primary checkout hygiene', () => {
  test('reports dirty primaries as unfixed issues', () => {
    const result = runHealer(
      makeDeps({
        checkPrimaryHygiene: () => [
          { dir: '/home/user/code/github/cursedbelt', dirtyFiles: ['package.json', 'src/foo.ts'] },
        ],
      }),
    );

    const issue = result.issues.find((i) => i.code === 'primary-dirty');
    expect(issue).toBeDefined();
    expect(issue!.fixed).toBe(false); // auto-fix intentionally omitted
    expect(issue!.description).toContain('cursedbelt');
    expect(issue!.description).toContain('2 uncommitted');
    expect(issue!.detail).toContain('package.json');
    expect(result.issuesFound).toBe(1);
    expect(result.issuesFixed).toBe(0);
  });

  test('reports one issue per dirty repo', () => {
    const result = runHealer(
      makeDeps({
        checkPrimaryHygiene: () => [
          { dir: '/code/rubato', dirtyFiles: ['a.ts'] },
          { dir: '/code/cwip', dirtyFiles: ['b.ts', 'c.ts'] },
        ],
      }),
    );

    const dirtyIssues = result.issues.filter((i) => i.code === 'primary-dirty');
    expect(dirtyIssues).toHaveLength(2);
    expect(result.issuesFound).toBe(2);
    expect(result.issuesFixed).toBe(0);
  });

  test('does not report an issue when all primaries are clean', () => {
    const result = runHealer(makeDeps({ checkPrimaryHygiene: () => [] }));
    expect(result.issues.find((i) => i.code === 'primary-dirty')).toBeUndefined();
  });

  test('marks inconclusive when the hygiene check throws', () => {
    const result = runHealer(
      makeDeps({
        checkPrimaryHygiene: () => {
          throw new Error('git not found');
        },
      }),
    );

    expect(result.inconclusive).toBe(true);
    const issue = result.issues.find((i) => i.code === 'primary-dirty');
    expect(issue).toBeDefined();
    expect(issue!.description).toContain('inconclusive');
  });
});

describe('multiple issues', () => {
  test('detects and fixes multiple simultaneous stalls', () => {
    const result = runHealer(
      makeDeps({
        fileExists: () => false, // cwip dist missing
        isSymlink: () => false, // symlink broken
        reapLeases: () => ({ reaped: 2 }), // expired leases
      }),
    );

    expect(result.issuesFound).toBe(3);
    expect(result.issuesFixed).toBe(3);
    expect(result.issues.map((i) => i.code)).toContain('cwip-dist-missing');
    expect(result.issues.map((i) => i.code)).toContain('symlink-broken');
    expect(result.issues.map((i) => i.code)).toContain('leases-expired');
  });
});

describe('inconclusive checks', () => {
  test('marks inconclusive when a check throws', () => {
    const result = runHealer(
      makeDeps({
        fileExists: () => {
          throw new Error('disk error');
        },
      }),
    );

    expect(result.inconclusive).toBe(true);
    const issue = result.issues.find((i) => i.code === 'cwip-dist-missing');
    expect(issue).toBeDefined();
    expect(issue!.description).toContain('inconclusive');
  });
});

describe('budget exhaustion', () => {
  test('reports depleted budget buckets as unfixed issues', () => {
    const result = runHealer(
      makeDeps({
        checkBudget: () => [{ key: 'session_5h', limitUnits: 0, resetAt: NOW_MS + 60 * 60_000 }],
      }),
    );

    const issue = result.issues.find((i) => i.code === 'budget-depleted');
    expect(issue).toBeDefined();
    expect(issue!.fixed).toBe(false); // auto-reset is not possible
    expect(issue!.description).toContain('session_5h');
    expect(issue!.description).toContain('drain may throttle');
    expect(result.issuesFixed).toBe(0);
  });

  test('includes reset-in time when resetAt is in the future', () => {
    const resetAt = NOW_MS + 90 * 60_000; // 90 minutes from now
    const result = runHealer(
      makeDeps({
        checkBudget: () => [{ key: 'weekly_sonnet', limitUnits: 5e-10, resetAt }],
      }),
    );

    const issue = result.issues.find((i) => i.code === 'budget-depleted');
    expect(issue).toBeDefined();
    expect(issue!.description).toContain('resets in');
    expect(issue!.description).toContain('m');
  });

  test('says "reset overdue" when resetAt is in the past', () => {
    const resetAt = NOW_MS - 10 * 60_000; // 10 minutes ago
    const result = runHealer(
      makeDeps({
        checkBudget: () => [{ key: 'session_5h', limitUnits: 0.001, resetAt }],
      }),
    );

    const issue = result.issues.find((i) => i.code === 'budget-depleted');
    expect(issue).toBeDefined();
    expect(issue!.description).toContain('reset overdue');
  });

  test('no issue when all budgets are healthy', () => {
    const result = runHealer(makeDeps({ checkBudget: () => [] }));
    expect(result.issues.find((i) => i.code === 'budget-depleted')).toBeUndefined();
    expect(result.issuesFound).toBe(0);
  });

  test('silently skips when DB is unavailable', () => {
    const result = runHealer(makeDeps({ checkBudget: () => 'unavailable' }));
    expect(result.issues.find((i) => i.code === 'budget-depleted')).toBeUndefined();
    expect(result.inconclusive).toBe(false);
  });

  test('marks inconclusive when check throws', () => {
    const result = runHealer(
      makeDeps({
        checkBudget: () => {
          throw new Error('db error');
        },
      }),
    );

    expect(result.inconclusive).toBe(true);
    const issue = result.issues.find((i) => i.code === 'budget-depleted');
    expect(issue).toBeDefined();
    expect(issue!.description).toContain('inconclusive');
  });

  test('reports one issue per depleted key', () => {
    const result = runHealer(
      makeDeps({
        checkBudget: () => [
          { key: 'session_5h', limitUnits: 0, resetAt: NOW_MS + 30 * 60_000 },
          { key: 'weekly_sonnet', limitUnits: 0.5, resetAt: NOW_MS + 3 * 24 * 60 * 60_000 },
        ],
      }),
    );

    const depleted = result.issues.filter((i) => i.code === 'budget-depleted');
    expect(depleted).toHaveLength(2);
    expect(depleted.map((i) => i.description).some((d) => d.includes('session_5h'))).toBe(true);
    expect(depleted.map((i) => i.description).some((d) => d.includes('weekly_sonnet'))).toBe(true);
  });
});

describe('result shape', () => {
  test('ranAt is an ISO timestamp', () => {
    const result = runHealer(makeDeps());
    expect(() => new Date(result.ranAt)).not.toThrow();
    expect(new Date(result.ranAt).getTime()).toBe(NOW_MS);
  });

  test('issuesFound matches issues.length', () => {
    const result = runHealer(makeDeps({ fileExists: () => false }));
    expect(result.issuesFound).toBe(result.issues.length);
  });

  test('issuesFixed is a subset of issuesFound', () => {
    const result = runHealer(makeDeps({ fileExists: () => false }));
    expect(result.issuesFixed).toBeLessThanOrEqual(result.issuesFound);
  });
});
