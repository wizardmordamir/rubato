import { describe, expect, test } from 'bun:test';
import { thinkingTokensFor } from '../../shared/orchestration';
import { parseTaskBoard } from './parseTasks';
import {
  applyDrainPatch,
  buildWatchdogCommands,
  type CommandPaths,
  changedDrainFields,
  computePending,
  defaultDrainConfig,
  deriveInstances,
  deriveNextRun,
  deriveProblems,
  needsRestartFieldChanged,
  nextRunIso,
  parseActiveRun,
  parseDrainConfig,
  parseLaunchdPlist,
  parseWatchdogStatus,
  parseWatchdogTick,
  repoFromText,
  serializeDrainConfig,
  setPlistInterval,
  wakeAction,
  workerIdFromWorktree,
} from './watchdog';

// A faithful copy of the real drain.config the runner writes.
const SAMPLE_CONFIG = `# saved by drain-queue.sh 2026-06-15T01:00:50Z — set ENABLED=0 (or run --disable) to stop auto-restart
ENABLED=1
JOBS=3
STARTDIR="/Users/curt/code/github/cursedalchemy"
ADD_DIR="/Users/curt/code"
`;

// A faithful copy of the real watchdog launchd plist.
const SAMPLE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.curt.agent-drain-watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/curt/code/workspaces/___Agent_Workspace/orchestration/watchdog.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;

describe('parseDrainConfig', () => {
  test('parses the real drain.config (quoted paths, comment skipped)', () => {
    const cfg = parseDrainConfig(SAMPLE_CONFIG);
    expect(cfg.enabled).toBe(true);
    expect(cfg.jobs).toBe(3);
    expect(cfg.startDir).toBe('/Users/curt/code/github/cursedalchemy');
    expect(cfg.addDir).toBe('/Users/curt/code');
    expect(cfg.thinkingLevel).toBeUndefined();
    expect(cfg.fastMode).toBeUndefined();
    expect(cfg.extra).toEqual({});
  });

  test('ENABLED=0 / disabled', () => {
    expect(parseDrainConfig('ENABLED=0\n').enabled).toBe(false);
    expect(parseDrainConfig('ENABLED=true\n').enabled).toBe(true);
    expect(parseDrainConfig('ENABLED=on\n').enabled).toBe(true);
  });

  test('the new knobs: THINKING_LEVEL + FAST_MODE', () => {
    const cfg = parseDrainConfig('THINKING_LEVEL=high\nFAST_MODE=1\n');
    expect(cfg.thinkingLevel).toBe('high');
    expect(cfg.fastMode).toBe(true);
  });

  test('RESUME_AT parses as an epoch-seconds int; a non-positive / non-numeric value is ignored', () => {
    expect(parseDrainConfig('RESUME_AT=1781560000\n').resumeAt).toBe(1781560000);
    expect(parseDrainConfig('RESUME_AT=0\n').resumeAt).toBeUndefined();
    expect(parseDrainConfig('RESUME_AT=soon\n').resumeAt).toBeUndefined();
    expect(parseDrainConfig('JOBS=1\n').resumeAt).toBeUndefined(); // absent → undefined
  });

  test('MODEL + AUTO_RESTART are first-class keys (not extras)', () => {
    const cfg = parseDrainConfig('MODEL="claude-sonnet-4-6"\nAUTO_RESTART=1\n');
    expect(cfg.model).toBe('claude-sonnet-4-6');
    expect(cfg.autoRestart).toBe(true);
    expect(cfg.extra).toEqual({});
  });

  test('AUTO_RESTART defaults off; an empty MODEL is ignored', () => {
    expect(parseDrainConfig('AUTO_RESTART=0\n').autoRestart).toBe(false);
    expect(parseDrainConfig('JOBS=1\n').autoRestart).toBe(false); // absent → default off
    expect(parseDrainConfig('AUTO_RESTART=1\n').autoRestart).toBe(true);
    expect(parseDrainConfig('MODEL=\n').model).toBeUndefined();
  });

  test('an invalid THINKING_LEVEL is ignored; invalid JOBS falls back to 1', () => {
    const cfg = parseDrainConfig('THINKING_LEVEL=turbo\nJOBS=abc\n');
    expect(cfg.thinkingLevel).toBeUndefined();
    expect(cfg.jobs).toBe(1);
  });

  test('unknown keys round-trip through extra', () => {
    const cfg = parseDrainConfig('MAX_FAILS=8\nFOO="bar baz"\n');
    expect(cfg.extra).toEqual({ MAX_FAILS: '8', FOO: 'bar baz' });
  });

  test('empty text → safe defaults', () => {
    expect(parseDrainConfig('')).toEqual(defaultDrainConfig());
  });
});

