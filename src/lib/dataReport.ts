/**
 * One writer for the structured data reports the information-gathering commands
 * produce. Alongside the plain `<command>.txt` capture (the terminal transcript),
 * a report command drops a sibling pair into the output dir:
 *   - `<command>.report.json` — `{ overview, rows }`, self-describing (who/when +
 *                                per-app/-branch/-entry rows), shareable across machines
 *   - `<command>.report.csv`  — the rows only, purely tabular, for spreadsheets
 *
 * Both surface automatically in the web UI "Files"/"Reports" tab (it lists the
 * whole output dir) and on the Runs page (run.ts attaches the deterministic path).
 *
 * This is the single source of truth for that format — every report command goes
 * through `emitDataReport` rather than hand-rolling its own `Bun.write`, so the
 * shape, naming, and "wrote report" note stay uniform (verifyshas/shalist were the
 * originals; the rest were retrofitted onto this).
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Row, toCsv } from './output';
import { ensureOutputDir, resolveOutputDir } from './runStore';

/** Self-describing header for a report's JSON (the CSV stays purely tabular). */
export interface DataReportOverview {
  /** The command that produced the report — also the default file base name. */
  command: string;
  /** ISO timestamp for when the gathering started. */
  generatedAt: string;
  /** Wall-clock duration of the run, in ms. */
  durationMs?: number;
  /** The args the command ran with, so the report explains its own scope. */
  args?: string[];
  /** Correlation id tying the report to its diagnostic log, when one was opened. */
  correlationId?: string;
  /** Per-command summary stats — counts, totals, the filters applied, etc. */
  summary?: Record<string, unknown>;
}

export interface DataReport {
  overview: DataReportOverview;
  /** One object per row — the per-app / per-branch / per-entry data. */
  rows: Row[];
  /** Column order for the CSV (and a stable key set). Inferred from rows when omitted. */
  columns?: string[];
}

export interface DataReportPaths {
  /** Absolute path to the `<base>.report.json` file. */
  jsonPath: string;
  /** Absolute path to the `<base>.report.csv` file. */
  csvPath: string;
}

/** The infix that marks a structured report file (`<base>.report.json|csv`). */
export const REPORT_SUFFIX = '.report';

/** The conventional report file base for a command (sits next to `<command>.txt`). */
export function reportBase(command: string): string {
  return command.replace(/[^a-zA-Z0-9._-]/g, '_') || 'report';
}

/**
 * Write a command's data report as the `<base>.report.json` + `<base>.report.csv`
 * pair into the output dir (or `opts.outDir`). `base` defaults to the command
 * name. Returns the absolute paths. Throws on a write failure — call sites that
 * must never fail the command use `emitDataReport` instead.
 */
export async function writeDataReport(
  report: DataReport,
  opts: { outDir?: string; base?: string } = {},
): Promise<DataReportPaths> {
  const dir = opts.outDir ?? (await ensureOutputDir());
  const stem = resolve(dir, `${reportBase(opts.base ?? report.overview.command)}${REPORT_SUFFIX}`);
  const jsonPath = `${stem}.json`;
  const csvPath = `${stem}.csv`;
  await Bun.write(jsonPath, `${JSON.stringify({ overview: report.overview, rows: report.rows }, null, 2)}\n`);
  await Bun.write(csvPath, `${toCsv(report.rows, report.columns)}\n`);
  return { jsonPath, csvPath };
}

/**
 * Best-effort `writeDataReport` for read-only report commands: writes the pair,
 * prints a one-line note to **stderr** (so piped stdout stays clean for `--json`/
 * `--csv`), and swallows any failure — a report must never break the command it
 * describes. Returns the paths, or null if writing failed.
 */
export async function emitDataReport(
  report: DataReport,
  opts: { err?: (line: string) => void; outDir?: string; base?: string } = {},
): Promise<DataReportPaths | null> {
  const err = opts.err ?? ((l: string) => console.error(l));
  try {
    const paths = await writeDataReport(report, { outDir: opts.outDir, base: opts.base });
    err(`📄 report: ${paths.jsonPath} (+ .csv)`);
    return paths;
  } catch (e) {
    err(`(could not write report: ${e instanceof Error ? e.message : e})`);
    return null;
  }
}

/** Slack (ms) on the freshness check below — covers filesystem mtime granularity. */
const FRESH_SLACK_MS = 2_000;

/**
 * The path to `<command>.report.json` in the output dir, but only if it exists AND
 * was (re)written at/after `sinceMs` — so a run that produced no report doesn't
 * get linked to a stale one left by an earlier run of the same command. Used by
 * the run recorders (run.ts / run-capture.ts) to attach the deterministic path a
 * report command's subprocess just wrote. Returns undefined when there's none.
 */
export async function reportPathForRun(command: string, sinceMs: number): Promise<string | undefined> {
  try {
    const jsonPath = resolve(await resolveOutputDir(), `${reportBase(command)}${REPORT_SUFFIX}.json`);
    const st = await stat(jsonPath);
    return st.mtimeMs >= sinceMs - FRESH_SLACK_MS ? jsonPath : undefined;
  } catch {
    return undefined; // no report dir / no file for this command
  }
}
