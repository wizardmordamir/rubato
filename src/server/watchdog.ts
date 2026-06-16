/**
 * Server control + observe layer for the unattended drain watchdog (see
 * `src/lib/orchestration/watchdog.ts` for the pure parsers and
 * `src/shared/orchestration.ts` for the model). Reads the orchestration control
 * files, checks process liveness, and exposes the SAFE side-effects the
 * dashboard/CLI drive: patch `drain.config`, set the launchd tick interval,
 * start/stop the drainer, stop a worker, and tail the logs.
 *
 * Safety: every action operates only on resolved orchestration paths and the
 * drainer/worker PIDs we read from the lockfile + per-worker PID files — never a
 * client-supplied path or pid. The "nuke everything" `pkill -f 'claude -p'`
 * option is intentionally left as a documented MANUAL command (in the catalogue),
 * not a programmatic action, so we never kill an unrelated `claude` session.
 *
 * Paths: the notes dir is resolved by `./orchestration` (`RUBATO_NOTES_DIR` env >
 * config > default). The launchd plist defaults to the user's LaunchAgents dir;
 * `RUBATO_WATCHDOG_PLIST` overrides it (used by tests).
 */

import { readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  applyDrainPatch,
  buildWatchdogCommands,
  changedDrainFields,
  computePending,
  defaultDrainConfig,
  deriveInstances,
  deriveNextRun,
  deriveProblems,
  emptyTaskBoard,
  needsRestartFieldChanged,
  parseActiveRun,
  parseDrainConfig,
  parseLaunchdPlist,
  parseRunsJsonl,
  parseTaskBoard,
  parseWatchdogStatus,
  parseWatchdogTick,
  serializeDrainConfig,
  setPlistInterval,
  summarizeRunEntries,
  wakeAction,
} from '../lib/orchestration';
import type {
  ActiveRun,
  ConfigPatchResult,
  DrainConfig,
  DrainConfigPatch,
  FileLocation,
  LaunchdInfo,
  LogFileInfo,
  LogTail,
  Problem,
  RestartResult,
  WatchdogAgentResult,
  WatchdogSnapshot,
  WatchdogTick,
  WorkerProcess,
} from '../shared/orchestration';
import { notesDir } from './orchestration';

/** The watchdog launchd agent label (matches the installed plist). */
const DEFAULT_LABEL = 'com.curt.agent-drain-watchdog';
/** How much of a worker `.err` file to surface as a problem excerpt. */
const ERR_EXCERPT_BYTES = 500;
/** Default number of log lines a tail returns. */
const DEFAULT_TAIL_LINES = 200;
/** A safe single path segment (a runs-dir log filename): word chars, dot, dash. */
const SAFE_NAME_RE = /^[\w.-]+$/;

/** Every orchestration control/state path, resolved against the current notes dir. */
export interface WatchdogPaths {
  notesDir: string;
  orchestrationDir: string;
  config: string;
  lock: string;
  status: string;
  /** `watchdog.tick.json` — the last tick's start/end/duration/result the script stamps. */
  tick: string;
  watchdogLog: string;
  watchdogOut: string;
  watchdogErr: string;
  runsDir: string;
  /** `runs/active-run.json` — what the RUNNING drainer launched with. */
  activeRun: string;
  /** `runs/.drain-stop` — the graceful-stop sentinel the drainer checks between tasks. */
  stopFile: string;
  runner: string;
  watchdogScript: string;
  queue: string;
  completed: string;
  plist: string;
  label: string;
}

/** Resolve all orchestration paths (everything hangs off the notes dir). */
export async function watchdogPaths(): Promise<WatchdogPaths> {
  const dir = await notesDir();
  const orch = join(dir, 'orchestration');
  const plist =
    process.env.RUBATO_WATCHDOG_PLIST?.trim() || join(homedir(), 'Library', 'LaunchAgents', `${DEFAULT_LABEL}.plist`);
  return {
    notesDir: dir,
    orchestrationDir: orch,
    config: join(orch, 'drain.config'),
    lock: join(orch, '.drain.lock'),
    status: join(orch, 'watchdog.status'),
    tick: join(orch, 'watchdog.tick.json'),
    watchdogLog: join(orch, 'watchdog.log'),
    watchdogOut: join(orch, 'watchdog.out'),
    watchdogErr: join(orch, 'watchdog.err'),
    runsDir: join(orch, 'runs'),
    activeRun: join(orch, 'runs', 'active-run.json'),
    stopFile: join(orch, 'runs', '.drain-stop'),
    runner: join(orch, 'drain-queue.sh'),
    watchdogScript: join(orch, 'watchdog.sh'),
    queue: join(dir, 'TASKS.md'),
    completed: join(dir, 'Tasks_Completed.md'),
    plist,
    label: DEFAULT_LABEL,
  };
}

// ── tiny fs helpers ───────────────────────────────────────────────────────────

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function statMaybe(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  return (await statMaybe(path)) !== null;
}

/** Is `pid` a live process right now? (signal 0 = existence check, no signal sent.) */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but we can't signal it → still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ── reads → the watchdog snapshot ─────────────────────────────────────────────

