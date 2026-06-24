#!/usr/bin/env bun
/**
 * orch-self-healer — deep orchestration health check.
 *
 * The slower, smarter companion to the bash drain-guard (com.taskq.drain-guard,
 * every 2 min). The guard handles fast/critical checks (cwip dist, bun link, drain
 * alive, crash re-queue); this handles the checks the guard CAN'T:
 *
 *   1. Watchdog-for-the-guard: ensure drain-guard itself is loaded + fresh.
 *   2. UI white-screen: deeper API + HTML root check on /taskq.
 *   3. Primary hygiene: commit stranded changes in nova/rubato/cwip primaries.
 *   4. Owner-gate: clear needs_owner holds; never block the queue on the owner.
 *   5. False-done scan: file reattempt tasks for suspicious fast completions.
 *   6. Guard backup: run drain-guard's own checks once if the guard is down.
 *
 * Adaptive cadence: backs off when clean (up to 3 h), speeds up when it fixes
 * something (floor 30 min). Sets recur_interval_ms in the DB before exiting.
 *
 * Run by the recurring 'orch-self-healer' taskq task (#380).
 */

import { execSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { consoleIo, type ScriptIo } from '../lib/scriptIo';

const INTERVAL_FLOOR_MS = 30 * 60_000; // 30 min
const INTERVAL_CEILING_MS = 3 * 60 * 60_000; // 3 h
const GUARD_LOG_STALE_MS = 10 * 60_000; // 10 min
const UI_BASE = 'http://localhost:5175';
const TASKQ_UI_DISABLE = '.rubato-dev.disabled';

// ── Deps interface (injectable for tests) ────────────────────────────────────

export interface SelfHealerDeps {
  home(): string;
  now(): number;
  /** Run launchctl list for a label; returns true if loaded. */
  launchctlLoaded(label: string): boolean;
  /** Load a plist; returns exit code. */
  launchctlLoad(plist: string): number;
  /** Kickstart a launchd job; returns exit code. */
  launchctlKickstart(label: string): number;
  /** mtime of a file in ms, or undefined if missing. */
  mtimeMs(path: string): number | undefined;
  /** Whether a path exists and is a symlink. */
  isSymlink(path: string): boolean;
  /** Whether a file exists. */
  fileExists(path: string): boolean;
  /** Run git status --porcelain in a dir; returns lines or null if not a repo. */
  gitStatusPorcelain(dir: string): string[] | null;
  /** Run git branch --show-current; returns branch name or null. */
  gitCurrentBranch(dir: string): string | null;
  /** Stage all and commit in a dir; returns true on success. */
  gitCommitAll(dir: string, message: string): boolean;
  /** GET url with a timeout; returns body string or null on error. */
  httpGet(url: string, timeoutMs: number): Promise<string | null>;
  /** sqlite3 query returning an array of row objects. */
  sqliteQuery(db: string, sql: string): Record<string, unknown>[];
  /** sqlite3 execute (no return). */
  sqliteExec(db: string, sql: string): void;
  /** Run a shell command in cwd; returns exit code. */
  sh(args: string[], cwd: string): number;
  /** Append a line to the drain-guard log. */
  appendLog(logFile: string, msg: string): void;
  /** Write a file (for diff backups). */
  writeFile(path: string, content: string): void;
  /** Get git diff HEAD in a dir. */
  gitDiff(dir: string): string;
  /** Run bun build in a dir; returns exit code. */
  buildCwip(cwipDir: string): number;
  /** Run bun run relink in ruDir; returns exit code. */
  relink(ruDir: string): number;
}

/** One outcome line from a check. */
export interface CheckLine {
  /** '✓' = clean, 'FIXED' = fixed, 'WARN' = issue not fixed, 'INFO' = informational. */
  kind: '✓' | 'FIXED' | 'WARN' | 'INFO';
  msg: string;
}

/** Result of a full self-healer run. */
export interface SelfHealerResult {
  lines: CheckLine[];
  fixCount: number;
  nextIntervalMs: number;
}

// ── Check implementations ────────────────────────────────────────────────────

function checkWatchdogsAlive(deps: SelfHealerDeps, home: string, _db: string): CheckLine[] {
  const lines: CheckLine[] = [];
  const guardLabel = 'com.taskq.drain-guard';
  const drainLabel = 'com.taskq.drain';
  const guardPlist = join(home, 'Library', 'LaunchAgents', `${guardLabel}.plist`);
  const drainPlist = join(home, 'Library', 'LaunchAgents', `${drainLabel}.plist`);
  const guardLog = join(home, '.taskq', 'drain-guard.log');

  // drain-guard loaded?
  if (!deps.launchctlLoaded(guardLabel)) {
    if (deps.fileExists(guardPlist)) {
      const code = deps.launchctlLoad(guardPlist);
      lines.push(
        code === 0
          ? { kind: 'FIXED', msg: 'drain-guard plist reloaded' }
          : { kind: 'WARN', msg: 'drain-guard reload failed' },
      );
    } else {
      lines.push({ kind: 'WARN', msg: 'drain-guard NOT loaded and plist missing' });
    }
  } else {
    // loaded — check log freshness
    const mtime = deps.mtimeMs(guardLog);
    if (mtime !== undefined) {
      const ageMs = deps.now() - mtime;
      if (ageMs > GUARD_LOG_STALE_MS) {
        const uid = process.getuid?.() ?? '';
        const code = deps.launchctlKickstart(`gui/${uid}/${guardLabel}`);
        const ageMin = Math.round(ageMs / 60_000);
        lines.push(
          code === 0
            ? { kind: 'FIXED', msg: `drain-guard kickstarted (log ${ageMin}min stale)` }
            : { kind: 'WARN', msg: `drain-guard log stale (${ageMin}min), kickstart failed` },
        );
      }
    }
  }

  // drain loaded? (guard normally handles this, but we're the reciprocal backstop)
  if (!deps.launchctlLoaded(drainLabel)) {
    if (deps.fileExists(drainPlist)) {
      const code = deps.launchctlLoad(drainPlist);
      lines.push(
        code === 0 ? { kind: 'FIXED', msg: 'drain plist reloaded' } : { kind: 'WARN', msg: 'drain reload failed' },
      );
    } else {
      lines.push({ kind: 'WARN', msg: 'drain NOT loaded and plist missing' });
    }
  }

  if (lines.length === 0) lines.push({ kind: '✓', msg: 'watchdogs: drain-guard + drain loaded and fresh' });
  return lines;
}

async function checkUiWhiteScreen(deps: SelfHealerDeps, home: string, db: string): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];
  const disableFlag = join(home, '.taskq', TASKQ_UI_DISABLE);
  if (deps.fileExists(disableFlag)) {
    lines.push({ kind: 'INFO', msg: 'UI check skipped (kill-switch set)' });
    return lines;
  }

  const apiBody = await deps.httpGet(`${UI_BASE}/api/taskq`, 6_000);
  if (!apiBody?.includes('"tasks"')) {
    // Check if server is up at all
    const root = await deps.httpGet(`${UI_BASE}/`, 5_000);
    if (!root) {
      // Server DOWN — guard handles restart; we just ensure a task exists
      ensureHealTask(
        deps,
        db,
        'heal-taskq-ui-down',
        'Orch UI down: rubato dev server on :5175 not responding',
        'ru',
        'localhost:5175 is not responding. Guard should restart it; if not, check com.taskq.rubato-dev agent.',
      );
      lines.push({ kind: 'FIXED', msg: 'filed heal-taskq-ui-down (server not responding)' });
    } else {
      ensureHealTask(
        deps,
        db,
        'heal-taskq-ui-api',
        'Orch UI API broken: /api/taskq returns no board data',
        'ru',
        'localhost:5175 responds but /api/taskq has no tasks board. Diagnose taskqRoutes + the ~/.taskq DB read path.',
      );
      lines.push({ kind: 'FIXED', msg: 'filed heal-taskq-ui-api (API returns no board data)' });
    }
    return lines;
  }

  // API OK — lightweight HTML check: does the page contain a React root?
  const pageHtml = await deps.httpGet(`${UI_BASE}/taskq`, 6_000);
  if (pageHtml && !pageHtml.includes('id="root"')) {
    ensureHealTask(
      deps,
      db,
      'heal-taskq-ui',
      'Orch /taskq page missing React root',
      'ru',
      'localhost:5175/taskq HTML has no #root div — the served bundle may be stale or the route is missing.',
    );
    lines.push({ kind: 'FIXED', msg: 'filed heal-taskq-ui (page missing React root div)' });
  } else {
    lines.push({ kind: '✓', msg: 'UI: /api/taskq OK + /taskq HTML contains React root' });
  }
  return lines;
}

