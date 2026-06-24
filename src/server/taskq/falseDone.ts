/**
 * False-done detection — ru's THIN seam over cwip's pure decision core.
 *
 * The PURE, exhaustively-tested decision core — {@link decideDone} plus
 * {@link DoneEvidence}/{@link DoneVerdict}/{@link FalseDoneReason}/
 * {@link FalseDoneDisposition} — now lives in **`cwip/taskq`**, the ONE
 * driver-agnostic home both apps (rubato + cursedalchemy) share. It is re-exported
 * here so ru's existing `./falseDone` import points (doneCheck.ts, orchestrator.ts)
 * keep resolving unchanged. What STAYS local to ru are the pieces coupled to ru's
 * orchestrator types: the {@link DoneGuard} the orchestrator threads through
 * `runDrain`, its opaque {@link DoneSnapshot}, and the {@link FalseDoneAlert} sink
 * record. The impure evidence-gatherer that wires real git/build/fs into
 * {@link decideDone} is `doneCheck.ts`; the db revert (`revertCompletion`) lives in
 * `orchestrator.ts`.
 *
 * THE PROBLEM this guards against: a worker's `claude -p` envelope reports
 * `subtype:"success"` even when the agent landed ZERO code — so the orchestrator
 * would mark the task `done` with nothing behind it. That actually happened (rfc-31
 * was falsely "done" with no commits and briefly cascaded to release downstream
 * `needs:`-blocked tasks before a later worker caught it by hand). So a reported
 * "success" is no longer trusted on its own — before an integration-flow task is
 * marked `done` it must show EVIDENCE: it landed commit(s) on `refactor/integration`
 * (a non-empty git delta in its run window) and did not regress the integration
 * build beyond a tolerated/known-red set.
 *
 * THE NO-OP EXCEPTION ({@link TaskRow.noop_ok}): some tasks correctly land NO
 * changes — a diagnostic/audit/check/review, an "only change if needed" task that
 * finds everything OK, or one that only FILES follow-up taskq tasks. `decideDone`
 * skips the non-empty-delta requirement for a `noop_ok` task (the regression check
 * still applies); `doneCheck.verify` feeds `task.noop_ok` into the evidence.
 *
 * DISPOSITION, NOT A BARE `needs_input`: when the gate catches a real false-done it
 * parks the task `on_hold` with a {@link FalseDoneDisposition} naming WHO/WHAT
 * should pick it up — never `needs_input`, which is reserved for a real
 * clarification question (a false-done has none).
 */

import type { DoneVerdict, FalseDoneReason, TaskRow } from 'cwip/taskq';
import type { TaskResult, WorkerContext } from './orchestrator';

export type { DoneEvidence, DoneVerdict, FalseDoneDisposition, FalseDoneReason } from 'cwip/taskq';
// Re-export the pure core from its single cwip home so `./falseDone` consumers
// (doneCheck, orchestrator, tests) import from one stable point.
export { decideDone } from 'cwip/taskq';

/**
 * Opaque pre-run state captured at claim time and handed back to {@link DoneGuard.verify}
 * at completion. The shape is the guard implementation's own concern; the orchestrator
 * only threads it through.
 */
export type DoneSnapshot = unknown;

/**
 * The completion gate the orchestrator calls in its `res.ok` branch. `snapshot`
 * runs at claim (before the executor), capturing the pre-run integration tip +
 * the known-green baseline; `verify` runs at completion, gathering the delta and
 * returning a {@link DoneVerdict}. Both are injected into `runDrain` so the loop
 * stays free of git/build/fs — the real implementation is `makeDoneGuard`.
 */
export interface DoneGuard {
  snapshot(task: TaskRow, ctx: WorkerContext): Promise<DoneSnapshot> | DoneSnapshot;
  verify(
    task: TaskRow,
    result: TaskResult,
    snapshot: DoneSnapshot,
    ctx: WorkerContext,
  ): Promise<DoneVerdict> | DoneVerdict;
}

/**
 * A deduped false-done alert record (one per offending task id; re-detection bumps
 * it). `status` is always `on_hold` — a caught false-done is parked, never routed to
 * the question-bearing `needs_input` (that's reserved for a real clarification).
 */
export interface FalseDoneAlert {
  taskId: number;
  slug: string | null;
  repo: string | null;
  title: string;
  reason: FalseDoneReason;
  status: 'on_hold';
  note: string;
  /** Epoch-ms of the (most recent) detection. */
  detectedAt: number;
}