describe('serializeDrainConfig', () => {
  test('round-trips through parse (knobs preserved, extras kept)', () => {
    const cfg = parseDrainConfig(
      'ENABLED=1\nAUTO_RESTART=1\nJOBS=2\nMODEL="claude-opus-4-8"\nSTARTDIR="/a/b"\nADD_DIR="/a"\nTHINKING_LEVEL=medium\nFAST_MODE=1\nMAX_FAILS=8\n',
    );
    const round = parseDrainConfig(serializeDrainConfig(cfg));
    expect(round).toEqual(cfg);
  });

  test('always emits ENABLED + AUTO_RESTART + JOBS; MODEL only when set', () => {
    const text = serializeDrainConfig(defaultDrainConfig());
    expect(text).toContain('AUTO_RESTART=0');
    expect(text).not.toContain('MODEL=');
    expect(serializeDrainConfig(parseDrainConfig('MODEL="claude-haiku-4-5-20251001"\n'))).toContain(
      'MODEL="claude-haiku-4-5-20251001"',
    );
  });

  test('omits optional knobs when unset', () => {
    const text = serializeDrainConfig(defaultDrainConfig());
    expect(text).toContain('ENABLED=0');
    expect(text).toContain('JOBS=1');
    expect(text).not.toContain('THINKING_LEVEL');
    expect(text).not.toContain('STARTDIR');
  });

  test('output is shell-sourceable KEY=value (quoted paths)', () => {
    const cfg = parseDrainConfig('STARTDIR="/with space/dir"\n');
    expect(serializeDrainConfig(cfg)).toContain('STARTDIR="/with space/dir"');
  });

  test('RESUME_AT round-trips when set; omitted when absent', () => {
    expect(serializeDrainConfig(defaultDrainConfig())).not.toContain('RESUME_AT');
    const withResume = parseDrainConfig('ENABLED=1\nRESUME_AT=1781560000\n');
    const text = serializeDrainConfig(withResume);
    expect(text).toContain('RESUME_AT=1781560000');
    expect(parseDrainConfig(text).resumeAt).toBe(1781560000);
  });
});

describe('applyDrainPatch', () => {
  test('patches only provided fields, immutably', () => {
    const base = parseDrainConfig('ENABLED=1\nJOBS=3\n');
    const next = applyDrainPatch(base, { jobs: 5, thinkingLevel: 'low' });
    expect(next.jobs).toBe(5);
    expect(next.thinkingLevel).toBe('low');
    expect(next.enabled).toBe(true);
    expect(base.jobs).toBe(3); // original untouched
  });

  test('jobs is floored to a positive integer', () => {
    expect(applyDrainPatch(defaultDrainConfig(), { jobs: 0 }).jobs).toBe(1);
    expect(applyDrainPatch(defaultDrainConfig(), { jobs: 3.9 }).jobs).toBe(3);
  });

  test('patches model + autoRestart; an empty model clears it', () => {
    const next = applyDrainPatch(defaultDrainConfig(), { model: 'claude-sonnet-4-6', autoRestart: true });
    expect(next.model).toBe('claude-sonnet-4-6');
    expect(next.autoRestart).toBe(true);
    expect(applyDrainPatch(next, { model: '' }).model).toBeUndefined();
  });

  test('fleetTiers: sets tiers (clamped) + syncs jobs; null/empty reverts to flat', () => {
    const fleet = applyDrainPatch(defaultDrainConfig(), {
      fleetTiers: [
        { modelAlias: 'opus', slots: 2, thinkingLevel: 'high', fastMode: false },
        { modelAlias: 'sonnet', slots: 12, thinkingLevel: 'off', fastMode: true }, // slots clamped to 8
      ],
    });
    expect(fleet.fleetTiers?.map((t) => t.slots)).toEqual([2, 8]);
    expect(fleet.jobs).toBe(10); // jobs kept in sync as the sum of tier slots
    // null and [] both clear fleet mode back to flat.
    expect(applyDrainPatch(fleet, { fleetTiers: null }).fleetTiers).toBeUndefined();
    expect(applyDrainPatch(fleet, { fleetTiers: [] }).fleetTiers).toBeUndefined();
  });

  test('resumeAt: a positive epoch sets the gate; 0 / negative clears it', () => {
    const armed = applyDrainPatch(parseDrainConfig('ENABLED=1\n'), { resumeAt: 1781560000 });
    expect(armed.resumeAt).toBe(1781560000);
    expect(applyDrainPatch(armed, { resumeAt: 0 }).resumeAt).toBeUndefined();
    expect(applyDrainPatch(armed, { resumeAt: -5 }).resumeAt).toBeUndefined();
  });

  test('turning ENABLED off clears any pending resume (the disabled-watchdog invariant)', () => {
    const armed = applyDrainPatch(parseDrainConfig('ENABLED=1\n'), { resumeAt: 1781560000 });
    expect(armed.resumeAt).toBe(1781560000);
    const paused = applyDrainPatch(armed, { enabled: false });
    expect(paused.enabled).toBe(false);
    expect(paused.resumeAt).toBeUndefined();
  });
});

