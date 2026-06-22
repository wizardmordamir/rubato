/**
 * Wire contract for the cursedalchemy (ca) → rubato (ru) orchestration bridge,
 * mirrored from ca's `shared/types/orchestration.ts`. ca exposes a key-authed,
 * GET-only `/api/integration/*` API; rubato pulls published tasks from it, runs
 * them through the orchestrator (optionally enhancing rough drafts with local
 * Ollama via Forge first), and pushes execution + orchestration data back so the
 * owner can watch a rubato fleet from ca, anywhere.
 *
 * This file is the ru-side mirror of that contract (the two repos can't share a
 * module). Keep it in sync with ca's orchestration types.
 */

export type CaEnhanceMode = 'direct' | 'ollama';

/** A task rubato pulled from ca (already locked on ca's side by the pull). */
export interface PulledTask {
  id: string; // ca task id — echo back on updates
  title: string;
  body: string;
  repo: string | null;
  model: string | null;
  think: string | null;
  fast: boolean;
  groupKey: string | null;
  slug: string | null;
  needs: string[];
  status: 'ready' | 'hold';
  enhanceMode: CaEnhanceMode;
}

/** Execution info rubato reports back to ca for a pulled task. */
export interface TaskUpdatePayload {
  host?: string;
  remoteTaskId?: number | null;
  status?: string | null;
  summary?: string | null;
  model?: string | null;
  think?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  meta?: Record<string, unknown> | null;
}

export type CaDataKind = 'usage' | 'capacity' | 'tasks' | 'timings';

export interface CaUsageBucket {
  key: string;
  limit: number;
  used: number;
  remaining: number;
  fraction: number;
  resetInSeconds?: number;
}
export interface CaUsagePayload {
  buckets: CaUsageBucket[];
  at: string;
}

export interface CaCapacityPayload {
  defaultModel: string;
  configuredJobs: number;
  effectiveJobs: number;
  maxJobs: number;
  paused: boolean;
  reason?: string;
  totalReady: number;
  unservableReady: number;
  workerSlots: { index: number; models: string[] | null }[];
  at: string;
}

export interface CaTaskSummary {
  id: number;
  title: string;
  status: string;
  repo: string | null;
  model: string | null;
  think: string | null;
  updatedAt: string;
  /** Failures so far (bounded auto-retry); 0 for a task that hasn't failed. */
  attempts: number;
  /** Effective retry ceiling (per-task `max_attempts` ?? the config default). */
  maxAttempts: number;
  /** Last failure reason (also why it's on_hold/blocked); null when none. */
  note: string | null;
  /**
   * Epoch-ms when the task next becomes eligible — set in the future while it
   * waits out a retry backoff, so ca can render "retry N/M in …". Null = due now.
   */
  nextEligibleAt: number | null;
}
export interface CaTasksPayload {
  ready: CaTaskSummary[];
  claimed: CaTaskSummary[];
  recentDone: CaTaskSummary[];
  counts: Record<string, number>;
  at: string;
}

export interface CaTimingCategory {
  category: string;
  count: number;
  totalMs: number;
  avgMs: number;
  p95Ms: number;
}
export interface CaTimingsPayload {
  categories: CaTimingCategory[];
  taskCount: number;
  eventCount: number;
  totalMs: number;
  at: string;
}