/** Read + parse `drain.config` (safe defaults when absent). */
async function loadConfig(path: string): Promise<DrainConfig> {
  const text = await readMaybe(path);
  return text === null ? defaultDrainConfig() : parseDrainConfig(text);
}

/** Read + parse `runs/active-run.json` → what the running drainer launched with. */
async function loadActiveRun(path: string): Promise<ActiveRun | undefined> {
  const text = await readMaybe(path);
  return text === null ? undefined : parseActiveRun(text);
}

/** Read the drainer lockfile → its pid + whether it's alive. */
async function loadRunner(lockPath: string): Promise<{ pid?: number; running: boolean }> {
  const text = await readMaybe(lockPath);
  if (text === null) return { running: false };
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(pid)) return { running: false };
  return { pid, running: pidAlive(pid) };
}

/** Read the watchdog plist → label/interval/program + existence + loaded state. */
async function loadLaunchd(plistPath: string): Promise<LaunchdInfo> {
  const xml = await readMaybe(plistPath);
  if (xml === null) return { exists: false };
  const parsed = parseLaunchdPlist(xml);
  const loaded = await launchdLoaded(parsed.label ?? DEFAULT_LABEL);
  return { ...parsed, exists: true, ...(loaded !== undefined ? { loaded } : {}) };
}

/**
 * Whether the launchd agent is currently loaded (`launchctl list <label>` exits 0).
 * Best-effort: returns `undefined` when launchctl is suppressed (the same
 * `RUBATO_WATCHDOG_NO_RELOAD` gate the reload uses — tests / launchctl-less envs)
 * or the spawn fails, so it never throws and never depends on the host's real
 * agent state in a unit test.
 */
async function launchdLoaded(label: string): Promise<boolean | undefined> {
  if (process.env.RUBATO_WATCHDOG_NO_RELOAD === '1') return undefined;
  try {
    const proc = Bun.spawn(['launchctl', 'list', label], { stdout: 'ignore', stderr: 'ignore' });
    return (await proc.exited) === 0;
  } catch {
    return undefined;
  }
}

/** Read + parse `watchdog.tick.json` → the last tick's start/end/duration/result. */
async function loadTick(path: string): Promise<WatchdogTick | undefined> {
  const text = await readMaybe(path);
  return text === null ? undefined : parseWatchdogTick(text);
}

/** Discover live worker processes from the drainer's per-worker PID files. */
async function listWorkers(runsDir: string, nowMs: number): Promise<WorkerProcess[]> {
  let names: string[];
  try {
    names = (await readdir(runsDir)).filter((n) => n.endsWith('.pid'));
  } catch {
    return [];
  }
  const workers: WorkerProcess[] = [];
  for (const name of names) {
    const text = await readMaybe(join(runsDir, name));
    const pid = Number.parseInt((text ?? '').trim(), 10);
    if (!Number.isFinite(pid)) continue;
    const st = await statMaybe(join(runsDir, name));
    const idMatch = name.match(/-w(\d+)\.pid$/);
    const jsonl = name.replace(/\.pid$/, '.jsonl');
    // The worker appends one result object to its JSONL per finished task, so its
    // entries are the tasks it has completed THIS session (the in-progress one
    // isn't there yet) and the file's mtime ≈ when the last one finished. Cheap to
    // read — one small file per live worker — and it powers the per-worker timing
    // (last/avg duration, error count, session cost) the dashboard surfaces.
    const jsonlPath = join(runsDir, jsonl);
    const jsonlText = await readMaybe(jsonlPath);
    const runs = jsonlText !== null ? summarizeRunEntries(parseRunsJsonl(jsonl, jsonlText)) : undefined;
    const jsonlStat = runs && runs.count > 0 ? await statMaybe(jsonlPath) : null;
    workers.push({
      id: idMatch ? Number.parseInt(idMatch[1], 10) : 0,
      pid,
      alive: pidAlive(pid),
      ...(runs
        ? {
            logFile: jsonl,
            tasksCompleted: runs.count,
            lastTaskErrored: runs.lastTaskErrored,
            errorCount: runs.errorCount,
            ...(runs.lastDurationMs !== undefined ? { lastDurationMs: runs.lastDurationMs } : {}),
            ...(runs.avgDurationMs !== undefined ? { avgDurationMs: runs.avgDurationMs } : {}),
            ...(runs.totalCostUsd !== undefined ? { totalCostUsd: runs.totalCostUsd } : {}),
            ...(jsonlStat ? { lastFinishedAt: new Date(jsonlStat.mtimeMs).toISOString() } : {}),
          }
        : {}),
      ...(st
        ? {
            startedAt: new Date(st.mtimeMs).toISOString(),
            elapsedSeconds: Math.max(0, Math.round((nowMs - st.mtimeMs) / 1000)),
          }
        : {}),
    });
  }
  return workers.sort((a, b) => a.id - b.id);
}