describe('parseActiveRun', () => {
  const REAL = JSON.stringify({
    pid: 12345,
    pgid: 12300,
    startISO: '2026-06-15T01:00:00Z',
    jobs: 2,
    model: 'claude-opus-4-8',
    thinkingLevel: 'high',
    fastMode: '',
    startDir: '/Users/curt/code/github/cursedalchemy',
    addDir: '/Users/curt/code',
  });

  test('parses what the drainer wrote (pid/pgid + effective settings)', () => {
    const run = parseActiveRun(REAL);
    expect(run?.pid).toBe(12345);
    expect(run?.pgid).toBe(12300);
    expect(run?.jobs).toBe(2);
    expect(run?.model).toBe('claude-opus-4-8');
    expect(run?.thinkingLevel).toBe('high');
    expect(run?.fastMode).toBe(''); // empty string preserved (off)
    expect(run?.startDir).toBe('/Users/curt/code/github/cursedalchemy');
  });

  test('malformed / empty / no-pid JSON → undefined', () => {
    expect(parseActiveRun('not json')).toBeUndefined();
    expect(parseActiveRun('')).toBeUndefined();
    expect(parseActiveRun('{}')).toBeUndefined();
    expect(parseActiveRun(JSON.stringify({ pid: 0 }))).toBeUndefined();
  });
});

describe('computePending (saved config vs the running drainer)', () => {
  const baseConfig = parseDrainConfig(
    'JOBS=2\nMODEL="claude-opus-4-8"\nTHINKING_LEVEL=high\nSTARTDIR="/x"\nADD_DIR="/y"\n',
  );
  const run = parseActiveRun(
    JSON.stringify({
      pid: 1,
      jobs: 2,
      model: 'claude-opus-4-8',
      thinkingLevel: 'high',
      fastMode: '',
      startDir: '/x',
      addDir: '/y',
    }),
  );

  test('nothing pending when saved matches the running drainer', () => {
    expect(computePending(baseConfig, run)).toEqual([]);
  });

  test('a changed needs-restart setting becomes a pending item (running → saved)', () => {
    const changed = applyDrainPatch(baseConfig, { jobs: 4, model: 'claude-sonnet-4-6' });
    const pending = computePending(changed, run);
    const byKey = Object.fromEntries(pending.map((p) => [p.key, p]));
    expect(byKey.jobs).toMatchObject({ running: '2', saved: '4' });
    expect(byKey.model).toMatchObject({ running: 'claude-opus-4-8', saved: 'claude-sonnet-4-6' });
    expect(byKey.thinkingLevel).toBeUndefined(); // unchanged
  });

  test('no running drainer → no pending', () => {
    expect(computePending(baseConfig, undefined)).toEqual([]);
  });

  test('a field the active-run did not record is not flagged', () => {
    const older = parseActiveRun(JSON.stringify({ pid: 1, jobs: 2 })); // no model recorded
    const changed = applyDrainPatch(baseConfig, { model: 'claude-sonnet-4-6' });
    expect(computePending(changed, older).some((p) => p.key === 'model')).toBe(false);
  });
});