function checkPrimaryHygiene(deps: SelfHealerDeps, home: string): CheckLine[] {
  const lines: CheckLine[] = [];
  // Live repos only: nova (workers may strand), rubato + cwip (run orchestrator)
  const primaries: Array<{ dir: string; defaultBranch: string }> = [
    { dir: join(home, 'code', 'github', 'nova'), defaultBranch: 'main' },
    { dir: join(home, 'code', 'github', 'rubato'), defaultBranch: 'main' },
    { dir: join(home, 'code', 'github', 'cwip'), defaultBranch: 'master' },
  ];

  let anyDirty = false;
  for (const { dir, defaultBranch } of primaries) {
    const name = dir.split('/').pop()!;
    const statusLines = deps.gitStatusPorcelain(dir);
    if (statusLines === null) continue; // not a git repo

    // Skip untracked-only (??), and bun.lock-only noise
    const uncommitted = statusLines.filter((l) => !l.startsWith('??') && !l.endsWith('bun.lock'));
    if (uncommitted.length === 0) continue;

    anyDirty = true;
    const branch = deps.gitCurrentBranch(dir);
    if (branch !== defaultBranch) {
      lines.push({
        kind: 'WARN',
        msg: `${name} primary on branch '${branch}' (not ${defaultBranch}), skipping hygiene`,
      });
      continue;
    }

    // Back up the diff
    try {
      const diff = deps.gitDiff(dir);
      if (diff) {
        const backupPath = join(home, '.taskq', `${name}-primary-hygiene-${deps.now()}.diff`);
        deps.writeFile(backupPath, diff);
      }
    } catch {
      /* best-effort */
    }

    // Commit all changes to the primary default branch
    const msg = `chore(${name}): self-healer: commit stranded primary changes (#380)`;
    if (deps.gitCommitAll(dir, msg)) {
      lines.push({
        kind: 'FIXED',
        msg: `${name} primary: committed ${uncommitted.length} stranded file(s) → ${defaultBranch}`,
      });
    } else {
      lines.push({ kind: 'WARN', msg: `${name} primary: ${uncommitted.length} uncommitted file(s), commit failed` });
    }
  }

  if (!anyDirty) lines.push({ kind: '✓', msg: 'primary hygiene: nova/rubato/cwip primaries clean' });
  return lines;
}