/** Worker `.err` files that have content → excerpt (for the problems list). */
async function loadWorkerErrors(runsDir: string): Promise<{ file: string; excerpt: string }[]> {
  let names: string[];
  try {
    names = (await readdir(runsDir)).filter((n) => n.endsWith('.err'));
  } catch {
    return [];
  }
  const out: { file: string; excerpt: string }[] = [];
  for (const name of names) {
    const st = await statMaybe(join(runsDir, name));
    if (!st || st.size === 0) continue;
    const text = (await readMaybe(join(runsDir, name))) ?? '';
    const trimmed = text.trim();
    if (!trimmed) continue;
    out.push({ file: name, excerpt: trimmed.slice(-ERR_EXCERPT_BYTES) });
  }
  return out;
}

/** The log/state files the tail UI offers (watchdog logs + recent run logs). */
async function listLogs(p: WatchdogPaths): Promise<LogFileInfo[]> {
  const fixed: { key: string; label: string; path: string }[] = [
    { key: 'watchdog-log', label: 'watchdog.log (launch events)', path: p.watchdogLog },
    { key: 'watchdog-status', label: 'watchdog.status (last check)', path: p.status },
    { key: 'watchdog-out', label: 'watchdog.out (drainer stdout)', path: p.watchdogOut },
    { key: 'watchdog-err', label: 'watchdog.err (drainer stderr)', path: p.watchdogErr },
  ];
  const logs: LogFileInfo[] = [];
  for (const f of fixed) {
    const st = await statMaybe(f.path);
    logs.push({
      ...f,
      exists: st !== null,
      size: st?.size ?? 0,
      ...(st ? { modified: new Date(st.mtimeMs).toISOString() } : {}),
    });
  }
  // The most-recent run worker logs (keyed by their bare filename).
  try {
    const runNames = (await readdir(p.runsDir)).filter((n) => n.endsWith('.jsonl') || n.endsWith('.err'));
    const stats = (await Promise.all(runNames.map(async (n) => ({ n, st: await statMaybe(join(p.runsDir, n)) }))))
      .filter((x): x is { n: string; st: { size: number; mtimeMs: number } } => x.st !== null)
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
      .slice(0, 8);
    for (const { n, st } of stats) {
      logs.push({
        key: n,
        label: `runs/${n}`,
        path: join(p.runsDir, n),
        exists: true,
        size: st.size,
        modified: new Date(st.mtimeMs).toISOString(),
      });
    }
  } catch {
    /* no runs dir yet */
  }
  return logs;
}

/** The relevant file locations (with categories) for the editor-links panel. */
async function listFileLocations(p: WatchdogPaths): Promise<FileLocation[]> {
  const specs: { label: string; path: string; category: FileLocation['category'] }[] = [
    { label: 'Agent workspace dir', path: p.notesDir, category: 'workspace' },
    { label: 'orchestration/ dir', path: p.orchestrationDir, category: 'workspace' },
    { label: 'TASKS.md (board)', path: p.queue, category: 'board' },
    { label: 'Tasks_Completed.md (history)', path: p.completed, category: 'board' },
    { label: 'drain.config (settings)', path: p.config, category: 'config' },
    { label: 'watchdog launchd plist', path: p.plist, category: 'config' },
    { label: 'drain-queue.sh (runner)', path: p.runner, category: 'script' },
    { label: 'watchdog.sh (watchdog)', path: p.watchdogScript, category: 'script' },
    { label: 'watchdog.log', path: p.watchdogLog, category: 'logs' },
    { label: 'watchdog.status', path: p.status, category: 'logs' },
    { label: 'runs/ (run logs)', path: p.runsDir, category: 'logs' },
  ];
  return Promise.all(
    specs.map(async (s) => ({ label: s.label, path: s.path, category: s.category, exists: await fileExists(s.path) })),
  );
}