describe('changedDrainFields + needsRestartFieldChanged', () => {
  const base = parseDrainConfig('ENABLED=1\nJOBS=2\nMODEL="claude-opus-4-8"\n');

  test('reports only the fields that actually changed', () => {
    expect(changedDrainFields(base, applyDrainPatch(base, { jobs: 2 }))).toEqual([]); // same value
    expect(changedDrainFields(base, applyDrainPatch(base, { jobs: 4 }))).toEqual(['jobs']);
    expect(changedDrainFields(base, applyDrainPatch(base, { enabled: false, model: 'claude-sonnet-4-6' }))).toEqual([
      'enabled',
      'model',
    ]);
  });

  test('needsRestartFieldChanged is true only for launch-fixed settings', () => {
    expect(needsRestartFieldChanged(['jobs'])).toBe(true);
    expect(needsRestartFieldChanged(['model', 'fastMode'])).toBe(true);
    expect(needsRestartFieldChanged(['enabled'])).toBe(false);
    expect(needsRestartFieldChanged(['autoRestart'])).toBe(false);
    expect(needsRestartFieldChanged([])).toBe(false);
  });
});

describe('parseWatchdogStatus', () => {
  test('a launching line: ISO + state + ready + running', () => {
    const s = parseWatchdogStatus('2026-06-15T01:00:50Z  ready=2, no runner → LAUNCHING drainer (JOBS=3)');
    expect(s?.at).toBe('2026-06-15T01:00:50Z');
    expect(s?.state).toBe('launching');
    expect(s?.ready).toBe(2);
    expect(s?.running).toBe(false);
  });

  test('a disabled line', () => {
    const s = parseWatchdogStatus('2026-06-15T01:00:50Z  DISABLED (ENABLED=0) · ready=0 · running=no → idle');
    expect(s?.state).toBe('disabled');
    expect(s?.running).toBe(false);
  });

  test('an "already running → leave it" line', () => {
    const s = parseWatchdogStatus(
      '2026-06-15T01:00:50Z  ready=2 but a drainer is already running (PID 123) → leave it',
    );
    expect(s?.state).toBe('leave');
    expect(s?.running).toBe(true);
  });

  test('a PAUSED (RESUME_AT) line', () => {
    const s = parseWatchdogStatus(
      '2026-06-15T01:00:50Z  PAUSED until 2026-06-15T05:30:00Z (RESUME_AT) · eligible=2 · running=no → idle',
    );
    expect(s?.state).toBe('paused');
    expect(s?.running).toBe(false);
  });

  test('uses the last non-blank line of a multi-line file', () => {
    const s = parseWatchdogStatus('2026-06-15T00:00:00Z  old\n\n2026-06-15T01:00:00Z  ready=1 → idle\n');
    expect(s?.at).toBe('2026-06-15T01:00:00Z');
  });

  test('empty → undefined', () => {
    expect(parseWatchdogStatus('')).toBeUndefined();
  });
});

describe('launchd plist', () => {
  test('parses label, interval, and program', () => {
    const info = parseLaunchdPlist(SAMPLE_PLIST);
    expect(info.label).toBe('com.curt.agent-drain-watchdog');
    expect(info.intervalSeconds).toBe(60);
    expect(info.program?.endsWith('watchdog.sh')).toBe(true);
  });

  test('setPlistInterval replaces the StartInterval value (and re-parses)', () => {
    const updated = setPlistInterval(SAMPLE_PLIST, 300);
    expect(parseLaunchdPlist(updated).intervalSeconds).toBe(300);
    // Untouched keys survive.
    expect(updated).toContain('com.curt.agent-drain-watchdog');
  });

  test('setPlistInterval inserts StartInterval when missing', () => {
    const noInterval = `<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>x</string>\n</dict>\n</plist>`;
    const updated = setPlistInterval(noInterval, 120);
    expect(parseLaunchdPlist(updated).intervalSeconds).toBe(120);
  });

  test('setPlistInterval floors to a positive integer', () => {
    expect(parseLaunchdPlist(setPlistInterval(SAMPLE_PLIST, 0)).intervalSeconds).toBe(1);
    expect(parseLaunchdPlist(setPlistInterval(SAMPLE_PLIST, 90.7)).intervalSeconds).toBe(90);
  });
});

