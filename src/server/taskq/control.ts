/**
 * Drainer control + history for the Taskq UI — the pieces the legacy
 * Orchestration page offered (start/stop/status + completed-task history), now
 * over the new SQLite system. Status shells out to launchd/pgrep; "run now"
 * spawns a detached drain; graceful stop toggles the `.stop` sentinel.
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TaskqDb, taskqHome } from 'cwip/taskq';
import { TASKQ_LAUNCHD_LABEL } from './launchd';
import { agentPath } from './claudeExecutor';

export interface DrainerStatus {
  /** The launchd watchdog (`com.taskq.drain`) is loaded. */
  watchdogLoaded: boolean;
  /** A drain process is running right now. */
  running: boolean;
  /** The graceful-stop sentinel (`~/.taskq/.stop`) is present. */
  stopped: boolean;
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
  return {
    watchdogLoaded: sh(['launchctl', 'list']).includes(TASKQ_LAUNCHD_LABEL),
    running: sh(['pgrep', '-f', 'taskqDrain']).trim().length > 0,
    stopped: existsSync(join(taskqHome(), '.stop')),
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
  ended_at: number;
  duration_s: number | null;
  summary: string | null;
}

export interface TaskqHistory {
  recent: CompletionRow[];
  stats: { total: number; totalDurationS: number };
}

/** Recent completed tasks + simple aggregates (from the `completions` table). */
export function taskqHistory(db: TaskqDb, limit = 50): TaskqHistory {
  const recent = db
    .query(
      `SELECT task_id, title, repo, "commit" AS commit, ended_at, duration_s, summary
         FROM completions ORDER BY ended_at DESC LIMIT ?`,
    )
    .all(limit) as CompletionRow[];
  const agg = db.query(`SELECT COUNT(*) AS n, COALESCE(SUM(duration_s), 0) AS d FROM completions`).get() as {
    n: number;
    d: number;
  };
  return { recent, stats: { total: agg.n, totalDurationS: agg.d } };
}
