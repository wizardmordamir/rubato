/**
 * Drain self-healer — detect + fix stalled orchestration states.
 *
 * Covers the four stall classes the `drainGuard.sh` shell script handled, now
 * in testable TypeScript with proper dependency injection:
 *
 *  1. **cwip dist missing**: a worker task's `bun run clean` on the cwip checkout
 *     (or a worktree `bun i`) can wipe `dist/` — the drain's `cwip/taskq` import
 *     then fails on the NEXT launchd tick (silent crash-loop). Fix: rebuild cwip.
 *
 *  2. **First-party symlink broken**: a bare `bun i` in the rubato root reverts
 *     the cwip symlink to a registry copy (or nothing, since cwip isn't published).
 *     Fix: run `bun run relink` — NOT `bun link cwip` (the CLAUDE.md convention).
 *
 *  3. **Drain stalled**: `watchdog.out` not updated in > 5 min while tasks are
 *     waiting AND no worker has a fresh heartbeat (fresh = within 3 min). A fresh
 *     heartbeat means the drain is alive and busy — restarting would duplicate it.
 *     Fix: `launchctl kickstart` the drain agent.
 *
 *  4. **Expired leases not reaped**: tasks stuck in `claimed` after their lease
 *     expired — normally the drain reaps them on startup, but if the drain is down
 *     they stay stranded. Fix: call `reapExpired` directly so the tasks become
 *     `ready` again and the next drain pass picks them up.
 *
 * All four run as one `runHealer()` call that returns a structured report.
 * Each check is independently injectable so tests drive it without real disk/DB.
 */

