/**
 * Adaptive usage-estimate reconciliation — the self-calibrating layer over the
 * local token-bucket ledger.
 *
 * The buckets in `cwip/taskq` are only an *estimate* of the Max-plan session/
 * weekly limits (the real ceilings aren't exposed by the API). Seeded with
 * placeholder limits and a rough per-model unit weight, the estimate inevitably
 * drifts: it reads 0% remaining while the account actually has plenty left
 * (or, rarely, the reverse). Manual `/usage` calibration fixes a single reading
 * but never the *rate*, so it drifts straight back.
 *
 * This module closes the loop from observed reality. Every time the orchestrator
 * makes a real `claude -p` call we learn one bit:
 *   - the call went through with no usage-limit error → we are NOT out, and
 *   - a genuine "usage limit reached" error came back → we ARE out.
 * When that observation contradicts the local estimate we nudge the bucket's
 * learned `limit_units` (AIMD-style: grow when we under-estimated the ceiling,
 * shrink when we over-estimated it) and re-anchor the window so the UI stops
 * lying. Over a few drain ticks the limit converges on the true ceiling — no
 * manual calibration required. The policy is a pure function so it's unit-tested
 * in isolation; {@link reconcileUsageObservation} is the thin DB-bound wrapper.
 */

import { allBucketStates, type BucketState, calibrateBucket, type TaskqDb } from 'cwip/taskq';

/** What a real API call told us about the account's true capacity. */
export type UsageObservation =
  /** A call went through without a usage-limit error — we are not actually out. */
  | 'not-exhausted'
  /** A genuine "usage limit reached" error came back — we really are out. */
  | 'exhausted';

/** The mutable inputs the policy reasons over (a slice of {@link BucketState}). */
export interface ReconcileInput {
  /** Current learned ceiling for the bucket. */
  limit: number;
  /** Units consumed within the rolling window right now. */
  used: number;
  /** remaining / limit, 0–1 (what the UI shows). */
  fraction: number;
}

/** The calibration to apply (fed straight into `calibrateBucket`), or a no-op. */
export interface ReconcileResult {
  /** True when reality contradicted the estimate and we should recalibrate. */
  changed: boolean;
  /** New learned ceiling to persist. */
  limitUnits: number;
  /** Consumed-fraction seed for the re-anchored window (0–1). */
  consumedFraction: number;
  /** Always re-anchor the window (discard stale run events) when we change. */
  resetWindow: boolean;
  /** Human-readable explanation for logs. */
  reason: string;
}

/** Tuning constants — deliberately conservative so the estimate converges, not oscillates. */
export const RECONCILE = {
  /** A "not-exhausted" surprise leaves the bucket showing this much remaining (neutral, resumes work). */
  remainAfterGrow: 0.5,
  /** An "exhausted" surprise leaves the bucket showing this much remaining (throttle, but not a hard 0). */
  remainAfterShrink: 0.02,
  /** Per-event clamps on how far the learned limit can move (prevents runaway/collapse). */
  minGrow: 1.25,
  maxGrow: 3,
  minShrinkKeep: 0.5,
  /** Below this remaining-fraction the estimate counts as "says exhausted". */
  exhaustedBelow: 0.0001,
} as const;

/**
 * Decide how to recalibrate one bucket given a single real-world observation.
 * Pure + deterministic. Returns `changed:false` (a no-op) whenever the
 * observation simply agrees with the current estimate.
 */
export function computeReconciledLimit(kind: UsageObservation, b: ReconcileInput): ReconcileResult {
  const noop = (reason: string): ReconcileResult => ({
    changed: false,
    limitUnits: b.limit,
    consumedFraction: Math.max(0, Math.min(1, 1 - b.fraction)),
    resetWindow: false,
    reason,
  });

  const limit = b.limit > 0 ? b.limit : 1;
  const saysExhausted = b.fraction <= RECONCILE.exhaustedBelow;

  if (kind === 'not-exhausted') {
    // Only a surprise when the estimate insisted we were out. A healthy run
    // that agrees with a healthy estimate changes nothing.
    if (!saysExhausted) return noop('estimate already shows capacity — no change');

    // We hit the ceiling at (at least) `used`, yet a real call still works, so
    // the true ceiling is higher. Grow so `used` maps to the post-grow consumed
    // target, clamped to a sane per-event step.
    const target = 1 - RECONCILE.remainAfterGrow; // consumed fraction we want to land on
    const desired = b.used > 0 ? b.used / target : limit * RECONCILE.minGrow;
    const grown = Math.min(Math.max(desired, limit * RECONCILE.minGrow), limit * RECONCILE.maxGrow);
    const limitUnits = Math.max(grown, limit);
    return {
      changed: true,
      limitUnits,
      consumedFraction: 1 - RECONCILE.remainAfterGrow,
      resetWindow: true,
      reason: `grew limit ${Math.round(limit).toLocaleString()}→${Math.round(limitUnits).toLocaleString()} (real call succeeded while estimate read 0%)`,
    };
  }

  // kind === 'exhausted': a genuine usage-limit error.
  if (saysExhausted) return noop('estimate already shows exhausted — no change');

  // We over-estimated the ceiling: the wall is at ~`used`, below the current
  // limit. Shrink toward `used` (floored so one bad event can't collapse it) and
  // re-anchor near-empty so scheduling throttles.
  const limitUnits = Math.max(b.used, limit * RECONCILE.minShrinkKeep);
  return {
    changed: true,
    limitUnits,
    consumedFraction: 1 - RECONCILE.remainAfterShrink,
    resetWindow: true,
    reason: `shrank limit ${Math.round(limit).toLocaleString()}→${Math.round(limitUnits).toLocaleString()} (usage-limit error while estimate read ${Math.round(b.fraction * 100)}%)`,
  };
}

/** One reconciled bucket (returned for logging/telemetry). */
export interface ReconcileAction {
  key: string;
  reason: string;
  limitUnits: number;
}

/**
 * Apply {@link computeReconciledLimit} to every tracked bucket against one
 * observation and persist any changes. Returns the buckets that actually moved
 * (empty array when the observation agreed with every estimate — the common,
 * zero-cost case). `now` is injectable for tests.
 */
export function reconcileUsageObservation(
  db: TaskqDb,
  kind: UsageObservation,
  now: number = Date.now(),
): ReconcileAction[] {
  const states: BucketState[] = allBucketStates(db, now);
  const actions: ReconcileAction[] = [];
  for (const s of states) {
    const r = computeReconciledLimit(kind, { limit: s.limit, used: s.used, fraction: s.fraction });
    if (!r.changed) continue;
    calibrateBucket(db, s.key, {
      limitUnits: r.limitUnits,
      consumedFraction: r.consumedFraction,
      at: now,
      // Re-anchor just-before-now so the stale run events (the over-count that
      // caused the bad reading) age out immediately and the seed event counts.
      resetAt: r.resetWindow ? now - 1 : undefined,
    });
    actions.push({ key: s.key, reason: r.reason, limitUnits: r.limitUnits });
  }
  return actions;
}
