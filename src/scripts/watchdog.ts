#!/usr/bin/env bun

/**
 * watchdog  (installed as a shell function)
 *
 * Control + observe the unattended task-queue drainer and its launchd watchdog
 * from the terminal — the same surface as the rubato Orchestration → Watchdog
 * page, so you can drive it without opening the UI. Reads/writes the orchestration
 * control files under the agent-workspace dir (`RUBATO_NOTES_DIR` > config >
 * default `~/code/workspaces/___Agent_Workspace`).
 *
 * Usage (after rubato-setup):
 *   watchdog [status] [--json]   # the live snapshot (default)
 *   watchdog interval <seconds>  # set the launchd tick interval (+ reload)
 *   watchdog jobs <n>            # set max concurrent instances (drain.config JOBS)
 *   watchdog thinking <level>    # off | low | medium | high | max
 *   watchdog fast <on|off>       # toggle /fast faster-output mode
 *   watchdog pause | resume      # disarm / arm the watchdog auto-restart
 *   watchdog start [jobs]        # start a drain now (optional jobs override)
 *   watchdog stop                # stop the drainer + its workers
 *   watchdog logs                # list the tailable log/state files
 *   watchdog tail <key> [n]      # tail a log (n lines, default 40)
 *   watchdog files               # the relevant file locations
 *   watchdog commands            # copy-paste shell commands (observe/control/logs)
 */

import {
  getWatchdog,
  patchDrainConfig,
  setWatchdogInterval,
  startDrainer,
  stopDrainer,
  tailLog,
} from '../server/watchdog';
import { formatDuration, THINKING_LEVELS, type ThinkingLevel } from '../shared/orchestration';

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const positional = args.filter((a) => !a.startsWith('--'));
const cmd = positional[0] ?? 'status';

/** Local-time, compact ISO formatting (or `—`). */
function fmtTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Seconds until an ISO instant (negative → past). */
function secondsUntil(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : Math.round((t - Date.now()) / 1000);
}

async function printStatus(): Promise<void> {
  const snap = await getWatchdog();
  if (wantJson) {
    console.log(JSON.stringify(snap, null, 2));
    return;
  }
  const c = snap.config;
  const nextIn = secondsUntil(snap.nextRunAt);
  console.log('── Watchdog ───────────────────────────────────────────────');
  console.log(`  state        : ${snap.running ? `DRAINING (PID ${snap.runnerPid})` : 'idle'}`);
  console.log(`  watchdog     : ${c.enabled ? 'ARMED (auto-restart on)' : 'PAUSED (ENABLED=0)'}`);
  console.log(
    `  max instances: ${c.jobs}    thinking: ${c.thinkingLevel ?? 'off'}    fast: ${c.fastMode ? 'on' : 'off'}`,
  );
  console.log(
    `  tick interval: ${snap.launchd.intervalSeconds ? `${snap.launchd.intervalSeconds}s` : '—'}` +
      (snap.launchd.exists ? '' : '  (plist not found)'),
  );
  console.log(`  last check   : ${fmtTime(snap.status?.at)}${snap.status ? `  — ${snap.status.message}` : ''}`);
  console.log(
    `  next check   : ${snap.nextRunAt ? `${fmtTime(snap.nextRunAt)} (${nextIn !== undefined && nextIn <= 0 ? 'due' : `in ${formatDuration(nextIn)}`})` : '—'}`,
  );
  console.log('');
  console.log(
    `  tasks        : ${snap.counts.ready} ready · ${snap.counts.claimed} in-progress · ${snap.counts.blocked} blocked · ${snap.counts.notReady} not-ready · ${snap.counts.done} done`,
  );

  if (snap.instances.length) {
    console.log('');
    console.log(`  In progress (${snap.instances.length}):`);
    for (const i of snap.instances) {
      console.log(`    • [${formatDuration(i.elapsedSeconds)}] ${i.title}${i.repo ? `  (${i.repo})` : ''}`);
    }
  }
  if (snap.workers.length) {
    console.log('');
    console.log(`  Workers (${snap.workers.filter((w) => w.alive).length} live):`);
    for (const w of snap.workers) {
      console.log(`    • worker ${w.id || '?'}  PID ${w.pid}  ${w.alive ? 'alive' : 'dead'}  ${w.logFile ?? ''}`);
    }
  }
  if (snap.problems.length) {
    console.log('');
    console.log(`  ⚠ Problems (${snap.problems.length}):`);
    for (const p of snap.problems)
      console.log(`    • [${p.kind}] ${p.title}${p.detail ? `\n        ${p.detail}` : ''}`);
  }
  if (snap.readyTitles.length) {
    console.log('');
    console.log('  Next up:');
    snap.readyTitles.slice(0, 8).forEach((t, i) => {
      console.log(`    ${i + 1}. ${t}`);
    });
  }
  console.log('───────────────────────────────────────────────────────────');
  console.log(`  (notes dir: ${snap.notesDir})  ·  run \`watchdog commands\` for manual shell control`);
}