describe('deriveInstances', () => {
  const NOW = Date.parse('2026-06-15T01:10:00Z');
  const BOARD = parseTaskBoard(`# TASKS
---
## [~] (worktree: rubato-watchdog · 2026-06-15T01:00:00Z) rubato watchdog dashboard
body
## [~] (worktree: ca-list · 2026-06-15T00:40:00Z) cursed alchemy list buttons
body
## [ ] cwip thing
`);

  test('one instance per claimed task, with live elapsed + inferred repo', () => {
    const insts = deriveInstances(BOARD, NOW);
    expect(insts).toHaveLength(2);
    expect(insts[0].repo).toBe('rubato');
    expect(insts[0].worktree).toBe('rubato-watchdog');
    expect(insts[0].elapsedSeconds).toBe(10 * 60);
    expect(insts[1].repo).toBe('cursedalchemy'); // inferred from "cursed alchemy"
    expect(insts[1].elapsedSeconds).toBe(30 * 60);
  });

  test('carries the task body and the worker slot for a _drain-w<n> claim', () => {
    const board = parseTaskBoard(`# TASKS
---
## [~] (worktree: _drain-w2 · 2026-06-15T01:00:00Z) rubato orchestrator links
the body text describing the task
## [~] (worktree: ca-list · 2026-06-15T00:40:00Z) cursed alchemy list
just a body
`);
    const insts = deriveInstances(board, NOW);
    expect(insts[0].worker).toBe(2);
    expect(insts[0].body).toBe('the body text describing the task');
    expect(insts[1].worker).toBeUndefined(); // a one-off descriptive slug → no worker number
  });
});

describe('workerIdFromWorktree', () => {
  test('reads the 1-based slot from a _drain-w<n> worktree', () => {
    expect(workerIdFromWorktree('_drain-w1')).toBe(1);
    expect(workerIdFromWorktree('_drain-w12')).toBe(12);
  });

  test('undefined for a one-off descriptive slug or missing worktree', () => {
    expect(workerIdFromWorktree('ca-iphone-taps')).toBeUndefined();
    expect(workerIdFromWorktree('feat/orchestrator-links')).toBeUndefined();
    expect(workerIdFromWorktree(undefined)).toBeUndefined();
  });
});

