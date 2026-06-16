import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDrainConfig, parseLaunchdPlist } from '../lib/orchestration';
import { handleOrchestrationApi } from './orchestrationRoutes';
import {
  applyDrainConfigPatch,
  applyFleetPreset,
  controlWatchdog,
  deleteFleetPreset,
  getWatchdog,
  listFleetPresets,
  patchDrainConfig,
  restartDrainer,
  saveFleetPreset,
  setWatchdogInterval,
  startDrainer,
  stopDrainer,
  stopInstance,
  tailLog,
  watchdogPaths,
} from './watchdog';

// Isolate the notes dir + the watchdog plist to temp files so we never touch the
// user's real ~/code/workspaces orchestration files or LaunchAgents. Suppress the
// launchctl reload so a test can never register a real launchd agent.
let dir: string;
let plist: string;
const prevNotes = process.env.RUBATO_NOTES_DIR;
const prevPlist = process.env.RUBATO_WATCHDOG_PLIST;
const prevNoReload = process.env.RUBATO_WATCHDOG_NO_RELOAD;
const prevNoSpawn = process.env.RUBATO_WATCHDOG_NO_SPAWN;

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.curt.agent-drain-watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/orch/watchdog.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
</dict>
</plist>`;

const TASKS = `# TASKS
---
## [ ] rubato a ready task
## [ ] cwip another ready task
## [~] (worktree: rubato-wd · 2026-06-15T01:00:00Z) rubato watchdog dashboard
## [!] (needs creds) rubato blocked thing
`;

const CONFIG = `# saved by drain-queue.sh
ENABLED=1
JOBS=3
STARTDIR="/Users/curt/code/github/cursedalchemy"
ADD_DIR="/Users/curt/code"
`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rubato-wd-'));
  plist = join(dir, 'watchdog.plist');
  process.env.RUBATO_NOTES_DIR = dir;
  process.env.RUBATO_WATCHDOG_PLIST = plist;
  process.env.RUBATO_WATCHDOG_NO_RELOAD = '1';
  // Suppress the relaunch / supervisor spawn / process-group kill so a restart
  // test never launches a real drainer or touches our own process group. (The
  // targeted SIGKILL of a known pid still runs — exercised against a spawned
  // `sleep` child, never the test process.)
  process.env.RUBATO_WATCHDOG_NO_SPAWN = '1';
  await mkdir(join(dir, 'orchestration', 'runs'), { recursive: true });
});

afterEach(async () => {
  restore('RUBATO_NOTES_DIR', prevNotes);
  restore('RUBATO_WATCHDOG_PLIST', prevPlist);
  restore('RUBATO_WATCHDOG_NO_RELOAD', prevNoReload);
  restore('RUBATO_WATCHDOG_NO_SPAWN', prevNoSpawn);
  await rm(dir, { recursive: true, force: true });
});

function restore(key: string, val: string | undefined): void {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

const orch = (...p: string[]) => join(dir, 'orchestration', ...p);

async function seedAll(): Promise<void> {
  await writeFile(join(dir, 'TASKS.md'), TASKS);
  await writeFile(orch('drain.config'), CONFIG);
  await writeFile(orch('watchdog.status'), '2026-06-15T01:00:00Z  ready=2, no runner → LAUNCHING drainer (JOBS=3)\n');
  await writeFile(plist, PLIST);
}

describe('watchdogPaths', () => {
  test('resolves every path under the (temp) notes dir', async () => {
    const p = await watchdogPaths();
    expect(p.notesDir).toBe(dir);
    expect(p.config).toBe(orch('drain.config'));
    expect(p.runner).toBe(orch('drain-queue.sh'));
    expect(p.plist).toBe(plist);
    expect(p.queue).toBe(join(dir, 'TASKS.md'));
  });
});

describe('getWatchdog', () => {
  test('assembles config + status + board + launchd into a snapshot', async () => {
    await seedAll();
    const snap = await getWatchdog();
    expect(snap.config.enabled).toBe(true);
    expect(snap.config.jobs).toBe(3);
    expect(snap.counts.ready).toBe(2);
    expect(snap.counts.claimed).toBe(1);
    expect(snap.counts.blocked).toBe(1);
    expect(snap.readyTitles).toHaveLength(2);
    expect(snap.instances).toHaveLength(1);
    expect(snap.instances[0].repo).toBe('rubato');
    expect(typeof snap.instances[0].elapsedSeconds).toBe('number');
    expect(snap.status?.state).toBe('launching');
    expect(snap.launchd.intervalSeconds).toBe(60);
    expect(snap.launchd.exists).toBe(true);
    expect(snap.nextRunAt).toBe('2026-06-15T01:01:00.000Z');
    expect(snap.running).toBe(false);
    // A blocked task + a paused-vs-ready check produce problems.
    expect(snap.problems.some((p) => p.kind === 'blocked')).toBe(true);
    expect(snap.commands.length).toBeGreaterThan(0);
    expect(snap.files.some((f) => f.label.includes('drain.config'))).toBe(true);
    expect(snap.logs.some((l) => l.key === 'watchdog-log')).toBe(true);
  });

  test('detects a live runner from the lockfile (this very process)', async () => {
    await seedAll();
    await writeFile(orch('.drain.lock'), String(process.pid));
    const snap = await getWatchdog();
    expect(snap.running).toBe(true);
    expect(snap.runnerPid).toBe(process.pid);
  });

  test('lists live workers from per-worker PID files', async () => {
    await seedAll();
    await writeFile(orch('runs', 'run-20260615-010000-w1.pid'), String(process.pid));
    await writeFile(orch('runs', 'run-20260615-010000-w1.jsonl'), '');
    await writeFile(orch('runs', 'run-20260615-010000-w2.pid'), '999999'); // not alive
    const snap = await getWatchdog();
    const w1 = snap.workers.find((w) => w.id === 1);
    const w2 = snap.workers.find((w) => w.id === 2);
    expect(w1?.alive).toBe(true);
    expect(w1?.logFile).toBe('run-20260615-010000-w1.jsonl');
    expect(w2?.alive).toBe(false);
  });

  test('counts a worker’s completed tasks from its run JSONL (result-object count)', async () => {
    await seedAll();
    await writeFile(orch('runs', 'run-20260615-020000-w1.pid'), String(process.pid));
    // Two finished tasks → two result objects (plus the drainer’s blank separators).
    const twoRuns = `${JSON.stringify({ type: 'result', subtype: 'success', result: 'first' })}\n\n${JSON.stringify({ type: 'result', subtype: 'success', result: 'second' })}\n`;
    await writeFile(orch('runs', 'run-20260615-020000-w1.jsonl'), twoRuns);
    const snap = await getWatchdog();
    const w1 = snap.workers.find((w) => w.id === 1);
    expect(w1?.tasksCompleted).toBe(2);
  });

  test('rolls per-worker timing/error/cost from the run JSONL onto the worker', async () => {
    await seedAll();
    await writeFile(orch('runs', 'run-20260615-030000-w1.pid'), String(process.pid));
    // Two finished tasks: the first with a duration + cost, the last errored with a longer duration.
    const runs = `${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', duration_ms: 120_000, total_cost_usd: 0.5 })}\n\n${JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'boom', duration_ms: 240_000, total_cost_usd: 0.3 })}\n`;
    await writeFile(orch('runs', 'run-20260615-030000-w1.jsonl'), runs);
    const snap = await getWatchdog();
    const w1 = snap.workers.find((w) => w.id === 1);
    expect(w1?.tasksCompleted).toBe(2);
    expect(w1?.lastDurationMs).toBe(240_000); // last task's duration
    expect(w1?.avgDurationMs).toBe(180_000); // (120k + 240k) / 2
    expect(w1?.lastTaskErrored).toBe(true);
    expect(w1?.errorCount).toBe(1);
    expect(w1?.totalCostUsd).toBeCloseTo(0.8, 6);
    expect(typeof w1?.lastFinishedAt).toBe('string'); // run-log mtime ≈ last finish
  });

  test('empty/missing files → safe defaults (no crash)', async () => {
    const snap = await getWatchdog();
    expect(snap.config.enabled).toBe(false);
    expect(snap.counts.ready).toBe(0);
    expect(snap.launchd.exists).toBe(false);
    expect(snap.running).toBe(false);
  });

  test('surfaces worker-error files as problems', async () => {
    await seedAll();
    await writeFile(orch('runs', 'run-w1.err'), 'API down — backing off 60s');
    const snap = await getWatchdog();
    expect(snap.problems.some((p) => p.kind === 'worker-error')).toBe(true);
  });

  test('surfaces the last tick (start/end/duration/result) from watchdog.tick.json', async () => {
    await seedAll();
    await writeFile(
      orch('watchdog.tick.json'),
      '{"startISO":"2026-06-15T01:02:00Z","endISO":"2026-06-15T01:02:00Z","durationMs":42,"result":"idle"}\n',
    );
    const snap = await getWatchdog();
    expect(snap.lastRun?.startedAt).toBe('2026-06-15T01:02:00Z');
    expect(snap.lastRun?.durationMs).toBe(42);
    expect(snap.lastRun?.result).toBe('idle');
  });

  test('a future RESUME_AT on an armed watchdog surfaces resumeAt + still computes nextRunAt', async () => {
    const resumeEpoch = Math.floor(Date.now() / 1000) + 3600; // 1h out
    await writeFile(join(dir, 'TASKS.md'), TASKS);
    await writeFile(orch('drain.config'), `ENABLED=1\nJOBS=1\nRESUME_AT=${resumeEpoch}\n`);
    await writeFile(orch('watchdog.status'), '2026-06-15T01:00:00Z  no eligible tasks → idle\n');
    await writeFile(plist, PLIST);
    const snap = await getWatchdog();
    expect(snap.config.resumeAt).toBe(resumeEpoch);
    expect(snap.resumeAt).toBe(new Date(resumeEpoch * 1000).toISOString());
    expect(snap.nextRunAt).toBeDefined(); // armed + (test) loaded-unknown → still ticks
  });

  test('a disabled watchdog has no nextRunAt (UI shows "—")', async () => {
    await writeFile(orch('drain.config'), 'ENABLED=0\nJOBS=1\n');
    await writeFile(orch('watchdog.status'), '2026-06-15T01:00:00Z  DISABLED → idle\n');
    await writeFile(plist, PLIST);
    const snap = await getWatchdog();
    expect(snap.nextRunAt).toBeUndefined();
    expect(snap.resumeAt).toBeUndefined();
  });
});