function checkOwnerGate(deps: SelfHealerDeps, db: string): CheckLine[] {
  const lines: CheckLine[] = [];
  const rows = deps.sqliteQuery(
    db,
    `SELECT id, slug FROM tasks WHERE hold_disposition='needs_owner' AND status NOT IN ('done','claimed')`,
  );
  if (rows.length > 0) {
    deps.sqliteExec(
      db,
      `UPDATE tasks SET hold_disposition=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE hold_disposition='needs_owner' AND status NOT IN ('done','claimed')`,
    );
    const slugs = rows.map((r) => r.slug ?? r.id).join(', ');
    lines.push({ kind: 'FIXED', msg: `cleared needs_owner hold on ${rows.length} task(s): ${slugs}` });
  } else {
    lines.push({ kind: '✓', msg: 'owner-gate: no needs_owner holds' });
  }
  return lines;
}

function checkFalseDoneAndQueue(deps: SelfHealerDeps, db: string): CheckLine[] {
  const lines: CheckLine[] = [];

  // Scan for suspiciously fast code-change completions (< 120s, not noop_ok)
  const suspicious = deps.sqliteQuery(
    db,
    // Look for suspicious "nothing to do" completions: done tasks (code-change, not noop_ok)
    // whose note explicitly claims no work was done but gives no justification. Empty notes
    // are NOT flagged — a blank note on a legitimate task is fine (the commit is the evidence).
    // This targets the class of false-done where the worker wrote "nothing to do" or similar
    // without the task having noop_ok set. Uses updated_at as completion timestamp proxy
    // (there is no elapsed_ms column in this schema).
    `SELECT id, slug, title, note FROM tasks
     WHERE status='done' AND noop_ok=0
       AND repo IS NOT NULL AND repo != ''
       AND updated_at > datetime('now', '-4 hours')
       AND (note LIKE '%nothing to do%' OR note LIKE '%no changes needed%' OR note LIKE '%already done%' OR note LIKE '%no-op%')
     ORDER BY updated_at DESC LIMIT 10`,
  );
  for (const t of suspicious) {
    const slug = String(t.slug ?? t.id);
    const reattemptSlug = `reattempt-${slug}`;
    const existing = deps.sqliteQuery(
      db,
      `SELECT count(*) AS c FROM tasks WHERE slug='${reattemptSlug}' AND status NOT IN ('done','archived')`,
    );
    if (Number(existing[0]?.c ?? 0) > 0) continue;
    const title = String(t.title ?? slug).replace(/'/g, "''");
    const note = String(t.note ?? '').slice(0, 60) || '(empty note)';
    deps.sqliteExec(
      db,
      `INSERT INTO tasks (slug,title,note,status,model,think,repo,noop_ok,ord) VALUES ('${reattemptSlug}','[Re-attempt] ${title}','Completed with suspicious note (${note.replace(/'/g, "''")}). Verify the work landed; redo if not. Original: ${slug}','ready','sonnet','medium','ru',1,-300)`,
    );
    lines.push({ kind: 'FIXED', msg: `filed reattempt for suspicious done '${slug}' (note: ${note})` });
  }

  // Queue health summary
  const counts = deps.sqliteQuery(
    db,
    `SELECT status, count(*) AS c FROM tasks WHERE status NOT IN ('archived') GROUP BY status`,
  );
  const byStatus: Record<string, number> = {};
  for (const r of counts) byStatus[String(r.status)] = Number(r.c);
  const ready = byStatus.ready ?? 0;
  const claimed = byStatus.claimed ?? 0;
  const done = byStatus.done ?? 0;
  lines.push({ kind: 'INFO', msg: `queue: ${ready} ready, ${claimed} claimed, ${done} done` });

  return lines;
}

function checkGuardBackup(deps: SelfHealerDeps, home: string, _db: string): CheckLine[] {
  const lines: CheckLine[] = [];
  if (deps.launchctlLoaded('com.taskq.drain-guard')) return lines; // guard is up, nothing to do

  lines.push({ kind: 'WARN', msg: 'drain-guard DOWN — running guard backup pass' });

  // cwip dist
  const cwipDir = join(home, 'code', 'github', 'cwip');
  const cwipDist = join(cwipDir, 'dist', 'services', 'taskq', 'index.js');
  if (!deps.fileExists(cwipDist)) {
    const code = deps.buildCwip(cwipDir);
    lines.push(
      code === 0
        ? { kind: 'FIXED', msg: 'cwip dist rebuilt (guard backup)' }
        : { kind: 'WARN', msg: 'cwip rebuild failed (guard backup)' },
    );
  }

  // cwip symlink
  const cwipLink = join(home, 'code', 'github', 'rubato', 'node_modules', 'cwip');
  if (!deps.isSymlink(cwipLink)) {
    const ruDir = join(home, 'code', 'github', 'rubato');
    const code = deps.relink(ruDir);
    lines.push(
      code === 0
        ? { kind: 'FIXED', msg: 'cwip relinked (guard backup)' }
        : { kind: 'WARN', msg: 'cwip relink failed (guard backup)' },
    );
  }

  // drain loaded?
  const drainPlist = join(home, 'Library', 'LaunchAgents', 'com.taskq.drain.plist');
  if (!deps.launchctlLoaded('com.taskq.drain') && deps.fileExists(drainPlist)) {
    const code = deps.launchctlLoad(drainPlist);
    lines.push(
      code === 0
        ? { kind: 'FIXED', msg: 'drain reloaded (guard backup)' }
        : { kind: 'WARN', msg: 'drain reload failed (guard backup)' },
    );
  }

  return lines;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function ensureHealTask(
  deps: SelfHealerDeps,
  db: string,
  slug: string,
  title: string,
  repo: string,
  note: string,
): void {
  const existing = deps.sqliteQuery(
    db,
    `SELECT count(*) AS c FROM tasks WHERE slug='${slug}' AND status IN ('ready','claimed','on_hold')`,
  );
  if (Number(existing[0]?.c ?? 0) > 0) return;
  const safeNote = note.replace(/'/g, "''");
  const safeTitle = title.replace(/'/g, "''");
  deps.sqliteExec(
    db,
    `INSERT INTO tasks (slug,title,note,status,model,think,repo,noop_ok,ord) VALUES ('${slug}','${safeTitle}','${safeNote}','ready','sonnet','medium','${repo}',0,-320)`,
  );
}

// ── Adaptive interval ────────────────────────────────────────────────────────

function setNextInterval(deps: SelfHealerDeps, db: string, fixCount: number, currentMs: number): number {
  const next =
    fixCount > 0
      ? Math.max(INTERVAL_FLOOR_MS, Math.floor(currentMs / 2))
      : Math.min(INTERVAL_CEILING_MS, currentMs * 2);
  deps.sqliteExec(db, `UPDATE tasks SET recur_interval_ms=${next} WHERE slug='orch-self-healer'`);
  return next;
}

// ── Core run ─────────────────────────────────────────────────────────────────

export async function runSelfHealer(deps: SelfHealerDeps, db: string): Promise<SelfHealerResult> {
  const home = deps.home();
  const log = join(home, '.taskq', 'drain-guard.log');

  const currentRow = deps.sqliteQuery(db, `SELECT recur_interval_ms FROM tasks WHERE slug='orch-self-healer'`);
  const currentMs = Number(currentRow[0]?.recur_interval_ms ?? 1_800_000);

  const allLines: CheckLine[] = [];

  const push = (lines: CheckLine[]) => {
    for (const l of lines) {
      allLines.push(l);
      deps.appendLog(log, `[orch-self-healer] ${l.kind}: ${l.msg}`);
    }
  };

  push(checkWatchdogsAlive(deps, home, db));
  push(await checkUiWhiteScreen(deps, home, db));
  push(checkPrimaryHygiene(deps, home));
  push(checkOwnerGate(deps, db));
  push(checkFalseDoneAndQueue(deps, db));
  push(checkGuardBackup(deps, home, db));

  const fixCount = allLines.filter((l) => l.kind === 'FIXED').length;
  const nextIntervalMs = setNextInterval(deps, db, fixCount, currentMs);

  return { lines: allLines, fixCount, nextIntervalMs };
}

// ── Real deps ─────────────────────────────────────────────────────────────────

function sh(args: string[], cwd: string): number {
  try {
    const r = spawnSync(args[0], args.slice(1), {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' } as NodeJS.ProcessEnv,
      maxBuffer: 8 * 1024 * 1024,
    });
    return r.status ?? 1;
  } catch {
    return 1;
  }
}

export function makeRealDeps(): SelfHealerDeps {
  return {
    home: homedir,
    now: () => Date.now(),
    launchctlLoaded: (label) => {
      const r = spawnSync('launchctl', ['list', label], { encoding: 'utf8' });
      return r.status === 0;
    },
    launchctlLoad: (plist) => sh(['launchctl', 'load', plist], '/'),
    launchctlKickstart: (target) => sh(['launchctl', 'kickstart', target], '/'),
    mtimeMs: (path) => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return undefined;
      }
    },
    isSymlink: (path) => {
      try {
        return lstatSync(path).isSymbolicLink();
      } catch {
        return false;
      }
    },
    fileExists: (path) => existsSync(path),
    gitStatusPorcelain: (dir) => {
      if (!existsSync(dir)) return null;
      const r = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
      if (r.status !== 0) return null;
      return (r.stdout ?? '').split('\n').filter(Boolean);
    },
    gitCurrentBranch: (dir) => {
      const r = spawnSync('git', ['-C', dir, 'branch', '--show-current'], { encoding: 'utf8' });
      return r.status === 0 ? (r.stdout?.trim() ?? null) : null;
    },
    gitCommitAll: (dir, message) => {
      const add = spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
      if (add.status !== 0) return false;
      const commit = spawnSync('git', ['-C', dir, 'commit', '-m', message], { encoding: 'utf8' });
      return commit.status === 0;
    },
    httpGet: async (url, timeoutMs) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        return await res.text();
      } catch {
        return null;
      }
    },
    sqliteQuery: (db, sql) => {
      try {
        const out = execSync(`sqlite3 -json "${db}" "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
        if (!out) return [];
        return (JSON.parse(out) as Record<string, unknown>[]) ?? [];
      } catch {
        return [];
      }
    },
    sqliteExec: (db, sql) => {
      try {
        execSync(`sqlite3 "${db}" "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
      } catch {
        /* best-effort */
      }
    },
    sh: (args, cwd) => sh(args, cwd),
    appendLog: (logFile, msg) => {
      try {
        mkdirSync(join(logFile, '..'), { recursive: true });
        const ts = new Date()
          .toISOString()
          .replace('T', ' ')
          .replace(/\.\d{3}Z$/, 'Z');
        appendFileSync(logFile, `[${ts}] ${msg}\n`);
      } catch {
        /* best-effort */
      }
    },
    writeFile: (path, content) => {
      try {
        writeFileSync(path, content);
      } catch {
        /* best-effort */
      }
    },
    gitDiff: (dir) => {
      try {
        const r = spawnSync('git', ['-C', dir, 'diff', 'HEAD'], { encoding: 'utf8' });
        return r.stdout ?? '';
      } catch {
        return '';
      }
    },
    buildCwip: (cwipDir) => {
      return sh([process.execPath, 'run', 'build'], cwipDir);
    },
    relink: (ruDir) => {
      return sh([process.execPath, 'run', 'relink'], ruDir);
    },
  };
}

// ── Script entry ─────────────────────────────────────────────────────────────

export async function run(_args: string[], io: ScriptIo = consoleIo): Promise<number> {
  const home = homedir();
  const db = join(home, '.taskq', 'taskq.sqlite');

  if (!existsSync(db)) {
    io.err('orch-self-healer: taskq DB not found — nothing to heal');
    return 0;
  }

  const deps = makeRealDeps();
  const result = await runSelfHealer(deps, db);

  for (const line of result.lines) {
    io.out(`${line.kind === '✓' ? '✓' : line.kind}: ${line.msg}`);
  }
  const nextMin = Math.round(result.nextIntervalMs / 60_000);
  const prevRow = deps.sqliteQuery(db, `SELECT recur_interval_ms FROM tasks WHERE slug='orch-self-healer'`);
  const prevMs = Number(prevRow[0]?.recur_interval_ms ?? result.nextIntervalMs);
  const _prevMin = Math.round(prevMs / 60_000); // already updated but close enough for display
  const dir = result.fixCount > 0 ? 'sped up' : 'backed off';
  io.out(
    `→ interval: ${nextMin}min (${dir}${result.fixCount > 0 ? `, ${result.fixCount} fix(es) made` : ', clean run'})`,
  );

  return 0;
}

if (import.meta.main) {
  run(process.argv.slice(2))
    .then(process.exit)
    .catch(() => process.exit(1));
}