/** The whole watchdog snapshot (one read) — fast: no run/history aggregation. */
export async function getWatchdog(): Promise<WatchdogSnapshot> {
  const p = await watchdogPaths();
  const nowMs = Date.now();
  const [config, statusText, launchd, runner, activeRun, boardText, workers, workerErrors, logs, files, tick] =
    await Promise.all([
      loadConfig(p.config),
      readMaybe(p.status),
      loadLaunchd(p.plist),
      loadRunner(p.lock),
      loadActiveRun(p.activeRun),
      readMaybe(p.queue),
      listWorkers(p.runsDir, nowMs),
      loadWorkerErrors(p.runsDir),
      listLogs(p),
      listFileLocations(p),
      loadTick(p.tick),
    ]);

  const board = boardText === null ? emptyTaskBoard() : parseTaskBoard(boardText);
  const instances = deriveInstances(board, nowMs);
  const status = statusText ? parseWatchdogStatus(statusText) : undefined;
  // Next-run picture: the last TICK start (preferred — when the watchdog actually
  // ran) else the last status check, plus the interval, gated by armed + loaded +
  // any pending RESUME_AT. Disabled / unloaded → no nextRunAt (the UI shows "—").
  const nextRun = deriveNextRun({
    enabled: config.enabled,
    loaded: launchd.loaded,
    resumeAtEpoch: config.resumeAt,
    lastTickIso: tick?.startedAt ?? status?.at,
    intervalSeconds: launchd.intervalSeconds,
    nowMs,
  });
  const liveWorkers = workers.filter((w) => w.alive).length;
  // Only diff against the active-run when a drainer is actually live — a stale
  // active-run.json (left by a killed run, before its EXIT trap removed it) must
  // not produce phantom "pending" markers.
  const liveActiveRun = runner.running ? activeRun : undefined;
  const pending = computePending(config, liveActiveRun);
  const problems: Problem[] = deriveProblems({
    board,
    config,
    running: runner.running,
    instances,
    workerErrors,
    liveWorkers,
  });

  return {
    notesDir: p.notesDir,
    orchestrationDir: p.orchestrationDir,
    config,
    running: runner.running,
    ...(runner.pid ? { runnerPid: runner.pid } : {}),
    ...(liveActiveRun ? { activeRun: liveActiveRun } : {}),
    pending,
    workers,
    instances,
    counts: {
      ready: board.counts.ready,
      claimed: board.counts.claimed,
      blocked: board.counts.blocked,
      notReady: board.counts['not-ready'],
      done: board.counts.done,
    },
    readyTitles: board.groups.ready.map((t) => t.title),
    ...(status ? { status } : {}),
    launchd,
    ...(tick ? { lastRun: tick } : {}),
    ...(nextRun.nextRunAt ? { nextRunAt: nextRun.nextRunAt } : {}),
    ...(nextRun.resumeAt ? { resumeAt: nextRun.resumeAt } : {}),
    problems,
    logs,
    files,
    commands: buildWatchdogCommands({
      runner: p.runner,
      watchdogScript: p.watchdogScript,
      plist: p.plist,
      label: p.label,
      queue: p.queue,
      runsDir: p.runsDir,
      watchdogLog: p.watchdogLog,
      watchdogStatus: p.status,
      lock: p.lock,
    }),
    now: new Date(nowMs).toISOString(),
  };
}

// ── control: patch drain.config (jobs / model / enabled / thinking / fast / dirs) ──

/**
 * Apply a patch to `drain.config`, write it back atomically (temp + rename, so a
 * live drainer reading the file never sees a half-written config), and — when
 * AUTO_RESTART is on, a drainer is running, and a needs-restart key actually
 * changed — trigger a graceful restart so the change takes effect. Returns the
 * new config, the fields that changed, and any auto-restart that fired.
 */
export async function applyDrainConfigPatch(patch: DrainConfigPatch): Promise<ConfigPatchResult> {
  const p = await watchdogPaths();
  const current = await loadConfig(p.config);
  const next = applyDrainPatch(current, patch);
  await atomicWrite(p.config, serializeDrainConfig(next));
  const changed = changedDrainFields(current, next);
  const result: ConfigPatchResult = { config: next, changed };

  // Auto-restart: only when the NEW config has it on, a needs-restart setting
  // actually changed, and a drainer is currently live (else there's nothing to
  // restart — the change just applies on the next launch).
  if (next.autoRestart && needsRestartFieldChanged(changed)) {
    const runner = await loadRunner(p.lock);
    if (runner.running) result.autoRestart = await restartDrainer('graceful');
  }
  return result;
}

/**
 * Back-compat thin wrapper: patch `drain.config` and return only the new config
 * (the auto-restart side-effect still fires). Prefer {@link applyDrainConfigPatch}
 * when you need the change/restart detail.
 */
export async function patchDrainConfig(patch: DrainConfigPatch): Promise<DrainConfig> {
  return (await applyDrainConfigPatch(patch)).config;
}

/** Write a file atomically (temp sibling + rename) so readers never see a partial. */
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

// ── control: the launchd tick interval (the headline "update interval" ask) ───

export interface SetIntervalResult {
  intervalSeconds: number;
  plist: string;
  /** Whether the launchctl reload succeeded (so the new interval takes effect now). */
  reloaded: boolean;
  /** The reload error, when it failed (non-fatal — the file is still updated). */
  reloadError?: string;
}

/**
 * Set the watchdog's tick interval: rewrite the plist's `StartInterval` and
 * reload the launchd agent so it takes effect immediately. The file write is the
 * durable change; the reload is best-effort (captured, non-fatal). Pass
 * `{ reload: false }` to only rewrite the file (tests, or when launchctl isn't
 * available). Throws if the plist doesn't exist (nothing to edit).
 */