describe('controlWatchdog (launchd agent lifecycle)', () => {
  test('start/stop/restart are suppressed no-ops under RUBATO_WATCHDOG_NO_RELOAD', async () => {
    await writeFile(plist, PLIST);
    for (const action of ['start', 'stop', 'restart'] as const) {
      const res = await controlWatchdog(action);
      expect(res.action).toBe(action);
      expect(res.ok).toBe(true);
      expect(res.message).toContain('suppressed');
      expect(res.loaded).toBeUndefined(); // launchctl not queried in tests
    }
  });

  test('throws when the plist is missing (nothing to load)', async () => {
    await expect(controlWatchdog('start')).rejects.toThrow(/plist not found/);
  });
});

describe('patchDrainConfig', () => {
  test('writes drain.config (atomic) and round-trips', async () => {
    await writeFile(orch('drain.config'), CONFIG);
    const next = await patchDrainConfig({ jobs: 5, thinkingLevel: 'high', fastMode: true, enabled: false });
    expect(next.jobs).toBe(5);
    expect(next.thinkingLevel).toBe('high');
    expect(next.fastMode).toBe(true);
    expect(next.enabled).toBe(false);
    // Persisted + parseable by the runner's `. "$CONFIG"`.
    const onDisk = parseDrainConfig(await readFile(orch('drain.config'), 'utf8'));
    expect(onDisk).toEqual(next);
    // Unknown keys (STARTDIR/ADD_DIR) are preserved.
    expect(onDisk.startDir).toBe('/Users/curt/code/github/cursedalchemy');
  });

  test('creates drain.config when absent', async () => {
    const next = await patchDrainConfig({ jobs: 2 });
    expect(next.jobs).toBe(2);
    expect(await readFile(orch('drain.config'), 'utf8')).toContain('JOBS=2');
  });
});

