/**
 * Multi-target automation fan-out (pipelines use-case 7) + variable MATRIX runs
 * (the "deploy dozens of apps, each with its own params" half of task 42). Pure
 * planning — turns a run request into a list of run specs — so the route just maps
 * `runAutomationHeadless` over them and the logic is testable without a browser.
 * Each spec gets its own browser context/window, so `keepOpen` (headed) leaves
 * every tab open. Zero engine changes: a run can override the automation's
 * `startUrl` and inject per-run variables for templated (`${VAR}`) steps.
 *
 * Two fan-out modes (a request uses at most one; `rows` wins if both are present):
 *  - `urls`: one run per URL — overrides `startUrl`, injects `TARGET_URL`.
 *  - `rows`: one run per row of variables — merges the row over `variables`; a
 *    reserved `url` column also overrides `startUrl` + sets `TARGET_URL`. This is
 *    "run this deploy automation for each app, each entering its own task / version
 *    / sha / pipeline-type", driven from a pasted CSV/JSON of per-app params.
 */

import type { Automation } from '../shared/automation';
import type { RunSpeed } from '../shared/pacing';

/** Cap concurrent runs so a huge list can't spawn unbounded browsers. */
export const MAX_PARALLEL_TARGETS = 10;

/** Reserved row column: overrides that run's startUrl (and becomes TARGET_URL). */
export const ROW_URL_KEY = 'url';

export interface RunSpec {
  automation: Automation;
  headless: boolean;
  keepOpen: boolean;
  variables: Record<string, string>;
  /** Run-time pacing: slow the run so it can be watched. */
  speed: RunSpeed;
  /** The URL this run targets (undefined for a plain single run). */
  targetUrl?: string;
}

export interface RunRequest {
  headless?: boolean;
  keepOpen?: boolean;
  variables?: Record<string, string>;
  /** Run-time pacing (slow a headed run so it can be watched); defaults to off. */
  speed?: RunSpeed;
  /** When present + non-empty, fan the automation out across these URLs. */
  urls?: unknown;
  /** When present + non-empty, fan out one run per row of variables (a matrix). */
  rows?: unknown;
}

const cleanUrls = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean) : [];

/** Coerce arbitrary input into an array of string→string variable rows (dropping empties). */
const cleanRows = (raw: unknown): Record<string, string>[] => {
  if (!Array.isArray(raw)) return [];
  const rows: Record<string, string>[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      const key = k.trim();
      if (key) row[key] = v == null ? '' : String(v);
    }
    if (Object.keys(row).length > 0) rows.push(row);
  }
  return rows;
};

/** Apply the cap, returning the kept items + how many were dropped. */
const cap = <T>(items: T[]): { taken: T[]; skipped: number } => ({
  taken: items.slice(0, MAX_PARALLEL_TARGETS),
  skipped: Math.max(0, items.length - MAX_PARALLEL_TARGETS),
});

/**
 * Plan the run(s) for a request. No `urls`/`rows` → one plain run. `rows` → one run
 * per variable row (a matrix; `url` column overrides startUrl). Else `urls` → one
 * run per URL. All capped at MAX_PARALLEL_TARGETS; `skipped` counts the dropped
 * extras. The base automation is never mutated.
 */
export function planAutomationRuns(automation: Automation, req: RunRequest): { specs: RunSpec[]; skipped: number } {
  const headless = req.headless ?? true;
  const keepOpen = req.keepOpen ?? false;
  const speed: RunSpeed = req.speed ?? 'off';
  const baseVars = req.variables ?? {};

  // Matrix mode: one run per row of per-app variables.
  const rows = cleanRows(req.rows);
  if (rows.length > 0) {
    const { taken, skipped } = cap(rows);
    const specs: RunSpec[] = taken.map((row) => {
      const { [ROW_URL_KEY]: url, ...rowVars } = row;
      const target = typeof url === 'string' && url.trim() !== '' ? url.trim() : undefined;
      return {
        automation: target ? { ...automation, startUrl: target } : automation,
        headless,
        keepOpen,
        speed,
        variables: target ? { ...baseVars, ...rowVars, TARGET_URL: target } : { ...baseVars, ...rowVars },
        targetUrl: target,
      };
    });
    return { specs, skipped };
  }

  // URL fan-out mode.
  const urls = cleanUrls(req.urls);
  if (urls.length === 0) {
    return { specs: [{ automation, headless, keepOpen, speed, variables: baseVars }], skipped: 0 };
  }
  const { taken, skipped } = cap(urls);
  const specs: RunSpec[] = taken.map((url) => ({
    automation: { ...automation, startUrl: url },
    headless,
    keepOpen,
    speed,
    variables: { ...baseVars, TARGET_URL: url },
    targetUrl: url,
  }));
  return { specs, skipped };
}
