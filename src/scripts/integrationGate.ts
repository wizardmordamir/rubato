#!/usr/bin/env bun
/**
 * Integration + promotion gate entrypoint (the launchd job `com.taskq.mainhealth`;
 * replaces the untracked `~/.taskq/main-health-watchdog.ts`). Mirrors how
 * `taskqDrain.ts` is the drainer's launchd entrypoint: launchd runs THIS file from
 * the repo, so the gate is version-controlled, reviewable, and testable.
 *
 *   bun run src/scripts/integrationGate.ts          # one real cycle
 *   bun run src/scripts/integrationGate.ts --dry     # decide + log, mutate nothing
 *   bun run src/scripts/integrationGate.ts --print-launchd   # emit the plist
 *
 * Cutover from the old watchdog (once this file is on each repo's `main`):
 *   bun run src/scripts/integrationGate.ts --print-launchd > ~/Library/LaunchAgents/com.taskq.mainhealth.plist
 *   launchctl unload ~/Library/LaunchAgents/com.taskq.mainhealth.plist && launchctl load -w …
 *
 * IMPORTS ARE DELIBERATELY MINIMAL — only `node:*`, the impure `gate.ts`, and the
 * zero-dependency `launchd.ts`/pure `promote.ts` (transitively). The gate must LOAD
 * and run even when the rest of rubato (or cwip) is mid-broken — that's exactly when
 * a health watchdog matters. The taskq board shells out to the CLI rather than
 * importing `cwip/taskq` for the same reason.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultGateRepos,
  enrichedPath,
  type GateRepo,
  type GateSummary,
  runGate,
  taskqCliBoard,
} from '../server/taskq/gate';
import { integrationGateLaunchdPlist } from '../server/taskq/launchd';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function main(): void {
  const home = process.env.HOME ?? '';
  const path = enrichedPath(home);
  const tqHome = process.env.TASKQ_HOME?.trim() || `${home}/.taskq`;

  if (process.argv.includes('--print-launchd')) {
    process.stdout.write(
      integrationGateLaunchdPlist({
        bunPath: process.execPath,
        rubatoDir: REPO_ROOT,
        intervalSeconds: 600,
        logDir: tqHome,
        path,
        home,
      }),
    );
    return;
  }

  const gh = `${home}/code/github`;
  const dry = process.argv.includes('--dry');
  // Test/verify seams (unset in production): override the repo set + skip the kick.
  const reposJson = process.env.MAINHEALTH_REPOS_JSON;
  const repos: GateRepo[] = reposJson ? (JSON.parse(reposJson) as GateRepo[]) : defaultGateRepos(gh);
  const noKick = process.env.MAINHEALTH_NO_KICK === '1';

  const env = { ...process.env, PATH: path };
  const board = taskqCliBoard({ bun: process.execPath, taskqPath: `${gh}/cwip/src/bin/taskq.ts`, env });

  const logFile = `${tqHome}/main-health.log`;
  const summary = runGate({
    repos,
    taskqHome: tqHome,
    dry,
    board,
    selfHealCwip: !reposJson,
    cwipMain: `${gh}/cwip`,
    cwipInteg: `${gh}/cwip-integration`,
    bun: process.execPath,
    path,
    kick: () => {
      if (noKick) return;
      spawnSync('bash', ['-c', 'launchctl kickstart -k gui/$(id -u)/com.taskq.drain'], { env });
    },
    onLog: (line) => {
      try {
        appendFileSync(logFile, `${line}\n`);
      } catch {
        /* log best-effort */
      }
    },
  });

  if (!dry && summary.outcome === 'ran') writeStatus(tqHome, summary);
}

/** Persist the two status files the UI/readers consume (kept in the legacy shapes). */
function writeStatus(tqHome: string, s: GateSummary): void {
  // Full integration-health summary.
  writeFileSync(
    `${tqHome}/integration-health.json`,
    JSON.stringify(
      { checkedAt: s.checkedAt, systemGreen: s.systemGreen, promoted: s.promoted, repos: s.repos, kicked: s.kicked },
      null,
      2,
    ),
  );
  // Legacy main-health.json shape (status per repo) so existing UI/readers don't break.
  writeFileSync(
    `${tqHome}/main-health.json`,
    JSON.stringify({ checkedAt: s.checkedAt, status: s.mainStatus, kicked: s.kicked }, null, 2),
  );
}

if (import.meta.main) main();
