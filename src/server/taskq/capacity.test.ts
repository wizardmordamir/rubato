import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { calibrateBucket, migrate, type TaskqDb } from 'cwip/taskq';
import { capacitySnapshot } from './capacity';
import type { TaskqConfig } from './config';
import { validateConfigPatch } from './config';

function fresh(): TaskqDb {
  const d = new Database(':memory:') as unknown as TaskqDb;
  d.exec('PRAGMA foreign_keys = ON');
  migrate(d);
  return d;
}

/** A full TaskqConfig with overridable knobs (no disk read). */
function cfg(overrides: Partial<TaskqConfig> = {}): TaskqConfig {
  return {
    jobs: 4,
    model: 'opus',
    throttle: false,
    leaseTtlMs: 15 * 60_000,
    taskTimeoutMs: 2 * 60 * 60_000,
    maxAttempts: 3,
    retryBackoff: { baseMs: 60_000, capMs: 1_200_000, factor: 5, jitter: 0.2 },
    repos: {},
    falseDoneBuildCheck: true,
    usagePollMinutes: 5,
    usageCostPollMinutes: 30,
    ...overrides,
  };
}

/** Drive a token bucket to fully consumed (fraction 0) within its rolling window. */
function exhaust(db: TaskqDb): void {
  // calibrate at ~now so the manual event sits inside the bucket window that
  // capacitySnapshot reads at Date.now().
  calibrateBucket(db, 'session_5h', { consumedFraction: 1, at: Date.now() });
}

describe('capacitySnapshot — throttle (adaptive shrink) vs maximize (default)', () => {
  test('throttle:false → effectiveJobs === maxJobs even when capacity is exhausted', () => {
    const db = fresh();
    exhaust(db); // the adaptive estimator WOULD shrink the pool here
    const snap = capacitySnapshot(db, cfg({ jobs: 4, throttle: false }));
    expect(snap.maxJobs).toBe(4);
    // MAXIMIZE: full pool regardless of buckets / schedule recommendation.
    expect(snap.effectiveJobs).toBe(snap.maxJobs);
    // The schedule still *reports* it would prefer light (the data is unchanged),
    // but the pool is not shrunk.
    expect(snap.effectiveJobs).toBeGreaterThan(snap.decision.recommendedJobs);
  });

  test('throttle:false → effectiveJobs === maxJobs with healthy capacity too', () => {
    const db = fresh();
    const snap = capacitySnapshot(db, cfg({ jobs: 4, throttle: false }));
    expect(snap.effectiveJobs).toBe(snap.maxJobs);
    expect(snap.effectiveJobs).toBe(4);
  });

  test('throttle:false (fleet) → effectiveJobs === fleet total regardless of buckets', () => {
    const db = fresh();
    exhaust(db);
    const snap = capacitySnapshot(
      db,
      cfg({ throttle: false, fleet: [{ models: ['opus'], jobs: 2 }, { models: ['sonnet'], jobs: 3 }] }),
    );
    expect(snap.maxJobs).toBe(5); // 2 + 3 fleet slots
    expect(snap.effectiveJobs).toBe(5);
  });

  test('throttle:true → effectiveJobs shrinks with low capacity (the old adaptive behavior)', () => {
    const db = fresh();
    exhaust(db);
    const snap = capacitySnapshot(db, cfg({ jobs: 4, throttle: true }));
    expect(snap.maxJobs).toBe(4);
    expect(snap.effectiveJobs).toBe(Math.min(snap.maxJobs, snap.decision.recommendedJobs));
    expect(snap.effectiveJobs).toBeLessThan(snap.maxJobs);
  });

  test('throttle:true with healthy capacity still runs the full pool', () => {
    const db = fresh();
    const snap = capacitySnapshot(db, cfg({ jobs: 4, throttle: true }));
    // Healthy buckets → schedule recommends the full pool either way.
    expect(snap.effectiveJobs).toBe(Math.min(snap.maxJobs, snap.decision.recommendedJobs));
    expect(snap.effectiveJobs).toBe(4);
  });
});

describe('validateConfigPatch — throttle', () => {
  test('accepts a boolean throttle', () => {
    expect(validateConfigPatch({ throttle: true }).throttle).toBe(true);
    expect(validateConfigPatch({ throttle: false }).throttle).toBe(false);
  });

  test('rejects a non-boolean throttle', () => {
    // @ts-expect-error — deliberately wrong type
    expect(() => validateConfigPatch({ throttle: 'yes' })).toThrow('throttle must be boolean');
  });
});
