/**
 * Background poller for REAL Claude Code usage telemetry — the live counterpart
 * to the estimated rolling-window buckets in cwip/taskq usage.ts.
 *
 * Two independent sources, each cached with graceful fallback to the last good
 * snapshot when the underlying command fails:
 *
 *  1. `claude -p "/usage"`  → subscription limits + behavioral diagnostics
 *     (parsed by cwip's parseClaudeUsageText). On success the three limit tiers
 *     AUTO-CALIBRATE the matching usage buckets (session_5h / weekly_total /
 *     weekly_sonnet) via the existing calibrateBucket — so the bars AND the
 *     drain throttle run on real numbers, with the AIMD estimate surviving as
 *     the fallback whenever polling fails.
 *  2. `bunx ccusage daily --json` → per-day token + cost breakdown.
 *
 * Follows the single-flight + idempotent-timer pattern of forge.ts. The snapshot
 * is persisted to ~/.taskq/usage-cache.json so a restart keeps the last reading
 * (downgraded to `fallback` until the next live poll).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ComprehensiveClaudeReport,
  calibrateBucket,
  parseCcusageJson,
  parseClaudeUsageText,
  parseUsageResetAt,
  percentToFraction,
  stripAnsi,
  TIER_TO_BUCKET,
  taskqHome,
} from 'cwip/taskq';
import type { TaskqUsageSnapshot } from '../../shared/taskq';
import { getTaskqDb } from '../taskqDb';
import { agentPath } from './claudeExecutor';
import { loadTaskqConfig } from './config';

const SPAWN_TIMEOUT_MS = 90_000;

const snapshot: TaskqUsageSnapshot = {
  telemetry: null,
  telemetryAt: null,
  telemetryStatus: 'never',
  cost: null,
  costAt: null,
  costStatus: 'never',
};

let loadedFromDisk = false;

function cacheFile(): string {
  return join(taskqHome(), 'usage-cache.json');
}

/** Return the current in-memory usage snapshot for the API layer. */
export function getUsageSnapshot(): TaskqUsageSnapshot {
  return { ...snapshot };
}

/** Run a command, capturing stdout, with a hard timeout (killed → exitCode -1). */
async function spawnCapture(cmd: string[]): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'ignore',
    env: { ...process.env, PATH: agentPath() },
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, SPAWN_TIMEOUT_MS);
  try {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout };
  } finally {
    clearTimeout(timer);
  }
}

async function persist(): Promise<void> {
  try {
    await mkdir(taskqHome(), { recursive: true });
    await writeFile(cacheFile(), JSON.stringify(snapshot), 'utf8');
  } catch {
    // cache persistence is best-effort
  }
}

/** Load the last persisted snapshot on boot (status held at `fallback` — stale). */
async function loadCache(): Promise<void> {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    const text = await readFile(cacheFile(), 'utf8');
    const prev = JSON.parse(text) as TaskqUsageSnapshot;
    if (prev.telemetry) {
      snapshot.telemetry = prev.telemetry;
      snapshot.telemetryAt = prev.telemetryAt ?? null;
      snapshot.telemetryStatus = 'fallback';
    }
    if (prev.cost) {
      snapshot.cost = prev.cost;
      snapshot.costAt = prev.costAt ?? null;
      snapshot.costStatus = 'fallback';
    }
  } catch {
    // no cache yet — start cold
  }
}

/**
 * Auto-calibrate the three usage buckets from the live `/usage` percentages +
 * reset times. Mirrors a manual calibration, but driven by real telemetry.
 */
function calibrateFromTelemetry(report: ComprehensiveClaudeReport, now: number): void {
  const db = getTaskqDb();
  for (const tier of Object.keys(TIER_TO_BUCKET) as (keyof typeof TIER_TO_BUCKET)[]) {
    const metric = report.limits[tier];
    const fraction = percentToFraction(metric.percentUsed);
    if (fraction === null) continue; // unparseable — leave the estimate alone
    calibrateBucket(db, TIER_TO_BUCKET[tier], {
      consumedFraction: fraction,
      at: now,
      resetAt: parseUsageResetAt(metric.resetsAt, now),
    });
  }
}

