/**
 * Pure aggregation over parsed history + runs — the numbers behind the
 * Orchestration page's stat cards (total tasks, total/avg duration, total tokens,
 * total cost, per-repo breakdown).
 *
 * No I/O — pure `(HistoryEntry[], RunEntry[]) → OrchestrationStats` — so it lives
 * in the library layer and is unit-tested with fixtures.
 */

import type { HistoryEntry, OrchestrationStats, RepoStat, RunEntry } from '../../shared/orchestration';

/** Sum a list of numbers, treating `undefined` as 0. */
function sum(nums: (number | undefined)[]): number {
  return nums.reduce<number>((acc, n) => acc + (typeof n === 'number' ? n : 0), 0);
}

/** Round a USD figure to cents (so a long float doesn't render as `$1.2300000004`). */
function roundUsd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Aggregate completed-task history + headless-run logs into the page's stat block.
 * Duration averages over only the entries that actually carried a duration (so a
 * title-only manual entry doesn't drag the average to zero). Per-repo rollup is
 * keyed off each history entry's parsed `repo`, sorted by task count desc.
 */
export function aggregateStats(history: HistoryEntry[], runs: RunEntry[]): OrchestrationStats {
  const totalTasks = history.length;
  const withDuration = history.filter((h) => typeof h.durationSeconds === 'number');
  const totalDurationSeconds = sum(withDuration.map((h) => h.durationSeconds));
  const avgDurationSeconds = withDuration.length ? Math.round(totalDurationSeconds / withDuration.length) : 0;

  const totalTokens = sum(runs.map((r) => r.totalTokens));
  const totalCostUsd = roundUsd(sum(runs.map((r) => r.costUsd)));

  const byRepoMap = new Map<string, RepoStat>();
  for (const h of history) {
    if (!h.repo) continue;
    const stat = byRepoMap.get(h.repo) ?? { repo: h.repo, tasks: 0, durationSeconds: 0 };
    stat.tasks += 1;
    stat.durationSeconds += h.durationSeconds ?? 0;
    byRepoMap.set(h.repo, stat);
  }
  const byRepo = [...byRepoMap.values()].sort((a, b) => b.tasks - a.tasks || b.durationSeconds - a.durationSeconds);

  return {
    totalTasks,
    totalDurationSeconds,
    avgDurationSeconds,
    totalTokens,
    totalCostUsd,
    totalRuns: runs.length,
    byRepo,
  };
}
