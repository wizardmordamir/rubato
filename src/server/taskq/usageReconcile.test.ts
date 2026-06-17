import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { allBucketStates, calibrateBucket, migrate, recordRun, type TaskqDb } from 'cwip/taskq';
import { computeReconciledLimit, RECONCILE, reconcileUsageObservation } from './usageReconcile';

function fresh(): TaskqDb {
  const d = new Database(':memory:') as unknown as TaskqDb;
  d.exec('PRAGMA foreign_keys = ON');
  migrate(d);
  return d;
}

describe('computeReconciledLimit (pure policy)', () => {
  test('not-exhausted while estimate already healthy → no-op', () => {
    const r = computeReconciledLimit('not-exhausted', { limit: 1_000_000, used: 200_000, fraction: 0.8 });
    expect(r.changed).toBe(false);
    expect(r.limitUnits).toBe(1_000_000);
  });

  test('not-exhausted while estimate reads 0% → grows the limit and re-anchors', () => {
    const r = computeReconciledLimit('not-exhausted', { limit: 1_000_000, used: 1_000_000, fraction: 0 });
    expect(r.changed).toBe(true);
    expect(r.resetWindow).toBe(true);
    // used / (1 - remainAfterGrow) = 1,000,000 / 0.5 = 2,000,000, within the 3× cap.
    expect(r.limitUnits).toBe(2_000_000);
    // Lands on a neutral ~50% remaining so work resumes.
    expect(r.consumedFraction).toBeCloseTo(1 - RECONCILE.remainAfterGrow, 5);
  });

  test('growth is clamped to maxGrow per event', () => {
    // used hugely exceeds limit (stale over-count) — clamp stops a runaway jump.
    const r = computeReconciledLimit('not-exhausted', { limit: 1_000_000, used: 50_000_000, fraction: 0 });
    expect(r.limitUnits).toBe(1_000_000 * RECONCILE.maxGrow);
  });

  test('growth respects minGrow floor when used is tiny', () => {
    const r = computeReconciledLimit('not-exhausted', { limit: 1_000_000, used: 0, fraction: 0 });
    expect(r.limitUnits).toBe(1_000_000 * RECONCILE.minGrow);
  });

  test('exhausted while estimate showed room → shrinks toward used', () => {
    const r = computeReconciledLimit('exhausted', { limit: 1_000_000, used: 600_000, fraction: 0.4 });
    expect(r.changed).toBe(true);
    expect(r.limitUnits).toBe(600_000); // max(used, limit*minShrinkKeep=500k)
    expect(r.consumedFraction).toBeCloseTo(1 - RECONCILE.remainAfterShrink, 5);
  });

  test('shrink is floored at minShrinkKeep of the current limit', () => {
    const r = computeReconciledLimit('exhausted', { limit: 1_000_000, used: 10_000, fraction: 0.9 });
    expect(r.limitUnits).toBe(1_000_000 * RECONCILE.minShrinkKeep);
  });

  test('exhausted while estimate already shows exhausted → no-op', () => {
    const r = computeReconciledLimit('exhausted', { limit: 1_000_000, used: 1_000_000, fraction: 0 });
    expect(r.changed).toBe(false);
  });
});

describe('reconcileUsageObservation (DB-bound)', () => {
  test('lifts a stuck-at-0% bucket back to capacity after a real success', () => {
    const db = fresh();
    // Burn the session bucket to 0% locally (limit seeded at 1,000,000).
    calibrateBucket(db, 'session_5h', { consumedFraction: 1, at: 1000 });
    const before = allBucketStates(db, 2000).find((b) => b.key === 'session_5h')!;
    expect(before.fraction).toBe(0);

    const actions = reconcileUsageObservation(db, 'not-exhausted', 3000);
    expect(actions.some((a) => a.key === 'session_5h')).toBe(true);

    const after = allBucketStates(db, 3000).find((b) => b.key === 'session_5h')!;
    expect(after.fraction).toBeGreaterThan(0.4); // back to ~50% remaining
    expect(after.limit).toBeGreaterThan(before.limit); // learned a higher ceiling
  });

  test('a healthy bucket is untouched by a not-exhausted observation', () => {
    const db = fresh();
    recordRun(db, { at: 1000, model: 'sonnet', outputTokens: 1000 }); // negligible usage
    const actions = reconcileUsageObservation(db, 'not-exhausted', 2000);
    expect(actions).toHaveLength(0);
  });

  test('repeated grow cycles converge (limit ratchets up, then stops)', () => {
    const db = fresh();
    // Drive it to 0% repeatedly; each not-exhausted surprise should grow the limit.
    let prevLimit = allBucketStates(db, 0).find((b) => b.key === 'session_5h')!.limit;
    for (let i = 1; i <= 4; i++) {
      const at = i * 1000;
      calibrateBucket(db, 'session_5h', { consumedFraction: 1, at });
      reconcileUsageObservation(db, 'not-exhausted', at + 100);
      const lim = allBucketStates(db, at + 100).find((b) => b.key === 'session_5h')!.limit;
      expect(lim).toBeGreaterThanOrEqual(prevLimit); // monotonic, never collapses
      prevLimit = lim;
    }
  });
});