describe('deriveProblems', () => {
  const board = parseTaskBoard(`# TASKS
---
## [ ] ready one
## [!] (needs live creds) blocked one
`);

  test('blocked tasks + paused watchdog + worker errors', () => {
    const problems = deriveProblems({
      board,
      config: { ...defaultDrainConfig(), enabled: false },
      running: false,
      instances: [],
      workerErrors: [{ file: 'run-w1.err', excerpt: 'API down' }],
    });
    const kinds = problems.map((p) => p.kind).sort();
    expect(kinds).toContain('blocked');
    expect(kinds).toContain('worker-error');
    expect(kinds).toContain('watchdog-disabled');
  });

  test('ready work + enabled + no runner → no-runner problem', () => {
    const problems = deriveProblems({
      board,
      config: { ...defaultDrainConfig(), enabled: true },
      running: false,
      instances: [],
      workerErrors: [],
    });
    expect(problems.some((p) => p.kind === 'no-runner')).toBe(true);
  });

  test('a >1h claim with no live runner is flagged stale', () => {
    const problems = deriveProblems({
      board,
      config: { ...defaultDrainConfig(), enabled: true },
      running: false,
      instances: [{ title: 'stuck', startedAt: '2026-06-15T00:00:00Z', elapsedSeconds: 2 * 3600, line: 1 }],
      workerErrors: [],
    });
    expect(problems.some((p) => p.kind === 'stale-instance')).toBe(true);
  });

  // 3 ready tasks (`board` has 1 ready; build a richer board for the queued count).
  const readyBoard = parseTaskBoard(`# TASKS
---
## [ ] ready one
## [ ] ready two
## [ ] ready three
`);

  test('a short-handed running drainer with queued work → missing-workers', () => {
    const problems = deriveProblems({
      board: readyBoard,
      config: { ...defaultDrainConfig(), enabled: true, jobs: 4 },
      running: true,
      instances: [],
      workerErrors: [],
      liveWorkers: 1, // 1 of 4 live, 3 ready tasks queued → 3 > 1
    });
    const miss = problems.find((p) => p.kind === 'missing-workers');
    expect(miss).toBeDefined();
    expect(miss?.title).toContain('1/4');
  });

  test('no missing-workers warning when the queue tail fits the live workers', () => {
    const problems = deriveProblems({
      board: parseTaskBoard('# TASKS\n---\n## [ ] just one\n'),
      config: { ...defaultDrainConfig(), enabled: true, jobs: 4 },
      running: true,
      instances: [],
      workerErrors: [],
      liveWorkers: 1, // 1 ready task, 1 live worker → ready not > liveWorkers → no nag
    });
    expect(problems.some((p) => p.kind === 'missing-workers')).toBe(false);
  });

  test('no missing-workers warning when no drainer is running', () => {
    const problems = deriveProblems({
      board: readyBoard,
      config: { ...defaultDrainConfig(), enabled: true, jobs: 4 },
      running: false,
      instances: [],
      workerErrors: [],
      liveWorkers: 0,
    });
    expect(problems.some((p) => p.kind === 'missing-workers')).toBe(false);
  });
});

describe('wakeAction', () => {
  test('nothing running → start', () => {
    expect(wakeAction({ running: false, liveWorkers: 0, jobs: 3 })).toBe('start');
  });
  test('running at/above capacity → noop', () => {
    expect(wakeAction({ running: true, liveWorkers: 3, jobs: 3 })).toBe('noop');
    expect(wakeAction({ running: true, liveWorkers: 4, jobs: 3 })).toBe('noop');
  });
  test('running but short-handed → restart', () => {
    expect(wakeAction({ running: true, liveWorkers: 1, jobs: 4 })).toBe('restart');
    expect(wakeAction({ running: true, liveWorkers: 0, jobs: 2 })).toBe('restart');
  });
  test('jobs is floored to ≥ 1 so a bad config never asks for 0 workers', () => {
    expect(wakeAction({ running: true, liveWorkers: 1, jobs: 0 })).toBe('noop');
    expect(wakeAction({ running: true, liveWorkers: 0, jobs: 0.5 })).toBe('restart');
  });
});

describe('nextRunIso', () => {
  test('last check + interval', () => {
    expect(nextRunIso('2026-06-15T01:00:00Z', 60)).toBe('2026-06-15T01:01:00.000Z');
  });
  test('missing inputs → undefined', () => {
    expect(nextRunIso(undefined, 60)).toBeUndefined();
    expect(nextRunIso('2026-06-15T01:00:00Z', undefined)).toBeUndefined();
    expect(nextRunIso('not-a-date', 60)).toBeUndefined();
  });
});

describe('parseWatchdogTick', () => {
  test('maps startISO/endISO/durationMs/result onto the tick', () => {
    const tick = parseWatchdogTick(
      '{"startISO":"2026-06-15T01:00:00Z","endISO":"2026-06-15T01:00:00Z","durationMs":31,"result":"leave"}',
    );
    expect(tick?.startedAt).toBe('2026-06-15T01:00:00Z');
    expect(tick?.finishedAt).toBe('2026-06-15T01:00:00Z');
    expect(tick?.durationMs).toBe(31);
    expect(tick?.result).toBe('leave');
  });

  test('malformed / empty / fieldless JSON → undefined', () => {
    expect(parseWatchdogTick('not json')).toBeUndefined();
    expect(parseWatchdogTick('')).toBeUndefined();
    expect(parseWatchdogTick('{}')).toBeUndefined();
    expect(parseWatchdogTick('{"durationMs":-5}')).toBeUndefined(); // negative dropped + no other field
  });
});

