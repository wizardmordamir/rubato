/**
 * Drainer control + history for the Taskq UI — the pieces the legacy
 * Orchestration page offered (start/stop/status + completed-task history), now
 * over the new SQLite system. Status shells out to launchd/pgrep; "run once"
 * spawns a detached drain; graceful stop toggles the `.stop` sentinel.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type TaskqDb, taskqHome } from 'cwip/taskq';
import { agentPath } from './claudeExecutor';
import { TASKQ_LAUNCHD_LABEL, taskqLaunchdPlist } from './launchd';

export interface DrainerStatus {
  /** The launchd watchdog (`com.taskq.drain`) is loaded. */
  watchdogLoaded: boolean;
  /** A drain process is running right now. */
  running: boolean;
  /** The graceful-stop sentinel (`~/.taskq/.stop`) is present. */
  stopped: boolean;
  /** Unix ms timestamp when the drain last started (from `.last-fire` stamp file). */
  lastFireMs?: number;
}

function sh(cmd: string[]): string {
  try {
    const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'ignore' });
    return r.stdout.toString();
  } catch {
    return '';
  }
}

export function drainerStatus(): DrainerStatus {
  const lastFireFile = join(taskqHome(), '.last-fire');
  let lastFireMs: number | undefined;
  if (existsSync(lastFireFile)) {
    const raw = readFileSync(lastFireFile, 'utf8').trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) lastFireMs = n;
  }
  return {
    watchdogLoaded: sh(['launchctl', 'list']).includes(TASKQ_LAUNCHD_LABEL),
    running: sh(['pgrep', '-f', 'taskqDrain']).trim().length > 0,
    stopped: existsSync(join(taskqHome(), '.stop')),
    lastFireMs,
  };
}

/** The drain entrypoint, resolved relative to this server module. */
function drainScriptPath(): string {
  return new URL('../../scripts/taskqDrain.ts', import.meta.url).pathname;
}

/** Spawn a detached drain pass now (clears any stop sentinel first). */
export function runDrainerNow(): void {
  rmSync(join(taskqHome(), '.stop'), { force: true });
  const proc = Bun.spawn([process.execPath, 'run', drainScriptPath()], {
    env: { ...process.env, PATH: agentPath() },
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  proc.unref();
}

/** Toggle the graceful-stop sentinel (workers exit between tasks when present). */
export function setDrainerStop(on: boolean): void {
  const file = join(taskqHome(), '.stop');
  if (on) writeFileSync(file, `stopped via UI ${new Date().toISOString()}\n`);
  else rmSync(file, { force: true });
}

export interface CompletionRow {
  task_id: number;
  title: string;
  repo: string | null;
  commit: string | null;
  started_at: number | null;
  ended_at: number;
  duration_s: number | null;
  summary: string | null;
  model: string | null;
  think: string | null;
  fast: number;
  body: string | null;
}

export interface TaskqHistory {
  recent: CompletionRow[];
  stats: { total: number; totalDurationS: number };
}

/** Recent completed tasks + simple aggregates (from the `completions` table + tasks JOIN for model/think). */
export function taskqHistory(db: TaskqDb, limit = 50): TaskqHistory {
  const recent = db
    .query(
      `SELECT c.task_id, c.title, c.repo, c."commit", c.started_at, c.ended_at, c.duration_s, c.summary,
              t.model, t.think, t.fast, t.body
         FROM completions c LEFT JOIN tasks t ON t.id = c.task_id
        ORDER BY c.ended_at DESC LIMIT ?`,
    )
    .all(limit) as CompletionRow[];
  const agg = db.query(`SELECT COUNT(*) AS n, COALESCE(SUM(duration_s), 0) AS d FROM completions`).get() as {
    n: number;
    d: number;
  };
  return { recent, stats: { total: agg.n, totalDurationS: agg.d } };
}

export interface LiveInstance {
  task_id: number;
  title: string;
  repo: string | null;
  model: string | null;
  think: string | null;
  fast: number;
  slug: string | null;
  group_key: string | null;
  worker_id: string;
  worktree: string | null;
  claimed_at: number;
  heartbeat_at: number;
  expires_at: number;
}

/** Currently-claimed tasks (the live worker instances), from `leases` ⋈ `tasks`. */
export function liveInstances(db: TaskqDb): LiveInstance[] {
  return db
    .query(
      `SELECT l.task_id, t.title, t.repo, t.model, t.think, t.fast, t.slug, t.group_key,
              l.worker_id, l.worktree, l.claimed_at, l.heartbeat_at, l.expires_at
         FROM leases l JOIN tasks t ON t.id = l.task_id
        ORDER BY l.claimed_at ASC`,
    )
    .all() as LiveInstance[];
}

/** Tail the watchdog log (`~/.taskq/watchdog.out`). */
export function tailWatchdogLog(lines = 200): { path: string; lines: string[] } {
  const path = join(taskqHome(), 'watchdog.out');
  try {
    const all = readFileSync(path, 'utf8').split('\n');
    return { path, lines: all.slice(-lines) };
  } catch {
    return { path, lines: [] };
  }
}

const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${TASKQ_LAUNCHD_LABEL}.plist`);

function shRun(cmd: string[]): { ok: boolean; out: string } {
  try {
    const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
    return { ok: r.exitCode === 0, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
  } catch (e) {
    return { ok: false, out: e instanceof Error ? e.message : String(e) };
  }
}

/** (Re)write the watchdog plist at the given tick interval. */
export function writeWatchdogPlist(intervalSeconds: number): void {
  const plist = taskqLaunchdPlist({
    bunPath: process.execPath,
    rubatoDir: new URL('../../../', import.meta.url).pathname,
    intervalSeconds,
    logDir: taskqHome(),
    path: agentPath(),
  });
  writeFileSync(PLIST_PATH, plist);
}

/** Read the current tick interval from the installed plist (default 300). */
export function currentInterval(): number {
  try {
    const m = readFileSync(PLIST_PATH, 'utf8').match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
    return m ? Number(m[1]) : 300;
  } catch {
    return 300;
  }
}

/** Load or unload the launchd watchdog (load (re)writes the plist first). */
export function setWatchdog(action: 'load' | 'unload'): { ok: boolean; out: string } {
  if (action === 'load') {
    if (!existsSync(PLIST_PATH)) writeWatchdogPlist(currentInterval());
    return shRun(['launchctl', 'load', PLIST_PATH]);
  }
  return shRun(['launchctl', 'unload', PLIST_PATH]);
}

/** Set the watchdog tick interval: rewrite the plist + reload it. */
export function setWatchdogInterval(seconds: number): { ok: boolean; out: string } {
  if (!Number.isInteger(seconds) || seconds < 30) throw new Error('interval must be ≥ 30 seconds');
  shRun(['launchctl', 'unload', PLIST_PATH]);
  writeWatchdogPlist(seconds);
  return shRun(['launchctl', 'load', PLIST_PATH]);
}
