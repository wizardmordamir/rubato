/**
 * Capacity snapshot — what the next drain pass would actually do and why.
 * Computes the schedule decision, worker slot filters, and per-ready-task
 * eligibility so the UI can answer:
 *   - Why am I only seeing N workers even though jobs=M?
 *   - Which ready tasks can't be claimed with my current settings?
 *   - What model will each task actually run with?
 */

import type { TaskqDb } from 'cwip/taskq';
import { allBucketStates, type ClaimFilters, listTasks, scheduleDecision } from 'cwip/taskq';
import { loadTaskqConfig, type TaskqConfig } from './config';

export interface CapacityWorkerSlot {
  index: number;
  /** null = any model (flat mode); otherwise the tier's model aliases */
  models: string[] | null;
}

export interface CapacityReadyTask {
  id: number;
  title: string;
  /** The model marker on the task itself (null = no pin). */
  model: string | null;
  /** What model the worker will actually invoke: task.model ?? config.model */
  effectiveModel: string;
  repo: string | null;
  /** Indices into workerSlots that can claim this task. */
  claimableBySlots: number[];
  /** Reason string when no slot can claim the task. */
  unclaimableReason?: string;
}

export interface CapacityBucket {
  key: string;
  fraction: number;
  remaining: number;
  resetInSeconds?: number;
}

export interface CapacityScheduleDecision {
  paused: boolean;
  recommendedJobs: number;
  preferLight: boolean;
  burnExpiring: boolean;
  reason: string;
}

export interface CapacitySnapshot {
  /** Default model from config (used when a task has no model pin). */
  defaultModel: string;
  /** config.jobs (the flat max, or the fleet total). */
  configuredJobs: number;
  /** true when config.fleet has at least one tier. */
  fleetMode: boolean;
  /** The schedule decision the next drain pass would make right now. */
  decision: CapacityScheduleDecision;
  /** Total worker slots (fleet total or config.jobs). */
  maxJobs: number;
  /** min(maxJobs, decision.recommendedJobs) — how many workers the next drain will spawn. */
  effectiveJobs: number;
  /** One entry per worker slot with its model filter. */
  workerSlots: CapacityWorkerSlot[];
  /** Total ready tasks. */
  totalReady: number;
  /** Ready tasks no current slot can claim (model mismatch). */
  unservableReady: number;
  /** Per-task eligibility detail (only ready tasks). */
  readyTasks: CapacityReadyTask[];
  /** Token bucket capacities (abbreviated for the panel). */
  buckets: CapacityBucket[];
}

/** Whether a task with this model pin can be claimed by a slot with these filters. */
function taskMatchesSlot(taskModel: string | null, slotModels: string[] | null): boolean {
  if (slotModels === null) return true; // flat mode: any task
  if (taskModel === null) return true; // untagged task: any slot
  return slotModels.includes(taskModel);
}

/** Compute the capacity snapshot from live DB + config. */
export function capacitySnapshot(db: TaskqDb, config?: TaskqConfig): CapacitySnapshot {
  const cfg = config ?? loadTaskqConfig();
  const now = Date.now();
  const buckets = allBucketStates(db, now);

  // Build per-worker slot filters (mirrors taskqDrain.ts exactly).
  const perWorkerFilters: ClaimFilters[] = [];
  if (cfg.fleet?.length) {
    for (const tier of cfg.fleet) {
      for (let i = 0; i < tier.jobs; i++) perWorkerFilters.push({ models: tier.models });
    }
  }
  const maxJobs = perWorkerFilters.length || cfg.jobs;
  const fleetMode = (cfg.fleet?.length ?? 0) > 0;

  const decision = scheduleDecision(buckets, { maxJobs, baseJobs: cfg.jobs });
  const effectiveJobs = Math.min(maxJobs, decision.recommendedJobs);

  const workerSlots: CapacityWorkerSlot[] = Array.from({ length: maxJobs }, (_, i) => ({
    index: i,
    models: perWorkerFilters[i]?.models ?? null,
  }));

  // Analyse every ready task.
  const readyRows = listTasks(db).filter((t) => t.status === 'ready');
  const readyTasks: CapacityReadyTask[] = readyRows.map((t) => {
    const effectiveModel = t.model ?? cfg.model;
    const claimableBySlots = workerSlots.filter((s) => taskMatchesSlot(t.model, s.models)).map((s) => s.index);

    let unclaimableReason: string | undefined;
    if (claimableBySlots.length === 0) {
      if (t.model && fleetMode) {
        unclaimableReason = `model:${t.model} — no fleet tier covers this model`;
      } else {
        unclaimableReason = 'no worker slot can claim this task';
      }
    }

    return {
      id: t.id,
      title: t.title,
      model: t.model,
      effectiveModel,
      repo: t.repo,
      claimableBySlots,
      unclaimableReason,
    };
  });

  return {
    defaultModel: cfg.model,
    configuredJobs: cfg.jobs,
    fleetMode,
    decision: {
      paused: decision.paused,
      recommendedJobs: decision.recommendedJobs,
      preferLight: decision.preferLight,
      burnExpiring: decision.burnExpiring,
      reason: decision.reason,
    },
    maxJobs,
    effectiveJobs,
    workerSlots,
    totalReady: readyTasks.length,
    unservableReady: readyTasks.filter((t) => t.claimableBySlots.length === 0).length,
    readyTasks,
    buckets: buckets.map((b) => ({
      key: b.key,
      fraction: b.fraction,
      remaining: b.remaining,
      resetInSeconds: b.resetInSeconds,
    })),
  };
}