export async function setWatchdogInterval(
  seconds: number,
  opts: { reload?: boolean } = {},
): Promise<SetIntervalResult> {
  const n = Math.max(1, Math.floor(seconds));
  if (!Number.isFinite(n)) throw new Error('interval must be a positive number of seconds');
  const p = await watchdogPaths();
  const xml = await readMaybe(p.plist);
  if (xml === null) throw new Error(`watchdog plist not found: ${p.plist}`);
  await atomicWrite(p.plist, setPlistInterval(xml, n));

  // Default to reloading so the new interval takes effect now; `RUBATO_WATCHDOG_NO_RELOAD=1`
  // (tests / launchctl-less environments) suppresses it so we never register a temp agent.
  const reload = opts.reload ?? process.env.RUBATO_WATCHDOG_NO_RELOAD !== '1';
  if (!reload) return { intervalSeconds: n, plist: p.plist, reloaded: false };
  try {
    await runLaunchctl(['unload', p.plist]); // ignore failure (may not be loaded)
    await runLaunchctl(['load', '-w', p.plist], { mustSucceed: true });
    return { intervalSeconds: n, plist: p.plist, reloaded: true };
  } catch (e) {
    return {
      intervalSeconds: n,
      plist: p.plist,
      reloaded: false,
      reloadError: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Run `launchctl <args>`; rejects on non-zero only when `mustSucceed`. */
async function runLaunchctl(args: string[], opts: { mustSucceed?: boolean } = {}): Promise<void> {
  const proc = Bun.spawn(['launchctl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0 && opts.mustSucceed) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`launchctl ${args.join(' ')} failed (exit ${code}): ${err.trim() || 'unknown error'}`);
  }
}

/** Run `launchctl <args>` capturing exit code + stderr (never throws). */
async function runLaunchctlCapture(args: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(['launchctl', ...args], { stdout: 'ignore', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr: stderr.trim() };
}

// ── control: start / stop / restart the launchd watchdog AGENT itself ──────────

/**
 * Start / stop / restart the launchd watchdog AGENT itself (load/unload/reload the
 * plist) — the layer above the drain.config `ENABLED` toggle (`loaded` = whether
 * launchd ticks at all; `enabled` = whether a tick launches a drain). Each action
 * VERIFIES the resulting loaded state via `launchctl list` (the surest signal) and
 * surfaces any launchctl error (domain/uid/permission) rather than throwing, so the
 * UI can show it inline:
 *
 *   - `start`   → `launchctl load -w <plist>`   (the `-w` clears any disabled flag).
 *   - `stop`    → `launchctl unload -w <plist>`  (the `-w` persists the disable).
 *   - `restart` → `unload` (ignore failure) then `load -w` (reload, e.g. after a plist edit).
 *
 * Throws only when the plist file itself is missing (nothing to load). Honors the
 * `RUBATO_WATCHDOG_NO_RELOAD` gate (tests / launchctl-less env): it then skips the
 * launchctl calls entirely and reports a suppressed no-op.
 */
export async function controlWatchdog(action: 'start' | 'stop' | 'restart'): Promise<WatchdogAgentResult> {
  const p = await watchdogPaths();
  if (!(await fileExists(p.plist))) throw new Error(`watchdog plist not found: ${p.plist}`);

  if (process.env.RUBATO_WATCHDOG_NO_RELOAD === '1') {
    return {
      action,
      ok: true,
      message: `launchctl suppressed (RUBATO_WATCHDOG_NO_RELOAD) — would ${action} ${p.label}`,
    };
  }

  let last: { code: number; stderr: string };
  if (action === 'stop') {
    last = await runLaunchctlCapture(['unload', '-w', p.plist]);
  } else if (action === 'start') {
    last = await runLaunchctlCapture(['load', '-w', p.plist]);
  } else {
    await runLaunchctlCapture(['unload', p.plist]); // best-effort: it may not be loaded
    last = await runLaunchctlCapture(['load', '-w', p.plist]);
  }

  // Intended end state: loaded for start/restart, NOT loaded for stop. Trust the
  // verified `launchctl list` result over the command exit code (an unload of an
  // already-stopped agent exits non-zero but is the desired outcome); fall back to
  // the exit code only when we can't verify.
  const want = action !== 'stop';
  const loaded = await launchdLoaded(p.label);
  const ok = loaded !== undefined ? loaded === want : last.code === 0;
  const verb = action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted';
  return {
    action,
    ok,
    ...(loaded !== undefined ? { loaded } : {}),
    ...(ok ? { message: `watchdog ${verb}` } : {}),
    ...(ok ? {} : { error: last.stderr || `launchctl exited ${last.code}` }),
  };
}

// ── control: start / stop the drainer + stop a worker ─────────────────────────

export interface StartResult {
  started: boolean;
  pid?: number;
  command: string;
  error?: string;
}

/**
 * Start the drainer now (it self-locks, so a second start while one runs just
 * exits cleanly). Honors the saved JOBS unless `jobs` overrides it. Returns the
 * pid on success.
 *
 * Spawned `detached` (POSIX `setsid()`) + unref'd so it (a) outlives the request
 * and (b) starts its OWN session/process group — drain-queue.sh becomes the group
 * leader, so the pgid it stamps into `active-run.json` is always DISTINCT from the
 * rubato server's group. That distinctness is what lets `restartDrainer('force')`
 * group-kill the whole drainer tree (its `claude -p` grandchildren) for a
 * UI-started drainer; without it the runner would inherit the server's group and
 * the force guard would (correctly) refuse to kill it. A launchd-started drainer
 * already gets its own group; this makes UI-started ones match.
 */
export async function startDrainer(opts: { jobs?: number } = {}): Promise<StartResult> {
  const p = await watchdogPaths();
  const args = [p.runner, ...(opts.jobs ? ['-j', String(Math.max(1, Math.floor(opts.jobs)))] : [])];
  const command = args.join(' ');
  if (!(await fileExists(p.runner))) return { started: false, command, error: `runner not found: ${p.runner}` };
  try {
    const proc = Bun.spawn(args, {
      cwd: p.orchestrationDir,
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
      detached: true,
    });
    proc.unref();
    return { started: true, pid: proc.pid, command };
  } catch (e) {
    return { started: false, command, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface WakeResult {
  /** What was done (see {@link wakeAction}). */
  action: 'start' | 'noop' | 'restart';
  /** The configured fan-out we're targeting (drain.config JOBS). */
  jobs: number;
  /** Live worker count just before the action. */
  liveBefore: number;
  /** Whether a drainer was already running before the action. */
  wasRunning: boolean;
  /** Whether a (re)launch was issued and accepted. */
  started: boolean;
  /** The launched drainer's pid, when started. */
  pid?: number;
  /** The launch command, when a launch was attempted. */
  command?: string;
  /** Worker pids signaled on a `restart`. */
  killed?: number[];
  /** The old drainer pid signaled on a `restart`, when there was one. */
  runnerKilled?: number;
  /** A launch error, when the (re)launch failed. */
  error?: string;
  /** A human note (e.g. why a `noop`). */
  message?: string;
}

/**
 * Bring the live worker count up to the configured fan-out — the action behind
 * the dashboard's "Wake workers" button, for when workers go missing (some
 * exited) or JOBS was raised after the drainer started.
 *
 * The drainer is single-instance (one PID lock) and `wait`s on the workers it
 * spawned at launch, so it can't be told to add workers from outside. The honest
 * options, decided purely by {@link wakeAction}:
 *   - nothing running → start a drainer at JOBS;
 *   - running, already ≥ JOBS live workers → no-op;
 *   - running but short-handed → stop it and relaunch at JOBS. The drainer's own
 *     startup recovery turns the interrupted `[~]` claims into `(resume:)`, so a
 *     fresh worker continues each one in its existing worktree (no work lost).
 */
export async function wakeWorkers(): Promise<WakeResult> {
  const p = await watchdogPaths();
  const config = await loadConfig(p.config);
  const jobs = Math.max(1, Math.floor(config.jobs));
  const runner = await loadRunner(p.lock);
  const workers = await listWorkers(p.runsDir, Date.now());
  const liveBefore = workers.filter((w) => w.alive).length;
  const action = wakeAction({ running: runner.running, liveWorkers: liveBefore, jobs });
  const base = { action, jobs, liveBefore, wasRunning: runner.running } as const;

  if (action === 'noop') {
    return { ...base, started: false, message: `${liveBefore}/${jobs} workers already running` };
  }
  if (action === 'restart') {
    const stop = await stopDrainer();
    // Wait for the old drainer to free the PID lock (its EXIT trap removes it on
    // SIGTERM), so the relaunch doesn't self-exit on "a drainer is already running".
    await waitForLockRelease(p.lock);
    const start = await startDrainer({ jobs });
    return {
      ...base,
      started: start.started,
      ...(start.pid ? { pid: start.pid } : {}),
      command: start.command,
      ...(start.error ? { error: start.error } : {}),
      killed: stop.workerPids,
      ...(stop.pid ? { runnerKilled: stop.pid } : {}),
    };
  }
  // action === 'start'
  const start = await startDrainer({ jobs });
  return {
    ...base,
    started: start.started,
    ...(start.pid ? { pid: start.pid } : {}),
    command: start.command,
    ...(start.error ? { error: start.error } : {}),
  };
}

/** Poll until the drainer PID lock is free (or `timeoutMs` elapses). */
async function waitForLockRelease(lockPath: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await loadRunner(lockPath)).running) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface StopResult {
  stopped: boolean;
  /** The drainer pid we signaled, when there was one. */
  pid?: number;
  /** Worker pids we signaled. */
  workerPids: number[];
  reason?: string;
}

/**
 * Stop an in-flight drain: signal the drainer (from the lockfile) and each live
 * worker (from the per-worker PID files). Targeted by pid — never a blanket
 * `pkill` — so an unrelated `claude` session is never touched. No-op (stopped:
 * false) when nothing is running.
 */
export async function stopDrainer(): Promise<StopResult> {
  const p = await watchdogPaths();
  const runner = await loadRunner(p.lock);
  const workers = await listWorkers(p.runsDir, Date.now());
  const liveWorkers = workers.filter((w) => w.alive);

  if (!runner.running && liveWorkers.length === 0) {
    return { stopped: false, workerPids: [], reason: 'no drainer or workers running' };
  }
  const workerPids: number[] = [];
  for (const w of liveWorkers) if (signal(w.pid)) workerPids.push(w.pid);
  if (runner.running && runner.pid) signal(runner.pid);
  return { stopped: true, ...(runner.pid ? { pid: runner.pid } : {}), workerPids };
}

// ── control: restart the drainer (graceful = finish-then-relaunch; force = kill) ──

/** A readable description of the relaunch the graceful supervisor will perform. */
function restartCommandLabel(p: WatchdogPaths, jobs: number): string {
  return `wait for ${p.lock} to free, then ${p.runner} -j ${jobs}`;
}

/**
 * Restart the drainer so a needs-restart setting (jobs/model/thinking/…) takes
 * effect on a fresh `claude -p` launch:
 *
 *   - `graceful` (default): write the `runs/.drain-stop` sentinel — each worker
 *     checks it BETWEEN tasks and exits after finishing its in-flight work (no
 *     task is interrupted) — then spawn a DETACHED supervisor that waits for the
 *     drainer to exit and relaunches a fresh one at the saved JOBS. Returns
 *     immediately; the relaunch happens whenever the current task finishes.
 *   - `force`: kill the running drainer + its workers NOW (SIGKILL the known pids,
 *     plus the drainer's process GROUP from `active-run.json` when it's safely
 *     distinct from the server's own group — sweeping the `claude -p` children
 *     too), then relaunch synchronously.
 *
 * When nothing is running, both modes simply start a drainer at the saved JOBS.
 * `RUBATO_WATCHDOG_NO_SPAWN=1` (tests) suppresses the actual relaunch/supervisor
 * spawn + force kills, so the durable side-effect (the `.drain-stop` write) and
 * the decision can be asserted without launching a real worker fleet.
 */
export async function restartDrainer(mode: 'graceful' | 'force' = 'graceful'): Promise<RestartResult> {
  const p = await watchdogPaths();
  const config = await loadConfig(p.config);
  const jobs = Math.max(1, Math.floor(config.jobs));
  const runner = await loadRunner(p.lock);
  const noSpawn = process.env.RUBATO_WATCHDOG_NO_SPAWN === '1';

  // Nothing running → a "restart" is just a start. Clear any stale stop sentinel
  // first so the fresh drainer isn't immediately halted by it.
  if (!runner.running) {
    await removeIfPresent(p.stopFile);
    if (noSpawn) {
      return {
        mode,
        ok: true,
        stopRequested: false,
        willRestart: true,
        command: `${p.runner} -j ${jobs}`,
        message: 'no drainer running — would start one',
      };
    }
    const start = await startDrainer({ jobs });
    return {
      mode,
      ok: start.started,
      stopRequested: false,
      willRestart: start.started,
      ...(start.pid ? { startedPid: start.pid } : {}),
      command: start.command,
      ...(start.error ? { error: start.error } : {}),
      message: 'no drainer was running — started a fresh one',
    };
  }

  if (mode === 'force') {
    const liveWorkers = (await listWorkers(p.runsDir, Date.now())).filter((w) => w.alive);
    const killed: number[] = [];
    for (const w of liveWorkers) if (signal(w.pid, 'SIGKILL')) killed.push(w.pid);
    if (runner.pid) signal(runner.pid, 'SIGKILL');
    // Sweep the drainer's whole process group (its `claude -p` grandchildren) only
    // when the group is known AND safely distinct from OUR own group — never our group.
    const activeRun = await loadActiveRun(p.activeRun);
    const self = selfPgid();
    let pgidKilled: number | undefined;
    if (!noSpawn && activeRun?.pgid && activeRun.pgid > 1 && self !== null && activeRun.pgid !== self) {
      if (killGroup(activeRun.pgid, 'SIGKILL')) pgidKilled = activeRun.pgid;
    }
    await removeIfPresent(p.stopFile); // a pending graceful stop is moot now
    await waitForLockRelease(p.lock);
    const base: RestartResult = {
      mode,
      ok: true,
      stopRequested: true,
      willRestart: true,
      ...(runner.pid ? { pid: runner.pid } : {}),
      ...(pgidKilled ? { pgid: pgidKilled } : {}),
      killed,
    };
    if (noSpawn) {
      return { ...base, command: `${p.runner} -j ${jobs}`, message: 'force-killed — would relaunch' };
    }
    const start = await startDrainer({ jobs });
    return {
      ...base,
      ok: start.started,
      willRestart: start.started,
      ...(start.pid ? { startedPid: start.pid } : {}),
      command: start.command,
      ...(start.error ? { error: start.error } : {}),
    };
  }

  // mode === 'graceful' (default): write the sentinel so workers stop claiming
  // new tasks after their in-flight one; a detached supervisor waits for the exit
  // and relaunches a fresh drainer with the saved config.
  await writeFile(p.stopFile, `${new Date().toISOString()} graceful restart requested by watchdog UI\n`, 'utf8');
  if (noSpawn || !(await fileExists(p.runner))) {
    return {
      mode,
      ok: true,
      stopRequested: true,
      willRestart: false,
      command: restartCommandLabel(p, jobs),
      message: noSpawn
        ? 'graceful stop requested (supervisor spawn suppressed for tests)'
        : 'graceful stop requested — relaunch supervisor not started (runner missing)',
    };
  }
  const supervisor = spawnRestartSupervisor(p, jobs);
  return {
    mode,
    ok: supervisor.ok,
    stopRequested: true,
    willRestart: supervisor.ok,
    ...(supervisor.pid ? { supervisorPid: supervisor.pid } : {}),
    command: supervisor.command,
    ...(supervisor.error ? { error: supervisor.error } : {}),
    message: 'graceful stop requested — the drainer finishes its current task, then a fresh drainer starts',
  };
}

/** Remove a file if present (best-effort; a missing file is fine). */
async function removeIfPresent(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** Single-quote a string for safe inclusion in a `bash -c` script. */
function shArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface SupervisorSpawn {
  ok: boolean;
  pid?: number;
  command: string;
  error?: string;
}

/**
 * Spawn a DETACHED bash supervisor that polls the drainer lock until it frees
 * (the graceful stop let the in-flight task finish), clears the `.drain-stop`
 * sentinel, and execs a fresh drainer at `jobs`. Detached (POSIX `setsid()`) +
 * unref'd so it outlives the request AND starts its own session/process group —
 * the runner it `exec`s inherits that group, so the relaunched drainer's pgid is
 * distinct from the server's (matching {@link startDrainer}), keeping a later
 * `force` restart able to group-kill it. Bounded to ~2h of 2s polls so it never
 * leaks forever.
 */
function spawnRestartSupervisor(p: WatchdogPaths, jobs: number): SupervisorSpawn {
  const script =
    `for i in $(seq 1 3600); do ` +
    `pid="$(cat ${shArg(p.lock)} 2>/dev/null)"; ` +
    `if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then break; fi; ` +
    `sleep 2; done; ` +
    `rm -f ${shArg(p.stopFile)}; ` +
    `exec ${shArg(p.runner)} -j ${jobs}`;
  const command = restartCommandLabel(p, jobs);
  try {
    const proc = Bun.spawn(['bash', '-c', script], {
      cwd: p.orchestrationDir,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true,
    });
    proc.unref();
    return { ok: true, pid: proc.pid, command };
  } catch (e) {
    return { ok: false, command, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The server's own process group id (so a force group-kill never targets us). Cached. */
let cachedSelfPgid: number | null | undefined;
function selfPgid(): number | null {
  if (cachedSelfPgid !== undefined) return cachedSelfPgid;
  try {
    const res = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(process.pid)]);
    const out = res.stdout ? res.stdout.toString().trim() : '';
    const n = Number.parseInt(out, 10);
    cachedSelfPgid = Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    cachedSelfPgid = null;
  }
  return cachedSelfPgid;
}

/** Signal a whole process group (`kill -SIG -pgid`); true if delivered. */
function killGroup(pgid: number, sig: NodeJS.Signals = 'SIGTERM'): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
}

export interface StopInstanceResult {
  stopped: boolean;
  pid: number;
  error?: string;
}

/**
 * Stop ONE worker by pid — but only if that pid is a known live worker (from the
 * PID files), so we never signal an arbitrary process the client names.
 */
export async function stopInstance(pid: number): Promise<StopInstanceResult> {
  const p = await watchdogPaths();
  const workers = await listWorkers(p.runsDir, Date.now());
  const match = workers.find((w) => w.pid === pid && w.alive);
  if (!match) return { stopped: false, pid, error: 'not a known live worker pid' };
  return { stopped: signal(pid), pid };
}

/** Signal a pid (SIGTERM by default); true if the signal was delivered (process existed). */
function signal(pid: number, sig: NodeJS.Signals = 'SIGTERM'): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

// ── logs: tail an allowlisted log file ────────────────────────────────────────

/** Map a log key to a safe absolute path (fixed watchdog logs OR a runs-dir file). */
async function resolveLogPath(p: WatchdogPaths, key: string): Promise<string | null> {
  const fixed: Record<string, string> = {
    'watchdog-log': p.watchdogLog,
    'watchdog-status': p.status,
    'watchdog-out': p.watchdogOut,
    'watchdog-err': p.watchdogErr,
  };
  if (fixed[key]) return fixed[key];
  // Otherwise treat the key as a bare runs-dir filename (no traversal allowed).
  if (!SAFE_NAME_RE.test(key) || basename(key) !== key) return null;
  const candidate = join(p.runsDir, key);
  // Confirm it really lives in the runs dir (realpath both sides; tolerate absent).
  try {
    const realRuns = await realpath(p.runsDir);
    const realParent = await realpath(dirname(candidate));
    if (realParent !== realRuns) return null;
  } catch {
    /* runs dir may not exist yet — the join already pins it under runsDir */
  }
  return candidate;
}

/** Tail the last `lines` of an allowlisted log file (null for an unknown key). */
export async function tailLog(key: string, lines = DEFAULT_TAIL_LINES): Promise<LogTail | null> {
  const p = await watchdogPaths();
  const path = await resolveLogPath(p, key);
  if (!path) return null;
  const n = Math.max(1, Math.min(5000, Math.floor(lines) || DEFAULT_TAIL_LINES));
  const st = await statMaybe(path);
  const label = (await listLogs(p)).find((l) => l.key === key)?.label ?? key;
  if (!st) return { key, label, path, exists: false, size: 0, lines: [], totalLines: 0 };
  const text = (await readMaybe(path)) ?? '';
  const all = text.split('\n');
  // Drop a trailing empty line from a final newline so the count is accurate.
  if (all.length && all.at(-1) === '') all.pop();
  return {
    key,
    label,
    path,
    exists: true,
    size: st.size,
    modified: new Date(st.mtimeMs).toISOString(),
    lines: all.slice(-n),
    totalLines: all.length,
  };
}
