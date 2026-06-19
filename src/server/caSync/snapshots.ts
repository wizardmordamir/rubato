import { logger } from 'cwip';
import { allBucketStates, listTasks, type TaskRow } from 'cwip/taskq';
import type {
  CaCapacityPayload,
  CaTaskSummary,
  CaTasksPayload,
  CaTimingsPayload,
  CaUsagePayload,
} from '../../shared/caSync';
import { getTimingOverview } from '../orchestrationTimings';
import { capacitySnapshot } from '../taskq/capacity';
import { getTaskqDb } from '../taskqDb';

const nowIso = () => new Date().toISOString();
const summary = (t: TaskRow): CaTaskSummary => ({
  id: t.id,
  title: t.title,
  status: t.status,
  repo: t.repo,
  model: t.model,
  think: t.think,
  updatedAt: t.updated_at,
});

/** Token-bucket usage (the same numbers the Usage tab shows). */
export function buildUsage(): CaUsagePayload {
  const buckets = allBucketStates(getTaskqDb(), Date.now()).map((b) => ({
    key: b.key,
    limit: b.limit,
    used: b.used,
    remaining: b.remaining,
    fraction: b.fraction,
    resetInSeconds: b.resetInSeconds,
  }));
  return { buckets, at: nowIso() };
}

/** Worker capacity + scheduling decision. */
export function buildCapacity(): CaCapacityPayload {
  const s = capacitySnapshot(getTaskqDb());
  return {
    defaultModel: s.defaultModel,
    configuredJobs: s.configuredJobs,
    effectiveJobs: s.effectiveJobs,
    maxJobs: s.maxJobs,
    paused: s.decision.paused,
    reason: s.decision.reason,
    totalReady: s.totalReady,
    unservableReady: s.unservableReady,
    workerSlots: s.workerSlots.map((w) => ({ index: w.index, models: w.models })),
    at: nowIso(),
  };
}

/** Queue snapshot: status counts + the running / recently-finished tasks. */
export function buildTasks(): CaTasksPayload {
  const all = listTasks(getTaskqDb());
  const counts: Record<string, number> = {};
  for (const t of all) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const byUpdatedDesc = (a: TaskRow, b: TaskRow) => (a.updated_at < b.updated_at ? 1 : -1);
  return {
    counts,
    ready: all
      .filter((t) => t.status === 'ready')
      .slice(0, 20)
      .map(summary),
    claimed: all
      .filter((t) => t.status === 'claimed')
      .sort(byUpdatedDesc)
      .slice(0, 20)
      .map(summary),
    recentDone: all
      .filter((t) => t.status === 'done')
      .sort(byUpdatedDesc)
      .slice(0, 20)
      .map(summary),
    at: nowIso(),
  };
}

/** Per-category timing rollup from the orchestration timing store (best-effort). */
export async function buildTimings(): Promise<CaTimingsPayload | null> {
  try {
    const o = await getTimingOverview();
    return {
      categories: o.stats.map((c) => ({
        category: c.category,
        count: c.count,
        totalMs: c.totalMs,
        avgMs: c.avgMs,
        p95Ms: c.p95Ms,
      })),
      taskCount: o.summary.taskCount,
      eventCount: o.summary.eventCount,
      totalMs: o.summary.totalMs,
      at: nowIso(),
    };
  } catch (err) {
    logger.debug?.('[ca-sync] timings unavailable:', err);
    return null;
  }
}
