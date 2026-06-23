/**
 * False-done detection — the PURE decision core (no git/build/db/fs here; the
 * impure evidence-gathering lives in `doneCheck.ts`, which wires real clients
 * into {@link decideDone}, and the db revert lives in `orchestrator.ts`).
 *
 * THE PROBLEM this guards against: a worker's `claude -p` envelope reports
 * `subtype:"success"` even when the agent landed ZERO code — so the orchestrator
 * would mark the task `done` with nothing behind it. That actually happened
 * (rfc-31 was falsely "done" with no commits and briefly cascaded to release 21
 * downstream `needs:`-blocked tasks before a later worker caught it by hand).
 *
 * So a reported "success" is no longer trusted on its own. Before the completion
 * path marks an integration-flow task `done`, it must show EVIDENCE:
 *   1. it landed commit(s) on `refactor/integration` (a non-empty git delta in
 *      the task's run window) — the core, always-on, objective check, and
 *   2. it did not REGRESS the integration build beyond a tolerated/known set
 *      (a build that was already red before this task is tolerated — a heal task
 *      owns it; only turning a KNOWN-GREEN integration red is a regression).
 *
 * A "done" that lacks landed code → reverted to `needs_input`; one that regressed
 * a green integration → reverted to `on_hold`. Either way the task never reaches
 * `done` (so downstream `needs:` deps stay blocked, killing the cascade) and a
 * deduped alert + a clear note are recorded (mirroring the manual save a human
 * did for rfc-31). When a repo isn't on the integration flow (no
 * `refactor/integration`), the gate can't and shouldn't judge — it accepts.
 */

import type { HoldDisposition, TaskRow } from 'cwip/taskq';
import type { TaskResult, WorkerContext } from './orchestrator';

/** Why a reported success was rejected (drives the note + alert + status). */
export type FalseDoneReason = 'empty-done' | 'regression';

/** The evidence gathered about a reported-success task, fed to {@link decideDone}. */
export interface DoneEvidence {
  /**
   * Is this task's repo on the integration flow (resolved + has a
   * `refactor/integration` branch)? When false the gate accepts unconditionally —
   * we have no objective branch to measure a landing against, and over-blocking a
   * normal task is worse than missing a false-done on a non-flow repo.
   */
  enforced: boolean;
  /**
   * New commits on `refactor/integration` between claim and completion (the task's
   * run window). `0` ⇒ nothing landed ⇒ empty-done. This is the objective,
   * worker-independent signal that directly catches the rfc-31 case.
   */
  landedCommits: number;
  /** Did we run the integration `bun run build` to check for a regression? */
  buildChecked: boolean;
  /** Build result when {@link buildChecked}; undefined otherwise. */
  buildGreen?: boolean;
  /**
   * Was the integration build ALREADY red (or its prior state unknown) before this
   * task? Then a red build now is TOLERATED — it isn't this task's regression. Only
   * a build that was known-GREEN and is now red counts as a regression. Conservative
   * by design: we only flag a regression on positive evidence the task broke a green
   * integration, never on a guess (a false revert of real work is the worse error).
   */
  toleratedRed: boolean;
}

/** What the completion gate decides for a reported-success task. */
export type DoneVerdict =
  | { accept: true; note?: string }
  | {
      accept: false;
      /** Where to park the reverted task — a non-dispatchable hold (never `done`). */
      status: 'on_hold' | 'needs_input';
      reason: FalseDoneReason;
      /**
       * WHO/WHAT unblocks the reverted task (the taskq hold-disposition contract):
       * a false-done revert is a PARK, so it must declare a disposition — never a
       * bare hold. This is the rfc-31j fix: the original bug parked a false-done in
       * a note-only on_hold with no owner, no retry, no heal, so it sat STUCK while
       * blocking its dependents. Today both reasons route to `needs_owner` (a human
       * must inspect — the gate can't safely auto-resolve a false success); the
       * orchestrator threads it into {@link revertCompletion}.
       */
      disposition: HoldDisposition;
      /** Human-readable explanation, stamped on the task's `note` + the alert. */
      note: string;
    };

/**
 * Decide whether a reported "success" really landed, from gathered {@link DoneEvidence}.
 * Pure + total — every branch returns a verdict, so it's exhaustively unit-testable.
 *
 *  - not enforced (non-flow repo)  → accept (can't judge).
 *  - landed 0 commits              → REJECT empty-done → `needs_input` + needs_owner.
 *  - built red, not tolerated      → REJECT regression → `on_hold` + needs_owner.
 *  - landed ≥1, build green/tolerated/unchecked → accept.
 */
export function decideDone(e: DoneEvidence): DoneVerdict {
  if (!e.enforced) return { accept: true };

  if (e.landedCommits <= 0) {
    return {
      accept: false,
      status: 'needs_input',
      reason: 'empty-done',
      disposition: 'needs_owner',
      note:
        'False-done: the worker reported success but landed ZERO commits on refactor/integration ' +
        '(a non-empty git delta is required to mark a task done). Reverted to needs_input — re-run it, ' +
        'or mark it done by hand only if the work genuinely lives elsewhere.',
    };
  }

  if (e.buildChecked && e.buildGreen === false && !e.toleratedRed) {
    return {
      accept: false,
      status: 'on_hold',
      reason: 'regression',
      disposition: 'needs_owner',
      note:
        'False-done: the worker landed code but REGRESSED the integration build — `bun run build` on ' +
        'refactor/integration was green before this task and is red after it. Reverted to on_hold; fix the ' +
        'regression (or file a follow-up heal) before re-landing.',
    };
  }

  return { accept: true };
}

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
 * returning a {@link DoneVerdict}. Both are injected into {@link runDrain} so the
 * loop stays free of git/build/fs — the real implementation is `makeDoneGuard`.
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

/** A deduped false-done alert record (one per offending task id; re-detection bumps it). */
export interface FalseDoneAlert {
  taskId: number;
  slug: string | null;
  repo: string | null;
  title: string;
  reason: FalseDoneReason;
  status: 'on_hold' | 'needs_input';
  note: string;
  /** Epoch-ms of the (most recent) detection. */
  detectedAt: number;
}