/** Parse a positive integer arg or exit with a usage error. */
function reqInt(val: string | undefined, what: string): number {
  const n = Number.parseInt(val ?? '', 10);
  if (!Number.isFinite(n) || n < 1) {
    console.error(`error: ${what} must be a positive integer`);
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'status':
      await printStatus();
      break;

    case 'interval': {
      const seconds = reqInt(positional[1], 'interval seconds');
      const res = await setWatchdogInterval(seconds);
      console.log(
        `watchdog interval → ${res.intervalSeconds}s` +
          (res.reloaded
            ? ' (launchd reloaded — in effect now)'
            : `  ⚠ reload skipped: ${res.reloadError ?? 'unknown'}`),
      );
      break;
    }

    case 'jobs': {
      const jobs = reqInt(positional[1], 'jobs');
      const cfg = await patchDrainConfig({ jobs });
      console.log(`max instances → ${cfg.jobs}  (applies to the next drain)`);
      break;
    }

    case 'thinking': {
      const level = positional[1] as ThinkingLevel;
      if (!THINKING_LEVELS.includes(level)) {
        console.error(`error: thinking level must be one of: ${THINKING_LEVELS.join(', ')}`);
        process.exit(2);
      }
      const cfg = await patchDrainConfig({ thinkingLevel: level });
      console.log(`thinking level → ${cfg.thinkingLevel}  (applies to the next drain)`);
      break;
    }

    case 'fast': {
      const v = (positional[1] ?? '').toLowerCase();
      if (!['on', 'off', 'true', 'false', '1', '0'].includes(v)) {
        console.error('error: usage: watchdog fast <on|off>');
        process.exit(2);
      }
      const fastMode = ['on', 'true', '1'].includes(v);
      const cfg = await patchDrainConfig({ fastMode });
      console.log(`fast mode → ${cfg.fastMode ? 'on' : 'off'}  (applies to the next drain)`);
      break;
    }

    case 'pause': {
      await patchDrainConfig({ enabled: false });
      console.log('watchdog PAUSED (ENABLED=0) — it will not auto-restart the drainer.');
      break;
    }

    case 'resume': {
      await patchDrainConfig({ enabled: true });
      console.log('watchdog ARMED (ENABLED=1) — it will auto-restart the drainer when work is queued.');
      break;
    }

    case 'start': {
      const jobs = positional[1] ? reqInt(positional[1], 'jobs') : undefined;
      const res = await startDrainer(jobs ? { jobs } : {});
      console.log(res.started ? `drainer started (PID ${res.pid}): ${res.command}` : `could not start: ${res.error}`);
      if (!res.started) process.exit(1);
      break;
    }

    case 'stop': {
      const res = await stopDrainer();
      console.log(
        res.stopped
          ? `stopped${res.pid ? ` drainer PID ${res.pid}` : ''}${res.workerPids.length ? ` + workers ${res.workerPids.join(', ')}` : ''}`
          : `nothing to stop: ${res.reason}`,
      );
      break;
    }

    case 'logs': {
      const snap = await getWatchdog();
      for (const l of snap.logs) {
        console.log(`  ${l.exists ? '●' : '○'} ${l.key.padEnd(22)} ${l.label}`);
      }
      console.log('\n  tail one with: watchdog tail <key> [lines]');
      break;
    }

    case 'tail': {
      const key = positional[1];
      if (!key) {
        console.error('error: usage: watchdog tail <key> [lines]');
        process.exit(2);
      }
      const n = positional[2] ? reqInt(positional[2], 'lines') : 40;
      const t = await tailLog(key, n);
      if (!t) {
        console.error(`error: unknown log key: ${key} (run \`watchdog logs\`)`);
        process.exit(1);
      }
      if (!t.exists) {
        console.log(`(${t.path} does not exist yet)`);
        break;
      }
      console.log(`── ${t.label} — last ${t.lines.length}/${t.totalLines} line(s) ──`);
      console.log(t.lines.join('\n'));
      break;
    }

    case 'files': {
      const snap = await getWatchdog();
      for (const f of snap.files) {
        console.log(`  ${f.exists ? '●' : '○'} [${f.category}] ${f.label}\n      ${f.path}`);
      }
      break;
    }

    case 'commands': {
      const snap = await getWatchdog();
      for (const group of ['observe', 'logs', 'control'] as const) {
        const cmds = snap.commands.filter((x) => x.category === group);
        if (!cmds.length) continue;
        console.log(`\n# ${group.toUpperCase()}`);
        for (const x of cmds) console.log(`  # ${x.label}\n  ${x.command}`);
      }
      break;
    }

    default:
      console.error(`unknown subcommand: ${cmd}\nrun \`watchdog status\`, or see: watchdog --help`);
      process.exit(2);
  }
}

if (import.meta.main) await main();
