/**
 * Server layer for the Orchestration Processing page — ingest the orchlog
 * recorder's per-category timing files into SQLite and build the analytics
 * snapshot from the stored rows.
 *
 * The source files are `<notesDir>/orchestration/runs/timing-*.jsonl`, emitted by
 * the `orchlog` recorder (___Agent_Workspace/orchestration/orchlog.ts). Parsing is
 * cwip/orchestration's `parseTimingJsonl` (tolerant — never throws); the per-category
 * math is cwip's `aggregateByCategory`/`summarize`, so the canonical taxonomy +
 * statistics are the single source of truth (this app only owns the fs read + DB +
 * the wire shaping). Ingesting into SQLite (idempotent by `event_id`) means the
 * JSONL files can be deleted later while the analytics survive.
 *
 * Safety: the only client-influenced inputs are the query filters (epoch-ms bounds +
 * a repo string) — never a path. The directory read is fixed to the resolved notes
 * dir's `orchestration/runs/`, and only `timing-*.jsonl` basenames are read, so
 * there is no path-traversal surface (mirrors systemFiles.ts's derived-path rule).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { aggregateByCategory, labelForCategory, parseTimingJsonl, summarize } from 'cwip/orchestration';
import {
  bucketTimingTrend,
  type CategoryStat,
  type TimingIngestResult,
  type TimingOverview,
  type TimingRow,
} from '../shared/orchestration';
import {
  clearTimings,
  insertTimingEvents,
  listTimingEvents,
  listTimingEventsInWindow,
  listTimingRepos,
  listTimingRows,
  listTimingSources,
  type TimingQuery,
} from './db';
import { notesDir } from './orchestration';

/** How many rows the table view surfaces (newest first); aggregation uses all rows. */
const MAX_ROWS = 500;

/** The `orchestration/runs/` directory under the resolved notes dir. */
async function runsDir(): Promise<string> {
  return join(await notesDir(), 'orchestration', 'runs');
}

/** Only `timing-*.jsonl` basenames are ingestable (the orchlog recorder's output). */
function isTimingFile(name: string): boolean {
  return name.startsWith('timing-') && name.endsWith('.jsonl');
}

/**
 * Read every `timing-*.jsonl` under `orchestration/runs/`, parse with cwip's tolerant
 * parser, and idempotently insert each event (INSERT OR IGNORE by `event_id`). The
 * directory may not exist yet (no run logged) — that's a clean zero result, not an
 * error. Returns the files read + total inserted/skipped across them.
 */
export async function ingestTimings(): Promise<TimingIngestResult> {
  const dir = await runsDir();
  let names: string[];
  try {
    names = (await readdir(dir)).filter(isTimingFile);
  } catch {
    return { filesRead: 0, inserted: 0, skipped: 0 };
  }

  let filesRead = 0;
  let inserted = 0;
  let skipped = 0;
  for (const name of names.sort()) {
    const abs = join(dir, name);
    let text: string;
    try {
      // Skip directories that happen to match the name pattern; read files only.
      if (!(await stat(abs)).isFile()) continue;
      text = await readFile(abs, 'utf8');
    } catch {
      continue; // unreadable file — skip, don't fail the whole ingest
    }
    filesRead += 1;
    const events = parseTimingJsonl(text);
    const res = insertTimingEvents(events, abs);
    inserted += res.inserted;
    skipped += res.skipped;
  }
  return { filesRead, inserted, skipped };
}

/** Per-category stats from cwip, widened to the pure wire `CategoryStat`. */
function toCategoryStats(events: Parameters<typeof aggregateByCategory>[0]): CategoryStat[] {
  // cwip's CategoryStat is structurally identical to the wire type (CategoryKey/
  // GroupKey are string literal unions), so this is a safe widening.
  return aggregateByCategory(events) as unknown as CategoryStat[];
}

/**
 * Build the whole Orchestration Processing snapshot for the (optional) filters:
 * load the filtered rows from the DB, map to cwip `TimingEvent[]`, and run the
 * shared aggregators. Returns per-category stats, a high-level summary, the
 * duration trend (bucketed over time), the recent rows for the table, the source
 * files, and the repo list.
 */
export async function getTimingOverview(q: TimingQuery = {}): Promise<TimingOverview> {
  const dir = await runsDir();
  const events = listTimingEvents(q);
  const stats = toCategoryStats(events);
  const summary = summarize(events);
  // Trend excludes kind:'task' summary rows (per-task wall-clock totals, not work),
  // matching how the aggregators treat them.
  const trend = bucketTimingTrend(
    events.filter((e) => e.kind !== 'task').map((e) => ({ ts: e.ts, durationMs: e.duration_ms })),
  );

  // Table rows come straight from the DB (newest first, capped) so each carries its
  // own `source_file` for the per-row editor deep link.
  const rows: TimingRow[] = listTimingRows(q, MAX_ROWS).map((r) => ({
    ...r,
    label: labelForCategory(r.category),
  }));

  return {
    notesDir: await notesDir(),
    runsDir: dir,
    stats,
    summary,
    trend,
    rows,
    sources: listTimingSources(),
    repos: listTimingRepos(),
    total: events.length,
  };
}

/**
 * Return per-category stats for one history entry, matched by time-window overlap.
 * The `ts` of each orchlog event is compared against `[startIso, endIso]` — events
 * whose timestamp falls within the entry's wall-clock range are included. Returns []
 * when the ISO strings are invalid or no events match (shown as "no timing recorded").
 */
export function getEntryCategoryStats(startIso: string, endIso: string, repo?: string): CategoryStat[] {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  const events = listTimingEventsInWindow(startMs, endMs, repo);
  return toCategoryStats(events);
}

/** Delete stored timings (all, or `ts < before`). Returns how many were removed. */
export function clearStoredTimings(before?: number): { deleted: number } {
  return { deleted: clearTimings(before) };
}
