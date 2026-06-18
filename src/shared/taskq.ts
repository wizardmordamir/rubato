/**
 * Browser-safe wire types for the Taskq (v2 orchestrator) UI. Re-exports the
 * cwip/taskq domain types (type-only — erased at build, so no node import leaks
 * into the browser bundle) plus the board shape the server returns.
 */

import type { CcusageReport, ComprehensiveClaudeReport, TaskRow, TaskStatus } from 'cwip/taskq';

export type {
  BucketState,
  CcusageDailyEntry,
  CcusageModelBreakdown,
  CcusageReport,
  ComprehensiveClaudeReport,
  MetricTier,
  NewTask,
  OpenClarification,
  PeriodMetrics,
  Position,
  TaskPatch,
  TaskRow,
  TaskStatus,
  ThinkLevel,
} from 'cwip/taskq';

/** Where the last reading from a live-usage source stands. */
export type UsageSourceStatus = 'live' | 'fallback' | 'never';

/**
 * Wire shape of the live usage snapshot served by `/api/taskq/usage/live`:
 * the real `/usage` telemetry + the ccusage daily cost/token report, each with
 * its own freshness status. The server poller produces this; the UI renders it.
 */
export interface TaskqUsageSnapshot {
  telemetry: ComprehensiveClaudeReport | null;
  telemetryAt: number | null;
  telemetryStatus: UsageSourceStatus;
  telemetryError?: string;
  cost: CcusageReport | null;
  costAt: number | null;
  costStatus: UsageSourceStatus;
  costError?: string;
}

/** A task row plus its resolved `needs:` slugs and optional runtime data. */
export interface TaskqTaskView extends TaskRow {
  needs: string[];
  /** For claimed tasks: epoch-ms when the lease was taken. */
  claimed_at?: number | null;
  /** For done tasks: epoch-ms when the run started. */
  started_at?: number | null;
  /** For done tasks: epoch-ms when the run ended. */
  ended_at?: number | null;
  /** For done tasks: run duration in seconds. */
  duration_s?: number | null;
  /** For done tasks: AI-generated completion summary. */
  summary?: string | null;
  /** For done tasks: git commit sha. */
  commit?: string | null;
}

/** Persisted UI preferences for a board section (collapse state). */
export interface TaskqSectionPref {
  status: TaskStatus;
  collapsed: boolean;
}

/** The whole board: every task (priority order) + per-status counts. */
export interface TaskqBoard {
  tasks: TaskqTaskView[];
  counts: Record<TaskStatus, number>;
  total: number;
}

// Browser-safe mirrors of the cwip/taskq vocabulary (canonical source:
// cwip/taskq `types.ts`). Duplicated here because cwip/taskq's value exports pull
// `node:os` (via paths.ts), which can't enter the browser bundle — only its
// *types* are imported above (erased at build). Keep in sync with the engine.

export const TASKQ_STATUSES: TaskStatus[] = [
  'pending_triage',
  'ready',
  'claimed',
  'blocked',
  'on_hold',
  'needs_input',
  'not_ready',
  'failed',
  'done',
];

/** Statuses the builder may set directly (runtime states are engine-owned). */
export const TASKQ_AUTHORABLE_STATUSES: TaskStatus[] = ['ready', 'on_hold', 'not_ready', 'pending_triage', 'failed'];

export const TASKQ_STATUS_LABELS: Record<TaskStatus, string> = {
  pending_triage: 'Pending triage',
  ready: 'Ready',
  claimed: 'In progress',
  blocked: 'Blocked (deps)',
  on_hold: 'On hold',
  needs_input: 'Needs input',
  not_ready: 'Not ready',
  failed: 'Failed',
  done: 'Done',
};

export const TASKQ_MODEL_ALIASES = ['opus', 'opus-1m', 'sonnet', 'haiku', 'fable'];
export const TASKQ_THINK_LEVELS = ['off', 'low', 'medium', 'high', 'max'];