/** Poll `claude -p "/usage"`, parse, cache, and auto-calibrate buckets. */
export async function pollTelemetry(): Promise<void> {
  try {
    const { exitCode, stdout } = await spawnCapture(['claude', '-p', '/usage']);
    const report = parseClaudeUsageText(stripAnsi(stdout));
    // Guard against a non-/usage response (e.g. an error or permission prompt):
    // require at least one parsed limit tier before trusting it.
    const gotData = report.limits.currentSession.percentUsed !== 'Unknown';
    if (exitCode !== 0 || !gotData) {
      snapshot.telemetryStatus = snapshot.telemetry ? 'fallback' : 'never';
      snapshot.telemetryError = `usage poll failed (exit ${exitCode})`;
      return;
    }
    const now = Date.now();
    snapshot.telemetry = report;
    snapshot.telemetryAt = now;
    snapshot.telemetryStatus = 'live';
    snapshot.telemetryError = undefined;
    try {
      calibrateFromTelemetry(report, now);
    } catch {
      // calibration is opportunistic — never fail the poll over it
    }
    await persist();
  } catch (e) {
    snapshot.telemetryStatus = snapshot.telemetry ? 'fallback' : 'never';
    snapshot.telemetryError = e instanceof Error ? e.message : 'usage poll error';
  }
}

/** Poll `bunx ccusage daily --json`, parse, cache. */
export async function pollCost(): Promise<void> {
  try {
    const { exitCode, stdout } = await spawnCapture(['bunx', 'ccusage', 'daily', '--json']);
    const report = exitCode === 0 ? parseCcusageJson(stdout) : null;
    if (!report) {
      snapshot.costStatus = snapshot.cost ? 'fallback' : 'never';
      snapshot.costError = `ccusage failed (exit ${exitCode})`;
      return;
    }
    snapshot.cost = report;
    snapshot.costAt = Date.now();
    snapshot.costStatus = 'live';
    snapshot.costError = undefined;
    await persist();
  } catch (e) {
    snapshot.costStatus = snapshot.cost ? 'fallback' : 'never';
    snapshot.costError = e instanceof Error ? e.message : 'ccusage error';
  }
}

/** Run both polls once (manual "Refresh now"). Returns the fresh snapshot. */
export async function refreshUsageNow(): Promise<TaskqUsageSnapshot> {
  await loadCache();
  await Promise.all([pollTelemetry(), pollCost()]);
  return getUsageSnapshot();
}

let telemetryTimer: ReturnType<typeof setInterval> | null = null;
let costTimer: ReturnType<typeof setInterval> | null = null;
let telemetryBusy = false;
let costBusy = false;

async function telemetryTick(): Promise<void> {
  if (telemetryBusy) return;
  telemetryBusy = true;
  try {
    await pollTelemetry();
  } catch (e) {
    console.error('[usage] telemetry tick failed:', e);
  } finally {
    telemetryBusy = false;
  }
}

async function costTick(): Promise<void> {
  if (costBusy) return;
  costBusy = true;
  try {
    await pollCost();
  } catch (e) {
    console.error('[usage] cost tick failed:', e);
  } finally {
    costBusy = false;
  }
}

let started = false;

/** (Re)schedule one loop from a minutes setting. 0/negative ⇒ disabled (timer cleared). */
function reschedule(
  current: ReturnType<typeof setInterval> | null,
  minutes: number,
  tick: () => void,
): ReturnType<typeof setInterval> | null {
  if (current) clearInterval(current);
  if (!Number.isFinite(minutes) || minutes <= 0) return null; // off / manual-only
  return setInterval(tick, minutes * 60_000);
}

/**
 * Apply the current config's poll intervals to the live timers — call after a
 * config save so interval changes (including enabling/disabling a source) take
 * effect without a restart. Kicks an immediate tick for a source that was off
 * and is now enabled, so the user sees data right away.
 */
export function applyUsagePollConfig(): void {
  const cfg = loadTaskqConfig();
  const telemetryWasOff = telemetryTimer === null;
  const costWasOff = costTimer === null;
  telemetryTimer = reschedule(telemetryTimer, cfg.usagePollMinutes, () => void telemetryTick());
  costTimer = reschedule(costTimer, cfg.usageCostPollMinutes, () => void costTick());
  if (started && telemetryWasOff && telemetryTimer) void telemetryTick();
  if (started && costWasOff && costTimer) void costTick();
}

/**
 * Start the background usage poller: load the last cache, do an immediate first
 * pass, then poll `/usage` + ccusage on the config-driven intervals (defaults
 * 5 min / 30 min; 0 disables a source). Idempotent — calling twice is a no-op.
 * `opts` overrides the interval (minutes) for tests; omit to read config.
 */
export function startUsagePoller(opts: { telemetryMinutes?: number; costMinutes?: number } = {}): void {
  if (started) return;
  started = true;
  const cfg = loadTaskqConfig();
  const telemetryMin = opts.telemetryMinutes ?? cfg.usagePollMinutes;
  const costMin = opts.costMinutes ?? cfg.usageCostPollMinutes;
  void loadCache().then(() => {
    if (telemetryMin > 0) void telemetryTick();
    if (costMin > 0) void costTick();
  });
  telemetryTimer = reschedule(telemetryTimer, telemetryMin, () => void telemetryTick());
  costTimer = reschedule(costTimer, costMin, () => void costTick());
}