describe('deriveNextRun', () => {
  const NOW = Date.parse('2026-06-15T01:00:00Z');
  const base = { lastTickIso: '2026-06-15T01:00:00Z', intervalSeconds: 60, nowMs: NOW };

  test('not loaded → unloaded (no nextRunAt)', () => {
    const r = deriveNextRun({ ...base, enabled: true, loaded: false });
    expect(r.mode).toBe('unloaded');
    expect(r.nextRunAt).toBeUndefined();
  });

  test('loaded but disabled → disabled (no nextRunAt → UI "—")', () => {
    const r = deriveNextRun({ ...base, enabled: false, loaded: true });
    expect(r.mode).toBe('disabled');
    expect(r.nextRunAt).toBeUndefined();
  });

  test('armed + future RESUME_AT → paused, with the resume time + the next tick', () => {
    const resumeEpoch = NOW / 1000 + 3600; // 1h out
    const r = deriveNextRun({ ...base, enabled: true, loaded: true, resumeAtEpoch: resumeEpoch });
    expect(r.mode).toBe('paused');
    expect(r.resumeAt).toBe(new Date(resumeEpoch * 1000).toISOString());
    expect(r.nextRunAt).toBe('2026-06-15T01:01:00.000Z'); // still ticks
  });

  test('armed, no resume → scheduled (next tick = last tick + interval)', () => {
    const r = deriveNextRun({ ...base, enabled: true, loaded: true });
    expect(r.mode).toBe('scheduled');
    expect(r.nextRunAt).toBe('2026-06-15T01:01:00.000Z');
    expect(r.resumeAt).toBeUndefined();
  });

  test('a past RESUME_AT is not treated as paused (it will be cleared by the watchdog)', () => {
    const r = deriveNextRun({ ...base, enabled: true, loaded: true, resumeAtEpoch: NOW / 1000 - 60 });
    expect(r.mode).toBe('scheduled');
  });

  test('loaded undefined (launchctl unqueryable) is treated as loaded', () => {
    const r = deriveNextRun({ ...base, enabled: true });
    expect(r.mode).toBe('scheduled');
    expect(r.nextRunAt).toBe('2026-06-15T01:01:00.000Z');
  });
});

describe('repoFromText + thinkingTokensFor', () => {
  test('repoFromText spots the three repos', () => {
    expect(repoFromText('cursed alchemy cluttered buttons')).toBe('cursedalchemy');
    expect(repoFromText('rubato watchdog dashboard')).toBe('rubato');
    expect(repoFromText('cwip extract helper')).toBe('cwip');
    expect(repoFromText('a generic task')).toBeUndefined();
  });

  test('thinkingTokensFor maps levels to budgets', () => {
    expect(thinkingTokensFor('off')).toBe(0);
    expect(thinkingTokensFor(undefined)).toBe(0);
    expect(thinkingTokensFor('low')).toBe(4_000);
    expect(thinkingTokensFor('max')).toBe(63_999);
  });
});

describe('buildWatchdogCommands', () => {
  const paths: CommandPaths = {
    runner: '/orch/drain-queue.sh',
    watchdogScript: '/orch/watchdog.sh',
    plist: '/LA/com.curt.agent-drain-watchdog.plist',
    label: 'com.curt.agent-drain-watchdog',
    queue: '/agent/TASKS.md',
    runsDir: '/orch/runs',
    watchdogLog: '/orch/watchdog.log',
    watchdogStatus: '/orch/watchdog.status',
    lock: '/orch/.drain.lock',
  };

  test('builds observe/control/logs commands with real paths', () => {
    const cmds = buildWatchdogCommands(paths);
    expect(cmds.some((c) => c.category === 'observe')).toBe(true);
    expect(cmds.some((c) => c.category === 'control')).toBe(true);
    expect(cmds.some((c) => c.category === 'logs')).toBe(true);
    expect(cmds.find((c) => c.id === 'start-default')?.command).toBe('/orch/drain-queue.sh');
    expect(cmds.find((c) => c.id === 'wd-stop')?.command).toContain('/LA/com.curt.agent-drain-watchdog.plist');
    // Every command is non-empty + uniquely id'd.
    expect(new Set(cmds.map((c) => c.id)).size).toBe(cmds.length);
  });
});