const exists = (...p: string[]) => Bun.file(orch(...p)).exists();

describe('getWatchdog — active-run + pending diff', () => {
  test('includes activeRun + a pending diff when the saved config diverges from the running drainer', async () => {
    await seedAll(); // CONFIG: JOBS=3
    await writeFile(orch('.drain.lock'), String(process.pid)); // a live runner (this process)
    await writeFile(
      orch('runs', 'active-run.json'),
      JSON.stringify({
        pid: process.pid,
        pgid: process.pid,
        jobs: 2,
        model: 'claude-opus-4-8',
        thinkingLevel: '',
        fastMode: '',
        startDir: '/Users/curt/code/github/cursedalchemy',
        addDir: '/Users/curt/code',
      }),
    );
    const snap = await getWatchdog();
    expect(snap.running).toBe(true);
    expect(snap.activeRun?.jobs).toBe(2);
    // saved JOBS=3 vs running jobs=2 → a pending "restart to apply" item.
    expect(snap.pending.some((p) => p.key === 'jobs' && p.running === '2' && p.saved === '3')).toBe(true);
  });

  test('no pending (and no activeRun) when nothing runs, even if a stale active-run.json lingers', async () => {
    await seedAll();
    await writeFile(orch('runs', 'active-run.json'), JSON.stringify({ pid: 999999, jobs: 1 }));
    const snap = await getWatchdog();
    expect(snap.running).toBe(false);
    expect(snap.activeRun).toBeUndefined();
    expect(snap.pending).toEqual([]);
  });
});