import { spawnSync } from 'node:child_process';
import { lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { reapExpired, type TaskqDb, taskqHome } from 'cwip/taskq';
import { agentPath } from './claudeExecutor';

// ── Result types ────────────────────────────────────────────────────────────

/** One detected issue and whether it was automatically fixed. */
export interface HealerIssue {
  /** Short machine-readable code. */
  code: HealerIssueCode;
  /** Human description of what was detected. */
  description: string;
  /** Whether the healer was able to fix it automatically. */
  fixed: boolean;
  /** Detail from the fix attempt (error message on failure). */
  detail?: string;
}

export type HealerIssueCode = 'cwip-dist-missing' | 'symlink-broken' | 'drain-stalled' | 'leases-expired';

/** Full result of one healer run. */
export interface HealerResult {
  /** ISO timestamp of when this run started. */
  ranAt: string;
  /** Number of distinct issues detected (includes those fixed and those not fixed). */
  issuesFound: number;
  /** Number of issues automatically fixed. */
  issuesFixed: number;
  /** Per-issue details. */
  issues: HealerIssue[];
  /**
   * True when at least one check could not be run (e.g. DB unavailable).
   * An inconclusive result is NOT "healthy" — it means we couldn't assess.
   */
  inconclusive: boolean;
}

// ── Injectable dependencies ──────────────────────────────────────────────────

export interface HealerDeps {
  /** Wall-clock now in ms (injectable for tests). */
  now(): number;
  /**
   * Does a path exist AND is it a symlink?
   * Distinct from `existsSync` — a directory entry that is NOT a symlink means
   * the first-party dep was installed from the registry (wrong) or is missing.
   */
  isSymlink(path: string): boolean;
  /** Does `path` exist as a regular file? */
  fileExists(path: string): boolean;
  /** mtime of `path` in epoch-ms, or undefined when it doesn't exist. */
  mtimeMs(path: string): number | undefined;
  /**
   * Reap expired leases in the DB and return the count.
   * Pass `undefined` when the DB is unavailable (check skipped).
   */
  reapLeases(): { reaped: number } | 'unavailable';
  /** Run `bun run build` in `cwipDir`. Returns exit code + combined output. */
  buildCwip(cwipDir: string): { code: number; out: string };
  /** Run `bun run relink` in `ruDir`. Returns exit code + combined output. */
  relink(ruDir: string): { code: number; out: string };
  /**
   * Kick the drain via launchd (`launchctl kickstart gui/<uid>/com.taskq.drain`).
   * Returns exit code + combined output.
   */
  kickDrain(): { code: number; out: string };
  /** Active workers with a fresh heartbeat (within freshHbMs of now). */
  freshHeartbeatCount(freshHbMs: number): number | 'unavailable';
  /** Total lease count (regardless of freshness). */
  leaseCount(): number | 'unavailable';
}

// How stale watchdog.out must be (ms) before we consider the drain stalled.
const STALE_OUTPUT_MS = 5 * 60_000; // 5 min
// A longer stale window where we restart even if no leases exist (drain just stopped).
const VERY_STALE_OUTPUT_MS = 15 * 60_000; // 15 min
// Within this window a heartbeat is "fresh" (worker is alive).
const FRESH_HB_MS = 3 * 60_000; // 3 min

// ── Core healer logic (pure-ish, injectable) ──────────────────────────────────

/**
 * Run all stall checks and apply fixes. Returns a structured result.
 * Exceptions from individual checks are caught and recorded as `inconclusive`
 * so a single broken check can't prevent the others from running.
 */
export function runHealer(deps: HealerDeps, opts: HealerOpts = {}): HealerResult {
  const { cwipDir, ruDir } = resolveOpts(opts);
  const issues: HealerIssue[] = [];
  let inconclusive = false;
  const now = deps.now();

  // ── 1. cwip dist ─────────────────────────────────────────────────────────
  try {
    const distIndex = join(cwipDir, 'dist', 'services', 'taskq', 'index.js');
    if (!deps.fileExists(distIndex)) {
      const fix = deps.buildCwip(cwipDir);
      issues.push({
        code: 'cwip-dist-missing',
        description: 'cwip dist/services/taskq/index.js missing — drain cannot import cwip/taskq',
        fixed: fix.code === 0,
        detail: fix.code !== 0 ? fix.out.trim().slice(0, 500) : undefined,
      });
    }
  } catch (e) {
    inconclusive = true;
    issues.push({
      code: 'cwip-dist-missing',
      description: 'cwip dist check failed (inconclusive)',
      fixed: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // ── 2. First-party symlink ────────────────────────────────────────────────
  try {
    const cwipLink = join(ruDir, 'node_modules', 'cwip');
    if (!deps.isSymlink(cwipLink)) {
      const fix = deps.relink(ruDir);
      issues.push({
        code: 'symlink-broken',
        description: `${cwipLink} is not a symlink — first-party cwip dep may be stale/absent`,
        fixed: fix.code === 0,
        detail: fix.code !== 0 ? fix.out.trim().slice(0, 500) : undefined,
      });
    }
  } catch (e) {
    inconclusive = true;
    issues.push({
      code: 'symlink-broken',
      description: 'symlink check failed (inconclusive)',
      fixed: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // ── 3. Drain stall ────────────────────────────────────────────────────────
  try {
    const watchdogOut = join(taskqHome(), 'watchdog.out');
    const mtime = deps.mtimeMs(watchdogOut);
    if (mtime !== undefined) {
      const ageMs = now - mtime;
      if (ageMs > STALE_OUTPUT_MS) {
        // Don't restart if workers have a fresh heartbeat — they're alive.
        const fresh = deps.freshHeartbeatCount(FRESH_HB_MS);
        if (fresh !== 'unavailable' && fresh > 0) {
          // Drain alive (workers heartbeating) — no action needed, just log.
        } else {
          const leases = deps.leaseCount();
          const shouldRestart = leases === 'unavailable' || leases > 0 || ageMs > VERY_STALE_OUTPUT_MS;
          if (shouldRestart) {
            const fix = deps.kickDrain();
            issues.push({
              code: 'drain-stalled',
              description: `drain output stale (${Math.round(ageMs / 60_000)}min), no fresh heartbeats — drain may be stuck`,
              fixed: fix.code === 0,
              detail: fix.code !== 0 ? fix.out.trim().slice(0, 500) : undefined,
            });
          }
        }
      }
    }
  } catch (e) {
    inconclusive = true;
    issues.push({
      code: 'drain-stalled',
      description: 'drain stall check failed (inconclusive)',
      fixed: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // ── 4. Expired leases ─────────────────────────────────────────────────────
  try {
    const result = deps.reapLeases();
    if (result !== 'unavailable' && result.reaped > 0) {
      issues.push({
        code: 'leases-expired',
        description: `${result.reaped} lease(s) expired — tasks were stuck in 'claimed' and have been re-queued`,
        fixed: true,
      });
    }
  } catch (e) {
    inconclusive = true;
    issues.push({
      code: 'leases-expired',
      description: 'expired lease check failed (inconclusive)',
      fixed: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  return {
    ranAt: new Date(now).toISOString(),
    issuesFound: issues.length,
    issuesFixed: issues.filter((i) => i.fixed).length,
    issues,
    inconclusive,
  };
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface HealerOpts {
  /** cwip checkout root (defaults to `~/code/github/cwip`). */
  cwipDir?: string;
  /** rubato checkout root (defaults to this file's repo root). */
  ruDir?: string;
}

function resolveOpts(opts: HealerOpts): Required<HealerOpts> {
  const { homedir } = require('node:os') as typeof import('node:os');
  const home = homedir();
  return {
    cwipDir: opts.cwipDir ?? join(home, 'code', 'github', 'cwip'),
    ruDir: opts.ruDir ?? rubatoDir(),
  };
}

/** The rubato repo root (this file's project), derived from import.meta.url. */
function rubatoDir(): string {
  // src/server/taskq/drainHealer.ts → three levels up = repo root
  return new URL('../../../', import.meta.url).pathname;
}

// ── Real default dependencies ─────────────────────────────────────────────────

function sh(args: string[], cwd: string): { code: number; out: string } {
  try {
    const r = spawnSync(args[0], args.slice(1), {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: agentPath() } as NodeJS.ProcessEnv,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } catch (e) {
    return { code: 1, out: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Build the real {@link HealerDeps} that drive the production healer.
 * Pass a `db` to enable the lease-reap check; omit to skip it (e.g. when
 * the server hasn't opened the DB yet).
 */
export function makeHealerDeps(db?: TaskqDb): HealerDeps {
  return {
    now: () => Date.now(),
    isSymlink: (path) => {
      try {
        return lstatSync(path).isSymbolicLink();
      } catch {
        return false;
      }
    },
    fileExists: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    mtimeMs: (path) => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return undefined;
      }
    },
    reapLeases: () => {
      if (!db) return 'unavailable';
      try {
        const reaped = reapExpired(db, Date.now());
        return { reaped };
      } catch {
        return 'unavailable';
      }
    },
    buildCwip: (cwipDir) => {
      const bunExec = process.execPath; // the bun binary this process is running under
      return sh([bunExec, 'run', 'build'], cwipDir);
    },
    relink: (ruDir) => {
      const bunExec = process.execPath;
      return sh([bunExec, 'run', 'relink'], ruDir);
    },
    kickDrain: () => {
      // Try kickstart (macOS 10.10+), fall back to the older `start` form.
      const uid = process.getuid?.() ?? '';
      const r = sh(['launchctl', 'kickstart', `gui/${uid}/com.taskq.drain`], '/');
      if (r.code !== 0) return sh(['launchctl', 'start', 'com.taskq.drain'], '/');
      return r;
    },
    freshHeartbeatCount: (freshHbMs) => {
      if (!db) return 'unavailable';
      try {
        const row = db.query(`SELECT COUNT(*) AS c FROM leases WHERE heartbeat_at > ?`).get(Date.now() - freshHbMs) as {
          c: number;
        } | null;
        return row?.c ?? 0;
      } catch {
        return 'unavailable';
      }
    },
    leaseCount: () => {
      if (!db) return 'unavailable';
      try {
        const row = db.query(`SELECT COUNT(*) AS c FROM leases`).get() as { c: number } | null;
        return row?.c ?? 0;
      } catch {
        return 'unavailable';
      }
    },
  };
}

// ── Log helpers (kept separate so they stay out of test scope) ────────────────

/** Write a one-line summary to `~/.taskq/drain-guard.log` (best-effort). */
export function logHealerResult(result: HealerResult): void {
  try {
    const { appendFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
    const logFile = join(taskqHome(), 'drain-guard.log');
    mkdirSync(taskqHome(), { recursive: true });
    const ts = new Date(result.ranAt)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, 'Z');
    if (result.issuesFound === 0) {
      appendFileSync(logFile, `[${ts}] OK: drain environment healthy\n`);
    } else {
      appendFileSync(
        logFile,
        `[${ts}] SUMMARY: found=${result.issuesFound} fixed=${result.issuesFixed}${result.inconclusive ? ' INCONCLUSIVE' : ''}\n`,
      );
      for (const issue of result.issues) {
        const status = issue.fixed ? 'FIX' : 'ISSUE';
        appendFileSync(logFile, `[${ts}] ${status}: ${issue.description}${issue.detail ? ` — ${issue.detail}` : ''}\n`);
      }
    }
  } catch {
    // log write failure must never propagate
  }
}
