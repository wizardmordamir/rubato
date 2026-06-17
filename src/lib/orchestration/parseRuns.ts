/**
 * Pure parser for headless-run logs (`orchestration/runs/*.jsonl`): each line is
 * the JSON emitted by `claude -p --output-format json` for one run. Tolerant by
 * design — blank lines (the drainer writes a separator between runs) and malformed
 * lines are skipped, and the token/cost/duration fields are read from several
 * shapes (`total_cost_usd`, nested `usage`, `duration_ms`, …).
 *
 * No I/O — pure `(file, text) → RunEntry[]` — so it lives in the library layer and
 * is unit-tested with a fixture JSONL. The directory read lives in
 * `src/server/orchestration.ts`.
 */

import type { RunEntry } from '../../shared/orchestration';

/** Read the first present numeric field from a record (tolerant of shape drift). */
function num(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Read the first present string field from a record. */
function str(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/** A `usage` sub-object, if the run nests its token counts there. */
function usageOf(obj: Record<string, unknown>): Record<string, unknown> {
  const u = obj.usage;
  return u && typeof u === 'object' ? (u as Record<string, unknown>) : {};
}

/** Parse one already-JSON-decoded run record into a {@link RunEntry}. */
export function runEntryFromJson(file: string, raw: unknown, at?: string): RunEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const u = usageOf(obj);

  const inputTokens = num(obj, 'input_tokens', 'inputTokens') ?? num(u, 'input_tokens', 'inputTokens');
  const outputTokens = num(obj, 'output_tokens', 'outputTokens') ?? num(u, 'output_tokens', 'outputTokens');
  const cacheCreationTokens =
    num(obj, 'cache_creation_input_tokens', 'cacheCreationTokens') ??
    num(u, 'cache_creation_input_tokens', 'cacheCreationTokens');
  const cacheReadTokens =
    num(obj, 'cache_read_input_tokens', 'cacheReadTokens') ?? num(u, 'cache_read_input_tokens', 'cacheReadTokens');

  const totalParts = [inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens].filter(
    (n): n is number => typeof n === 'number',
  );
  const totalTokens = totalParts.length ? totalParts.reduce((a, b) => a + b, 0) : undefined;

  const subtype = str(obj, 'subtype');
  const isError = obj.is_error === true || obj.isError === true || (subtype ? /error/i.test(subtype) : false);

  // For bash drain JSONL, the top-level `model` field is absent; fall back to
  // the modelUsage key with the most output tokens (the dominant/primary model).
  const modelDirect = str(obj, 'model');
  let modelResolved = modelDirect;
  if (!modelResolved) {
    const mu = obj.modelUsage;
    if (mu && typeof mu === 'object') {
      let bestId: string | undefined;
      let bestOut = -1;
      for (const [id, stats] of Object.entries(mu as Record<string, unknown>)) {
        if (stats && typeof stats === 'object') {
          const out = num(stats as Record<string, unknown>, 'outputTokens', 'output_tokens') ?? 0;
          if (out > bestOut) {
            bestOut = out;
            bestId = id;
          }
        }
      }
      modelResolved = bestId;
    }
  }

  const entry: RunEntry = {
    file,
    sessionId: str(obj, 'session_id', 'sessionId'),
    model: modelResolved,
    costUsd: num(obj, 'total_cost_usd', 'totalCostUsd', 'cost_usd', 'costUsd'),
    durationMs: num(obj, 'duration_ms', 'durationMs'),
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens,
    result: str(obj, 'result'),
    isError,
    at,
  };
  return entry;
}

/** Per-worker rollup over its parsed run entries (one drain session's runs). */
export interface WorkerRunStats {
  /** Completed tasks (entries) — equals the entry count. */
  count: number;
  /** Duration (ms) of the last completed task, when it reported one. */
  lastDurationMs?: number;
  /** Mean duration (ms) over the entries that reported a duration. */
  avgDurationMs?: number;
  /** Whether the last completed task reported an error. */
  lastTaskErrored: boolean;
  /** Count of completed tasks that reported an error. */
  errorCount: number;
  /** Summed cost (USD) over the entries that reported one. */
  totalCostUsd?: number;
}

/**
 * Roll a worker's parsed run entries (its current session's completed tasks) into
 * the headline per-worker numbers the dashboard shows: how many it finished, the
 * last/average task duration, error count, and session cost. Pure — averages and
 * sums ignore entries that didn't report the field (mirrors `aggregateStats`).
 */
export function summarizeRunEntries(entries: RunEntry[]): WorkerRunStats {
  const durations = entries.map((e) => e.durationMs).filter((d): d is number => typeof d === 'number');
  const costs = entries.map((e) => e.costUsd).filter((c): c is number => typeof c === 'number');
  const last = entries[entries.length - 1];
  const avgDurationMs = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : undefined;
  return {
    count: entries.length,
    ...(last && typeof last.durationMs === 'number' ? { lastDurationMs: last.durationMs } : {}),
    ...(avgDurationMs !== undefined ? { avgDurationMs } : {}),
    lastTaskErrored: !!last?.isError,
    errorCount: entries.filter((e) => e.isError).length,
    ...(costs.length ? { totalCostUsd: costs.reduce((a, b) => a + b, 0) } : {}),
  };
}

/**
 * Parse a whole `.jsonl` file's text into {@link RunEntry}[] (in file order).
 * Blank lines and malformed lines are skipped rather than failing the parse.
 */
export function parseRunsJsonl(file: string, text: string, at?: string): RunEntry[] {
  const out: RunEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // tolerate a partially-written final line of a live run
    }
    const entry = runEntryFromJson(file, parsed, at);
    if (entry) out.push(entry);
  }
  return out;
}