describe('applyDrainConfigPatch — auto-restart', () => {
  // A live runner = this process's pid in the lockfile (graceful never kills it).
  async function seedRunning(extra = ''): Promise<void> {
    await writeFile(orch('drain.config'), `${CONFIG}AUTO_RESTART=1\n${extra}`);
    await writeFile(orch('.drain.lock'), String(process.pid));
    await writeFile(
      orch('runs', 'active-run.json'),
      JSON.stringify({ pid: process.pid, jobs: 3, model: 'claude-opus-4-8' }),
    );
  }

  test('AUTO_RESTART on + a needs-restart change + running → graceful restart fires (writes .drain-stop)', async () => {
    await seedRunning();
    const res = await applyDrainConfigPatch({ jobs: 5 });
    expect(res.changed).toContain('jobs');
    expect(res.autoRestart?.mode).toBe('graceful');
    expect(res.autoRestart?.stopRequested).toBe(true);
    expect(await exists('runs', '.drain-stop')).toBe(true);
  });

  test('AUTO_RESTART on but only a LIVE key (enabled) changed → no restart', async () => {
    await seedRunning();
    const res = await applyDrainConfigPatch({ enabled: false });
    expect(res.autoRestart).toBeUndefined();
    expect(await exists('runs', '.drain-stop')).toBe(false);
  });

  test('AUTO_RESTART off → a needs-restart change does NOT restart', async () => {
    await writeFile(orch('drain.config'), CONFIG); // AUTO_RESTART absent (off)
    await writeFile(orch('.drain.lock'), String(process.pid));
    const res = await applyDrainConfigPatch({ jobs: 6 });
    expect(res.autoRestart).toBeUndefined();
  });

  test('AUTO_RESTART on + needs-restart change but NOT running → no restart', async () => {
    await writeFile(orch('drain.config'), `${CONFIG}AUTO_RESTART=1\n`); // no lockfile → not running
    const res = await applyDrainConfigPatch({ jobs: 7 });
    expect(res.autoRestart).toBeUndefined();
  });
});

describe('restartDrainer', () => {
  test('not running → "would start" (spawn suppressed), no stop requested', async () => {
    await writeFile(orch('drain.config'), CONFIG);
    const res = await restartDrainer('graceful');
    expect(res.stopRequested).toBe(false);
    expect(res.willRestart).toBe(true);
    expect(res.command).toContain('drain-queue.sh');
  });

  test('graceful + running → writes the .drain-stop sentinel', async () => {
    await writeFile(orch('drain.config'), CONFIG);
    await writeFile(orch('.drain.lock'), String(process.pid));
    const res = await restartDrainer('graceful');
    expect(res.mode).toBe('graceful');
    expect(res.stopRequested).toBe(true);
    expect(await exists('runs', '.drain-stop')).toBe(true);
  });

  test('force + running → SIGKILLs the known pids (a spawned sleep, never the test), launches no fleet', async () => {
    await writeFile(orch('drain.config'), CONFIG);
    // A real, harmless victim (NOT the test process) so we can prove the kill.
    const victim = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    const vpid = victim.pid;
    try {
      await writeFile(orch('.drain.lock'), String(vpid));
      await writeFile(orch('runs', 'run-x-w1.pid'), String(vpid));
      await writeFile(orch('runs', 'run-x-w1.jsonl'), '');
      const res = await restartDrainer('force');
      expect(res.stopRequested).toBe(true);
      expect(res.killed).toContain(vpid);
      // The victim is dead (poll briefly for the SIGKILL to land).
      let alive = true;
      for (let i = 0; i < 60 && alive; i++) {
        try {
          process.kill(vpid, 0);
          await new Promise((r) => setTimeout(r, 25));
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      try {
        process.kill(vpid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
  });
});

describe('setWatchdogInterval', () => {
  test('rewrites StartInterval in the plist (reload suppressed in tests)', async () => {
    await writeFile(plist, PLIST);
    const res = await setWatchdogInterval(300, { reload: false });
    expect(res.intervalSeconds).toBe(300);
    expect(res.reloaded).toBe(false);
    expect(parseLaunchdPlist(await readFile(plist, 'utf8')).intervalSeconds).toBe(300);
  });

  test('throws when the plist is missing', async () => {
    await expect(setWatchdogInterval(120, { reload: false })).rejects.toThrow(/plist not found/);
  });
});

describe('start / stop / instance — safe no-ops without a live runner', () => {
  test('startDrainer reports the missing runner script', async () => {
    const res = await startDrainer();
    expect(res.started).toBe(false);
    expect(res.error).toContain('runner not found');
    expect(res.command).toContain('drain-queue.sh');
  });

  test('startDrainer launches the runner in its OWN process group (detached) — distinct from the server', async () => {
    // A fake runner that records the process group it lands in, mimicking how the
    // real drain-queue.sh stamps its pgid into active-run.json. Without `detached`
    // the child would inherit THIS process's group (childPgid === selfPgid); with
    // `detached` (setsid) it becomes its own session/group leader, so its pgid
    // equals its own pid — the distinctness that lets a `force` restart group-kill it.
    const pgidFile = orch('child-pgid.txt');
    await writeFile(
      orch('drain-queue.sh'),
      `#!/bin/bash\nps -o pgid= -p $$ | tr -d ' ' > ${JSON.stringify(pgidFile)}\n`,
    );
    await chmod(orch('drain-queue.sh'), 0o755);

    const res = await startDrainer();
    expect(res.started).toBe(true);
    const startedPid = res.pid ?? 0;
    expect(startedPid).toBeGreaterThan(0);

    // Wait for the short-lived runner to record its pgid.
    let recorded = '';
    for (let i = 0; i < 80 && !recorded; i++) {
      recorded = (await readFile(pgidFile, 'utf8').catch(() => '')).trim();
      if (!recorded) await new Promise((r) => setTimeout(r, 25));
    }
    const childPgid = Number.parseInt(recorded, 10);
    expect(Number.isFinite(childPgid)).toBe(true);

    // It became its own group leader → pgid === its own (started) pid …
    expect(childPgid).toBe(startedPid);
    // … and that group is NOT the server's own group.
    const selfPgid = Number.parseInt(
      Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(process.pid)])
        .stdout.toString()
        .trim(),
      10,
    );
    expect(childPgid).not.toBe(selfPgid);
  });

  test('stopDrainer is a no-op when nothing runs', async () => {
    const res = await stopDrainer();
    expect(res.stopped).toBe(false);
    expect(res.workerPids).toEqual([]);
  });

  test('stopInstance refuses an unknown pid', async () => {
    const res = await stopInstance(424242);
    expect(res.stopped).toBe(false);
    expect(res.error).toContain('not a known live worker');
  });
});

describe('tailLog', () => {
  test('tails the last N lines of a fixed watchdog log', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    await writeFile(orch('watchdog.log'), `${lines}\n`);
    const tail = await tailLog('watchdog-log', 3);
    expect(tail?.exists).toBe(true);
    expect(tail?.totalLines).toBe(10);
    expect(tail?.lines).toEqual(['line 8', 'line 9', 'line 10']);
  });

  test('tails a runs-dir file by its bare filename', async () => {
    await writeFile(orch('runs', 'run-x-w1.jsonl'), 'a\nb\n');
    const tail = await tailLog('run-x-w1.jsonl');
    expect(tail?.exists).toBe(true);
    expect(tail?.lines).toEqual(['a', 'b']);
  });

  test('rejects traversal / unknown keys', async () => {
    expect(await tailLog('../../etc/passwd')).toBeNull();
    expect(await tailLog('../drain.config')).toBeNull();
  });

  test('a fixed key for an absent file reports not-exists', async () => {
    const tail = await tailLog('watchdog-out');
    expect(tail?.exists).toBe(false);
    expect(tail?.lines).toEqual([]);
  });
});

describe('route handler (handleOrchestrationApi)', () => {
  const url = (p: string) => `http://localhost${p}`;

  test('GET /api/orchestration/watchdog', async () => {
    await seedAll();
    const res = await handleOrchestrationApi(
      '/api/orchestration/watchdog',
      new Request(url('/api/orchestration/watchdog')),
    );
    expect(res.status).toBe(200);
    const snap = (await res.json()) as { config: { jobs: number }; counts: { ready: number } };
    expect(snap.config.jobs).toBe(3);
    expect(snap.counts.ready).toBe(2);
  });

  test('POST /api/orchestration/watchdog/config patches the config', async () => {
    await writeFile(orch('drain.config'), CONFIG);
    const res = await handleOrchestrationApi(
      '/api/orchestration/watchdog/config',
      new Request(url('/api/orchestration/watchdog/config'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobs: 4, fastMode: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { jobs: number; fastMode: boolean }; changed: string[] };
    expect(body.config.jobs).toBe(4);
    expect(body.config.fastMode).toBe(true);
    expect(body.changed).toEqual(expect.arrayContaining(['jobs', 'fastMode']));
  });

  test('POST config accepts a valid model + rejects an unknown one (400)', async () => {
    await writeFile(orch('drain.config'), CONFIG);
    const ok = await handleOrchestrationApi(
      '/api/orchestration/watchdog/config',
      new Request(url('/api/orchestration/watchdog/config'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { config: { model: string } }).config.model).toBe('claude-sonnet-4-6');

    const bad = await handleOrchestrationApi(
      '/api/orchestration/watchdog/config',
      new Request(url('/api/orchestration/watchdog/config'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4' }),
      }),
    );
    expect(bad.status).toBe(400);
  });

  test('POST config rejects a bad patch (400)', async () => {
    const res = await handleOrchestrationApi(
      '/api/orchestration/watchdog/config',
      new Request(url('/api/orchestration/watchdog/config'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobs: -1 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('POST /api/orchestration/watchdog/restart returns a RestartResult', async () => {
    // No drainer running → a restart is just "would start" (spawn suppressed).
    const res = await handleOrchestrationApi(
      '/api/orchestration/watchdog/restart',
      new Request(url('/api/orchestration/watchdog/restart'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'graceful' }),
      }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { mode: string; ok: boolean };
    expect(out.mode).toBe('graceful');
    expect(out.ok).toBe(true);
  });

  test('POST /api/orchestration/watchdog/agent controls the launchd agent (suppressed in tests)', async () => {
    await writeFile(plist, PLIST);
    const res = await handleOrchestrationApi(
      '/api/orchestration/watchdog/agent',
      new Request(url('/api/orchestration/watchdog/agent'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restart' }),
      }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { action: string; ok: boolean };
    expect(out.action).toBe('restart');
    expect(out.ok).toBe(true);
  });

  test('POST /api/orchestration/watchdog/agent rejects an unknown action (400)', async () => {
    const res = await handleOrchestrationApi(
      '/api/orchestration/watchdog/agent',
      new Request(url('/api/orchestration/watchdog/agent'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'explode' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('POST /api/orchestration/watchdog/config accepts a resumeAt (and arms the watchdog)', async () => {
    await writeFile(orch('drain.config'), CONFIG);
    const resumeEpoch = Math.floor(Date.now() / 1000) + 1800;
    const res = await handleOrchestrationApi(
      '/api/orchestration/watchdog/config',
      new Request(url('/api/orchestration/watchdog/config'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, resumeAt: resumeEpoch }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { resumeAt?: number; enabled: boolean } };
    expect(body.config.resumeAt).toBe(resumeEpoch);
    expect(body.config.enabled).toBe(true);
  });

  test('POST /api/orchestration/watchdog/interval sets the plist interval', async () => {
    await writeFile(plist, PLIST);
    const res = await handleOrchestrationApi(
      '/api/orchestration/watchdog/interval',
      new Request(url('/api/orchestration/watchdog/interval'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seconds: 120 }),
      }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { intervalSeconds: number };
    expect(out.intervalSeconds).toBe(120);
    expect(parseLaunchdPlist(await readFile(plist, 'utf8')).intervalSeconds).toBe(120);
  });

  test('POST interval rejects seconds < 1 (400)', async () => {
    const res = await handleOrchestrationApi(
      '/api/orchestration/watchdog/interval',
      new Request(url('/api/orchestration/watchdog/interval'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seconds: 0 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('GET /api/orchestration/logs/:key tails a log', async () => {
    await writeFile(orch('watchdog.log'), 'one\ntwo\n');
    const res = await handleOrchestrationApi(
      '/api/orchestration/logs/watchdog-log',
      new Request(url('/api/orchestration/logs/watchdog-log?lines=1')),
    );
    expect(res.status).toBe(200);
    const tail = (await res.json()) as { lines: string[] };
    expect(tail.lines).toEqual(['two']);
  });

  test('GET logs for an unknown key → 404', async () => {
    const res = await handleOrchestrationApi(
      '/api/orchestration/logs/..%2f..%2fetc%2fpasswd',
      new Request(url('/api/orchestration/logs/..%2f..%2fetc%2fpasswd')),
    );
    expect(res.status).toBe(404);
  });
});

describe('fleet presets', () => {
  const url = (p: string) => `http://localhost${p}`;
  const post = (p: string, body?: unknown) =>
    handleOrchestrationApi(
      p,
      new Request(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
    );
  const tiers = [
    { modelAlias: 'opus', slots: 1, thinkingLevel: 'high' as const, fastMode: false },
    { modelAlias: 'sonnet', slots: 2, thinkingLevel: 'low' as const, fastMode: false },
  ];

  test('fs: save → list → apply (writes fleet into drain.config) → delete', async () => {
    await writeFile(orch('drain.config'), CONFIG);
    expect(await listFleetPresets()).toEqual([]);

    const saved = await saveFleetPreset({ name: 'Strong', tiers, note: 'opus-heavy' });
    expect(saved.map((p) => p.id)).toEqual(['strong']);
    expect((await listFleetPresets())[0].tiers).toEqual(tiers);

    const applied = await applyFleetPreset('strong');
    expect(applied.preset.name).toBe('Strong');
    expect(applied.config.fleetTiers).toEqual(tiers);
    expect(applied.config.jobs).toBe(3); // sum of slots
    // …and it actually landed in drain.config on disk.
    expect(await readFile(orch('drain.config'), 'utf8')).toContain('FLEET_TIERS=2');

    expect(await deleteFleetPreset('strong')).toEqual([]);
  });

  test('fs: apply an unknown preset id throws', async () => {
    await writeFile(orch('drain.config'), CONFIG);
    expect(applyFleetPreset('nope')).rejects.toThrow(/unknown fleet preset/);
  });

  test('HTTP: GET (empty) → POST save → POST apply → DELETE', async () => {
    await writeFile(orch('drain.config'), CONFIG);

    const empty = await handleOrchestrationApi('/api/orchestration/fleet-presets', new Request(url('/api/orchestration/fleet-presets')));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    const saved = await post('/api/orchestration/fleet-presets', { name: 'Fast', tiers });
    expect(saved.status).toBe(200);
    expect((await saved.json()).map((p: { id: string }) => p.id)).toEqual(['fast']);

    const applied = await post('/api/orchestration/fleet-presets/fast/apply');
    expect(applied.status).toBe(200);
    expect((await applied.json()).config.fleetTiers).toHaveLength(2);

    const del = await handleOrchestrationApi(
      '/api/orchestration/fleet-presets/fast',
      new Request(url('/api/orchestration/fleet-presets/fast'), { method: 'DELETE' }),
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual([]);
  });

  test('HTTP: a bad save body → 400; applying a missing id → 404', async () => {
    await writeFile(orch('drain.config'), CONFIG);
    expect((await post('/api/orchestration/fleet-presets', { name: '', tiers })).status).toBe(400);
    expect((await post('/api/orchestration/fleet-presets', { name: 'X', tiers: [] })).status).toBe(400);
    expect((await post('/api/orchestration/fleet-presets/ghost/apply')).status).toBe(404);
  });
});
